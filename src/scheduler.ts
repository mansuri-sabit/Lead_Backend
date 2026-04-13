import cron from 'node-cron';
import path from 'path';
import { spawn } from 'child_process';
import { Scheduler, Mission, connectDB } from './db.js';

export class SchedulerService {
    private jobs: Map<string, any> = new Map();
    private isRunning = false;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private recoveryTimer: NodeJS.Timeout | null = null;
    private stats = {
        totalJobsCreated: 0,
        totalJobsCompleted: 0,
        totalJobsFailed: 0,
        activeJobs: 0,
        lastHealthCheck: new Date(),
        memoryUsage: 0,
        uptime: Date.now()
    };

    constructor() {
        this.startHealthMonitoring();
        this.startRecoveryMonitoring();
    }

    async start() {
        if (this.isRunning) {
            console.log('📅 Scheduler service is already running');
            return;
        }

        console.log('📅 Starting Enhanced Scheduler Service...');
        this.isRunning = true;

        try {
            // Load existing schedulers from database
            const schedulers = await Scheduler.find({ isActive: true });
            
            for (const scheduler of schedulers) {
                await this.createJob(scheduler._id.toString(), scheduler.keyword, scheduler.cronExpression, scheduler.maxAdsPerRequest, scheduler.dailyLimit);
            }

            this.stats.totalJobsCreated = schedulers.length;
            this.stats.activeJobs = this.jobs.size;
            
            console.log(`📅 Enhanced Scheduler initialized with ${this.jobs.size} active jobs`);
            console.log(`📊 Scheduler Stats: Created=${this.stats.totalJobsCreated}, Active=${this.stats.activeJobs}`);
            
        } catch (error: any) {
            console.error('❌ Failed to start scheduler service:', error.message);
            this.isRunning = false;
            throw error;
        }
    }

    async createJob(_id: string, keyword: string, cronExpression: string, maxAdsPerRequest: number, dailyLimit: number) {
        if (!cron.validate(cronExpression)) {
            throw new Error(`Invalid cron expression: ${cronExpression}`);
        }

        // Remove existing job if it exists
        if (this.jobs.has(_id)) {
            const existingJob = this.jobs.get(_id);
            if (existingJob.task) {
                existingJob.task.stop();
            }
            this.jobs.delete(_id);
        }

        console.log(`📅 Creating ENHANCED job for "${keyword}" with cron: ${cronExpression}`);

        // Create enhanced cron job with error handling
        const task = cron.schedule(cronExpression, async () => {
            await this.executeScrapingJobWithRetry(_id, keyword, maxAdsPerRequest, dailyLimit);
        }, {
            timezone: 'Asia/Kolkata'
        });

        this.jobs.set(_id.toString(), {
            keyword,
            cronExpression,
            maxAdsPerRequest,
            dailyLimit,
            task,
            createdAt: new Date(),
            lastExecution: null,
            executionCount: 0,
            errorCount: 0
        });

        task.start();
        
        this.stats.totalJobsCreated++;
        this.stats.activeJobs = this.jobs.size;

        // Update scheduler with correct nextRun time
        await connectDB();
        const nextRunTime = this.getNextRunTime(cronExpression || '');
        await Scheduler.findByIdAndUpdate(_id, {
            nextRun: nextRunTime
        });

        console.log(`✅ ENHANCED Scheduled job created for "${keyword}" with cron: ${cronExpression}`);
        console.log(`⏰ Next run time updated to: ${nextRunTime.toLocaleString()}`);
        this.logSchedulerHealth();
    }

    private async executeScrapingJobWithRetry(_id: string, keyword: string, maxAdsPerRequest: number, dailyLimit: number, retryCount: number = 0) {
        const maxRetries = 3;
        const executionId = `job_${_id}_${Date.now()}`;
        
        try {
            console.log(`🚀 [${executionId}] Starting enhanced scraping job for "${keyword}" (Attempt ${retryCount + 1}/${maxRetries + 1})`);
            
            await this.executeScrapingJob(_id, keyword, maxAdsPerRequest, dailyLimit, executionId);
            
            // Update job stats on success
            const job = this.jobs.get(_id);
            if (job) {
                job.lastExecution = new Date();
                job.executionCount++;
                this.stats.totalJobsCompleted++;
            }
            
        } catch (error: any) {
            console.error(`❌ [${executionId}] Job execution failed:`, error.message);
            
            // Update job stats on error
            const job = this.jobs.get(_id);
            if (job) {
                job.errorCount++;
                this.stats.totalJobsFailed++;
            }
            
            // Retry logic
            if (retryCount < maxRetries) {
                const retryDelay = Math.pow(2, retryCount) * 5000; // Exponential backoff
                console.log(`🔄 [${executionId}] Retrying in ${retryDelay/1000}s...`);
                
                setTimeout(() => {
                    this.executeScrapingJobWithRetry(_id, keyword, maxAdsPerRequest, dailyLimit, retryCount + 1);
                }, retryDelay);
            } else {
                console.error(`💀 [${executionId}] Job failed after ${maxRetries + 1} attempts`);
                
                // Update scheduler with failed status
                await Scheduler.findByIdAndUpdate(_id, {
                    lastRun: new Date(),
                    nextRun: this.getNextRunTime('*/3 * * *'),
                    $inc: {
                        totalRuns: 1,
                        failedRuns: 1
                    }
                });
            }
        }
    }

    private async executeScrapingJob(_id: string, keyword: string, maxAdsPerRequest: number, dailyLimit: number, executionId: string) {
        const scheduler = await Scheduler.findById(_id);
        if (!scheduler || !scheduler.isActive) {
            console.log(`⚠️ [${executionId}] Scheduler not found or inactive for "${keyword}"`);
            return;
        }

        const missionData: Record<string, unknown> = {
            keyword: scheduler.keyword || '',
            status: 'running',
            startTime: new Date(),
            maxAdsPerRequest,
            dailyLimit,
            executionId: executionId
        };
        if (scheduler.userId != null) missionData.userId = scheduler.userId;
        const mission = new Mission(missionData);
        await mission.save();

        console.log(`📋 [${executionId}] Mission created: ${mission._id}`);

        const scraperArgs = ['--import', 'tsx', 'src/scraper.ts', keyword, '--max-ads', maxAdsPerRequest.toString(), '--daily-limit', dailyLimit.toString(), '--mission-id', mission._id.toString()];
        const playwrightPath = path.resolve(process.cwd(), 'playwright-browsers');
        const scraper = spawn(process.execPath, scraperArgs, {
            shell: false,
            detached: false,
            stdio: ['inherit', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PLAYWRIGHT_BROWSERS_PATH: playwrightPath,
                NODE_OPTIONS: '--max-old-space-size=4096' // Increase memory limit
            }
        });

        let scriptOutput = '';
        let isTimeout = false;
        
        // Scale timeout with target size: ~2min per 100 ads, minimum 30min, maximum 10hrs
        const scaledTimeoutMs = Math.max(30 * 60 * 1000, Math.min(10 * 60 * 60 * 1000, Math.ceil(maxAdsPerRequest / 100) * 2 * 60 * 1000));
        console.log(`⏱️ [${executionId}] Timeout set to ${Math.round(scaledTimeoutMs / 60000)}min for ${maxAdsPerRequest} ads target`);
        const timeoutTimer = setTimeout(() => {
            isTimeout = true;
            console.warn(`⏰ [${executionId}] Job timeout reached (${Math.round(scaledTimeoutMs / 60000)}min), terminating...`);
            scraper.kill('SIGTERM');
        }, scaledTimeoutMs);

        scraper.stdout.on('data', (data) => {
            const output = data.toString();
            scriptOutput += output;
            process.stdout.write(output);
            
            // Update mission with real-time progress
            const adCountMatch = output.match(/NEW AD \[(\d+)\/(\+)\]/);
            if (adCountMatch) {
                mission.adsFound = parseInt(adCountMatch[2]) || mission.adsFound;
                mission.newAds = parseInt(adCountMatch[1]) || mission.newAds;
                mission.save().catch(err => console.error('Failed to save mission progress:', err));
            }
        });

        scraper.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            process.stderr.write(errorOutput);
            scriptOutput += errorOutput;
        });

        scraper.on('close', async (code) => {
            clearTimeout(timeoutTimer);
            
            console.log(`🏁 [${executionId}] Job finished with code ${code} (Timeout: ${isTimeout})`);
            
            // Update mission based on results
            if (isTimeout) {
                mission.status = 'failed';
                mission.endTime = new Date();
                await mission.save();
            }
            
            // Parse final result with enhanced error handling
            const matches = scriptOutput.match(/\[MISSION_RESULT_JSON\] (.+)/);
            if (matches) {
                try {
                    const result = JSON.parse(matches[1] || '{}');
                    mission.adsFound = result.found || 0;
                    mission.newAds = result.saved || 0;
                    mission.duplicatesSkipped = result.duplicates || 0;
                    mission.adsProcessed = result.processed || 0;
                    
                    // Enhanced logging with execution ID
                    const isInfiniteLoop = scheduler.cronExpression && scheduler.cronExpression.includes('*/');
                    if (isInfiniteLoop) {
                        const targetText = result.target ? `/${result.target}` : '';
                        const achievedText = result.achieved ? '✅' : '⏸️';
                        console.log(`🔄 [${executionId}] Infinite Loop Update: "${keyword}" - New: ${mission.newAds}${targetText} ${achievedText}, Duplicates: ${mission.duplicatesSkipped}, Total: ${mission.adsFound}`);
                    } else {
                        const targetText = result.target ? ` (Target: ${result.target})` : '';
                        const achievedText = result.achieved ? '✅ Target achieved' : '⏸️ Target not reached';
                        console.log(`📊 [${executionId}] Scheduled job completed: "${keyword}" - New: ${mission.newAds}${targetText} ${achievedText}, Duplicates: ${mission.duplicatesSkipped}`);
                    }
                } catch (e) {
                    console.error(`❌ [${executionId}] Failed to parse mission result:`, e);
                }
            }

            mission.endTime = new Date();
            if (!isTimeout) {
                mission.status = code === 0 ? 'completed' : 'failed';
            }
            await mission.save();

            // Update scheduler stats with enhanced tracking
            await Scheduler.findByIdAndUpdate(_id, {
                lastRun: new Date(),
                nextRun: this.getNextRunTime(scheduler.cronExpression || ''),
                $inc: {
                    totalRuns: 1,
                    successfulRuns: code === 0 && !isTimeout ? 1 : 0,
                    failedRuns: (code !== 0 || isTimeout) ? 1 : 0
                }
            });

            console.log(`📊 [${executionId}] Scheduled job stats updated for "${keyword}"`);
            this.logSchedulerHealth();
        });

        scraper.on('error', (error) => {
            clearTimeout(timeoutTimer);
            console.error(`🚨 [${executionId}] Scraper process error:`, error);
            mission.status = 'failed';
            mission.endTime = new Date();
            mission.save();
        });
    }

    private startHealthMonitoring() {
        this.healthCheckTimer = setInterval(() => {
            this.performHealthCheck();
        }, 60000); // Every minute
    }

    private startRecoveryMonitoring() {
        this.recoveryTimer = setInterval(() => {
            this.performRecoveryCheck();
        }, 300000); // Every 5 minutes
    }

    private performHealthCheck() {
        try {
            const memUsage = process.memoryUsage();
            this.stats.memoryUsage = memUsage.rss;
            this.stats.lastHealthCheck = new Date();
            
            const uptime = Date.now() - this.stats.uptime;
            const uptimeMinutes = Math.floor(uptime / 60000);
            
            console.log(`💓 Scheduler Health Check:`);
            console.log(`   📊 Active Jobs: ${this.stats.activeJobs}`);
            console.log(`   ✅ Completed: ${this.stats.totalJobsCompleted}`);
            console.log(`   ❌ Failed: ${this.stats.totalJobsFailed}`);
            console.log(`   💾 Memory: ${Math.round(memUsage.rss/1024/1024)}MB`);
            console.log(`   ⏱️  Uptime: ${uptimeMinutes}min`);
            
            // Alert if memory usage is high
            if (memUsage.rss > 1024 * 1024 * 1024) { // > 1GB
                console.warn(`⚠️ High memory usage detected: ${Math.round(memUsage.rss/1024/1024)}MB`);
            }
            
        } catch (error: any) {
            console.error('❌ Health check failed:', error.message);
        }
    }

    private performRecoveryCheck() {
        try {
            console.log(`🔧 Performing recovery check...`);
            
            // Check for stuck jobs
            for (const [jobId, job] of this.jobs.entries()) {
                if (job.lastExecution) {
                    const timeSinceLastExecution = Date.now() - job.lastExecution.getTime();
                    const maxExecutionTime = 35 * 60 * 1000; // 35 minutes
                    
                    if (timeSinceLastExecution > maxExecutionTime) {
                        console.warn(`⚠️ Job ${jobId} may be stuck (last execution: ${Math.floor(timeSinceLastExecution/60000)}min ago)`);
                    }
                }
            }
            
            // Check database connection
            Scheduler.findOne().then(() => {
                console.log(`✅ Database connection healthy`);
            }).catch((error) => {
                console.error(`❌ Database connection issue:`, error.message);
            });
            
        } catch (error: any) {
            console.error('❌ Recovery check failed:', error.message);
        }
    }

    private logSchedulerHealth() {
        const successRate = this.stats.totalJobsCompleted > 0 
            ? Math.round((this.stats.totalJobsCompleted / (this.stats.totalJobsCompleted + this.stats.totalJobsFailed)) * 100)
            : 0;
            
        console.log(`📈 Scheduler Health: ${successRate}% success rate, ${this.stats.activeJobs} active jobs`);
    }

    async stop() {
        console.log('🛑 Stopping Enhanced Scheduler Service...');
        
        // Stop all jobs
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.task) {
                job.task.stop();
            }
        }
        
        // Clear timers
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
        }
        
        this.jobs.clear();
        this.isRunning = false;
        
        console.log('✅ Enhanced Scheduler Service stopped');
    }

    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            activeJobs: this.jobs.size,
            successRate: this.stats.totalJobsCompleted > 0 
                ? Math.round((this.stats.totalJobsCompleted / (this.stats.totalJobsCompleted + this.stats.totalJobsFailed)) * 100)
                : 0
        };
    }

    // API methods for server integration (userId for data isolation)
    async getSchedulers(userId: string) {
        await connectDB();
        const filter = { userId };
        return await Scheduler.find(filter).sort({ createdAt: -1 });
    }

    async addScheduler(keyword: string, cronExpression: string, maxAdsPerRequest: number, dailyLimit: number, userId: string) {
        await connectDB();
        const baseFilter = { keyword, userId };
        const existing = await Scheduler.findOne(baseFilter);
        if (existing) {
            // Update existing scheduler
            existing.cronExpression = cronExpression;
            existing.maxAdsPerRequest = maxAdsPerRequest;
            existing.dailyLimit = dailyLimit;
            existing.isActive = true;
            existing.updatedAt = new Date();
            await existing.save();

            if (existing.isActive) {
                await this.createJob(existing._id.toString(), existing.keyword, existing.cronExpression, existing.maxAdsPerRequest, existing.dailyLimit);
            }

            return existing;
        } else {
            const schedulerData: Record<string, unknown> = {
                keyword,
                cronExpression,
                maxAdsPerRequest,
                dailyLimit,
                isActive: true,
                nextRun: this.getNextRunTime(cronExpression || ''),
                userId
            };
            const scheduler = new Scheduler(schedulerData);
            await scheduler.save();

            await this.createJob(scheduler._id.toString(), scheduler.keyword, scheduler.cronExpression, scheduler.maxAdsPerRequest, scheduler.dailyLimit);
            return scheduler;
        }
    }

    async updateScheduler(id: string, updates: any, userId: string) {
        await connectDB();
        const scheduler = await Scheduler.findById(id);
        if (!scheduler) return null;
        if (scheduler.userId !== userId) return null;
        const updated = await Scheduler.findByIdAndUpdate(id, updates, { new: true });
        if (updated) {
            if (updates.isActive === false) {
                this.stopJob(id);
            } else if (updates.isActive === true) {
                await this.createJob(updated._id.toString(), updated.keyword, updated.cronExpression, updated.maxAdsPerRequest, updated.dailyLimit);
            } else if (updates.cronExpression || updates.maxAdsPerRequest || updates.dailyLimit) {
                await this.createJob(updated._id.toString(), updated.keyword, updated.cronExpression, updated.maxAdsPerRequest, updated.dailyLimit);
            }
        }
        return updated;
    }

    async deleteScheduler(id: string, userId: string) {
        await connectDB();
        const scheduler = await Scheduler.findById(id);
        if (!scheduler) return;
        if (scheduler.userId !== userId) return;
        this.stopJob(id);
        await Scheduler.findByIdAndDelete(id);
    }

    stopJob(id: string) {
        const job = this.jobs.get(id);
        if (job) {
            job.task.stop();
            this.jobs.delete(id);
            console.log(`⏹️ Stopped scheduled job: ${job.keyword}`);
        }
    }

    async getActiveJobs() {
        return Array.from(this.jobs.entries()).map(([id, job]) => ({
            id,
            keyword: job.keyword,
            cronExpression: job.cronExpression,
            maxAdsPerRequest: job.maxAdsPerRequest,
            dailyLimit: job.dailyLimit
        }));
    }

    getJobStatus() {
        return {
            totalJobs: this.jobs.size,
            isRunning: this.isRunning,
            activeJobs: Array.from(this.jobs.keys()),
            activeJobsCount: this.stats.activeJobs,
            totalJobsCreated: this.stats.totalJobsCreated,
            totalJobsCompleted: this.stats.totalJobsCompleted,
            totalJobsFailed: this.stats.totalJobsFailed,
            lastHealthCheck: this.stats.lastHealthCheck,
            memoryUsage: this.stats.memoryUsage,
            uptime: this.stats.uptime
        };
    }

    private getNextRunTime(cronExpression: string): Date {
        // Simple calculation for next run time
        const now = new Date();
        const nextRun = new Date(now);
        
        // Normalize cron expression by adding spaces if missing
        const normalizedCron = cronExpression.replace(/\*+/g, '* ').trim();
        
        // Handle common cron patterns
        if (cronExpression === '*/2 * * * *' || cronExpression === '*/2*****' || normalizedCron === '*/2 * * * *') { // Every 2 minutes
            nextRun.setMinutes(now.getMinutes() + 2);
        } else if (cronExpression === '*/3 * * * *' || cronExpression === '*/3*****' || normalizedCron === '*/3 * * * *') { // Every 3 minutes
            nextRun.setMinutes(now.getMinutes() + 3);
        } else if (cronExpression === '*/5 * * * *' || cronExpression === '*/5*****' || normalizedCron === '*/5 * * * *') { // Every 5 minutes
            nextRun.setMinutes(now.getMinutes() + 5);
        } else if (cronExpression === '*/10 * * * *' || cronExpression === '*/10*****' || normalizedCron === '*/10 * * * *') { // Every 10 minutes
            nextRun.setMinutes(now.getMinutes() + 10);
        } else if (cronExpression === '*/15 * * * *' || cronExpression === '*/15*****' || normalizedCron === '*/15 * * * *') { // Every 15 minutes
            nextRun.setMinutes(now.getMinutes() + 15);
        } else if (cronExpression === '*/30 * * * *' || cronExpression === '*/30*****' || normalizedCron === '*/30 * * * *') { // Every 30 minutes
            nextRun.setMinutes(now.getMinutes() + 30);
        } else if (cronExpression === '0 */1 * * *') { // Every 1 hour
            nextRun.setHours(now.getHours() + 1);
        } else if (cronExpression === '0 */6 * * *') { // Every 6 hours
            nextRun.setHours(now.getHours() + 6);
        } else if (cronExpression === '0 */12 * * *') { // Every 12 hours
            nextRun.setHours(now.getHours() + 12);
        } else if (cronExpression === '0 0 * * *') { // Daily at midnight
            nextRun.setDate(now.getDate() + 1);
            nextRun.setHours(0, 0, 0, 0);
        } else if (cronExpression === '0 0 * * 0') { // Weekly on Sunday
            nextRun.setDate(now.getDate() + (7 - now.getDay()));
            nextRun.setHours(0, 0, 0, 0);
        } else {
            // Default to 1 hour from now for unknown patterns
            nextRun.setHours(now.getHours() + 1);
        }
        
        return nextRun;
    }
}

const schedulerService = new SchedulerService();
export { schedulerService };
