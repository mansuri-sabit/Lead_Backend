import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import dns from 'node:dns';
import { spawn, execFile } from 'child_process';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cron from 'node-cron';
import {
    connectDB,
    Ad,
    Mission,
    Scheduler,
    registerUser,
    verifyUser,
    createFilterBotRun,
    saveFilterBotRunProgress,
    finalizeFilterBotRun,
    persistFilterBotExtraction,
    getLatestFilterBotRunWithComments,
    getFilterBotRunComments,
    listFilterBotRuns,
    deleteFilterBotRunComments,
    deleteFilterBotRun,
    getFilterBotCommentersForRows,
    updateFilterBotCommenterEnrichment,
    claimPendingFilterBotCommenters,
    getFilterBotRunStatus,
    createLeadCaptureRun,
    updateLeadCaptureAgent1,
    updateLeadCaptureAgent2,
    finalizeLeadCaptureRun,
    listLeadCaptureRuns,
    getLeadCaptureRunResults,
    getLatestLeadCaptureRun,
    deleteLeadCaptureRun,
    LeadCaptureRun,
    LeadCaptureResult
} from './src/db.js';
import { schedulerService } from './src/scheduler.js';
import GoogleAdsScraper from './src/googleAdsScraper.js';
import { requireAuth, signToken } from './src/auth.js';
import { auditWebsite } from './src/leadCaptureWebsiteAudit.js';

dotenv.config();

// ─── Environment Validation ──────────────────────────────────────────────────
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (IS_PRODUCTION) {
    const required = ['MONGODB_URI', 'JWT_SECRET', 'FRONTEND_URL'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.error(`FATAL: Missing required env vars for production: ${missing.join(', ')}`);
        process.exit(1);
    }
}

// Fix MongoDB Atlas SRV resolution on Windows
dns.setDefaultResultOrder('ipv4first');
if (process.env.USE_PUBLIC_DNS === '1') {
    const servers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',').map(s => s.trim()) : ['8.8.8.8', '1.1.1.1'];
    dns.setServers(servers);
}

const app = express();
const PORT = process.env.PORT || 5001;

// Maps for scraper management (missionId -> scraper info)
const activeFacebookScrapers = new Map();
const activeGoogleScrapers = new Map();
const activeFilterBotEnrichWorkers = new Set();

// Concurrency limit — each Chromium browser uses ~300-500MB RAM.
const MAX_CONCURRENT_SCRAPERS = Math.max(1, Math.min(20, parseInt(process.env.MAX_CONCURRENT_SCRAPERS || '3')));

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

// ─── Security Middleware ─────────────────────────────────────────────────────

// Helmet: security headers (XSS, clickjacking, MIME sniffing, HSTS)
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for API-only server
    crossOriginEmbedderPolicy: false,
}));

// Compression: gzip responses (reduces bandwidth 5-10x for JSON)
app.use(compression());

// Static screenshots — Lead Capture popup/viewport thumbnails written to disk
// instead of stored as base64 in MongoDB. Cached aggressively (immutable per row).
const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'screenshots');
try { fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}
app.use('/screenshots', express.static(SCREENSHOTS_DIR, {
    maxAge: '7d',
    immutable: true,
    fallthrough: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800, immutable'),
}));

// Request body size limits (prevents large-payload DoS)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting on auth endpoints (prevents brute force)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 20,                    // 20 attempts per window
    message: { error: 'Too many attempts. Try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting on scrape endpoints (prevents abuse)
const scrapeLimiter = rateLimit({
    windowMs: 60 * 1000,       // 1 minute
    max: 10,                    // 10 scrape requests per minute
    message: { error: 'Too many scrape requests. Slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const filterBotReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many requests. Slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/** Agent 2 runs separately from scrapeLimiter (Filter Bot extract shares 10/min with other scrapes). */
const filterBotEnrichLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Math.min(100, Math.max(10, parseInt(process.env.FILTER_BOT_ENRICH_RATE_MAX || '40', 10) || 40)),
    message: { error: 'Too many enrichment requests. Wait a minute and try again.' },
    standardHeaders: true,
    legacyHeaders: false
});

const FILTER_BOT_AUTO_ENRICH_ENABLED = process.env.FILTER_BOT_AUTO_ENRICH_ENABLED !== '0';
const FILTER_BOT_AUTO_ENRICH_BATCH = Math.min(10, Math.max(1, parseInt(process.env.FILTER_BOT_AUTO_ENRICH_BATCH || '4', 10) || 4));
const FILTER_BOT_AUTO_ENRICH_IDLE_ROUNDS = Math.min(120, Math.max(5, parseInt(process.env.FILTER_BOT_AUTO_ENRICH_IDLE_ROUNDS || '24', 10) || 24));
const FILTER_BOT_AUTO_ENRICH_WAIT_MS = Math.min(15000, Math.max(1000, parseInt(process.env.FILTER_BOT_AUTO_ENRICH_WAIT_MS || '2500', 10) || 2500));

function startFilterBotAutoEnrichmentWorker(userId, runId) {
    if (!FILTER_BOT_AUTO_ENRICH_ENABLED || !runId) return;
    const key = `${userId}:${runId}`;
    if (activeFilterBotEnrichWorkers.has(key)) return;
    activeFilterBotEnrichWorkers.add(key);

    (async () => {
        try {
            const { enrichFacebookProfilesParallel } = await import('./src/facebookProfileEnricher.js');
            let idleRounds = 0;
            while (idleRounds < FILTER_BOT_AUTO_ENRICH_IDLE_ROUNDS) {
                const batch = await claimPendingFilterBotCommenters(userId, runId, FILTER_BOT_AUTO_ENRICH_BATCH);
                if (!batch.length) {
                    const status = await getFilterBotRunStatus(userId, runId);
                    idleRounds += 1;
                    if ((status === 'completed' || status === 'failed') && idleRounds >= 3) {
                        break;
                    }
                    await new Promise((r) => setTimeout(r, FILTER_BOT_AUTO_ENRICH_WAIT_MS));
                    continue;
                }

                idleRounds = 0;
                const results = await enrichFacebookProfilesParallel(batch, Math.min(3, FILTER_BOT_AUTO_ENRICH_BATCH));
                for (const br of results) {
                    if (br?.ok && br?.data) {
                        await updateFilterBotCommenterEnrichment(userId, runId, br.rowIndex, {
                            status: 'completed',
                            phones: br.data.phones,
                            addresses: br.data.addresses,
                            socialLinks: br.data.socialLinks,
                            profileUrlUsed: br.data.profileUrlUsed,
                            aboutUrlUsed: br.data.aboutUrlUsed,
                            error: null
                        });
                    } else {
                        await updateFilterBotCommenterEnrichment(userId, runId, br.rowIndex, {
                            status: 'failed',
                            phones: [],
                            addresses: [],
                            socialLinks: [],
                            error: br?.error || 'Unknown error'
                        });
                    }
                }
            }
        } catch (err) {
            console.error(`[Agent2][auto-worker] run=${runId} failed:`, err?.message || err);
        } finally {
            activeFilterBotEnrichWorkers.delete(key);
        }
    })();
}

// Access logging with response time
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
    });
    next();
});

// CORS: strict in production, permissive in dev
// Deployed frontend origin (no trailing slash — browsers send Origin without it).
const DEPLOYED_FRONTEND_URL = 'https://lead-frontend-mejb.onrender.com';
const corsOrigins = IS_PRODUCTION
    ? [process.env.FRONTEND_URL, DEPLOYED_FRONTEND_URL].filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', process.env.FRONTEND_URL, DEPLOYED_FRONTEND_URL].filter(Boolean);

app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// HTTPS redirect in production
if (IS_PRODUCTION) {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'facebook-backend', timestamp: new Date().toISOString() });
});

app.get('/api/health', async (req, res) => {
    const dbState = mongoose.connection.readyState;
    const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
    const healthy = dbState === 1;
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'unhealthy',
        db: dbStatus,
        uptime: Math.round(process.uptime()),
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        activeScrapers: activeFacebookScrapers.size + activeGoogleScrapers.size,
        maxScrapers: MAX_CONCURRENT_SCRAPERS,
    });
});

// ─── Auth Routes (rate limited) ──────────────────────────────────────────────

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || typeof username !== 'string' || username.trim().length === 0) {
            return res.status(400).json({ error: 'Username is required' });
        }
        if (!password || typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ error: 'Password is required' });
        }
        const verifiedUsername = await verifyUser(username, password);
        if (!verifiedUsername) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        const token = signToken(verifiedUsername);
        return res.json({ token, userId: verifiedUsername });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || typeof username !== 'string' || username.trim().length < 2) {
            return res.status(400).json({ error: 'Username must be at least 2 characters' });
        }
        if (!password || typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(username.trim())) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, hyphens, and underscores' });
        }
        const user = await registerUser(username, password);
        const token = signToken(user.username);
        return res.json({ token, userId: user.username });
    } catch (err) {
        if (err.message === 'USERNAME_TAKEN') {
            return res.status(409).json({ error: 'Username is already taken' });
        }
        console.error('Registration error:', err);
        return res.status(500).json({ error: 'Registration failed' });
    }
});

// ─── MongoDB Connection ──────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_URI_STANDARD = process.env.MONGODB_URI_STANDARD;

function isSrvRefused(err) {
    return err && (err.code === 'ECONNREFUSED' || err.syscall === 'querySrv') && String(err.hostname || '').includes('mongodb');
}

async function ensureMongoConnected() {
    if (mongoose.connection.readyState === 1) return;
    if (!MONGODB_URI && !MONGODB_URI_STANDARD) {
        const msg = 'MONGODB_URI (or MONGODB_URI_STANDARD) is not set';
        if (IS_PRODUCTION) { console.error(`FATAL: ${msg}`); process.exit(1); }
        console.error(msg);
        return;
    }
    const uriToTry = MONGODB_URI || MONGODB_URI_STANDARD;
    try {
        await mongoose.connect(uriToTry, { maxPoolSize: 20 });
        console.log('API connected to MongoDB');
        console.log('Database Name:', mongoose.connection.name);
    } catch (err) {
        if (isSrvRefused(err) && MONGODB_URI_STANDARD && uriToTry === MONGODB_URI) {
            console.warn('MongoDB SRV lookup failed. Retrying with MONGODB_URI_STANDARD...');
            try {
                await mongoose.connect(MONGODB_URI_STANDARD, { maxPoolSize: 20 });
                console.log('API connected to MongoDB (standard URI)');
                return;
            } catch (err2) {
                console.error('MongoDB connection error (standard URI):', err2.message);
            }
        }
        console.error('MongoDB connection error:', err);
        if (IS_PRODUCTION) { process.exit(1); }
    }
}

// ─── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/ads', requireAuth, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 10));
        const skip = (page - 1) * limit;
        const userId = req.userId;

        const filter = { userId };
        const total = await Ad.countDocuments(filter);

        const ads = await Ad.find(filter)
            .sort({ scrape_date: -1 })
            .skip(skip)
            .limit(limit);

        res.json({ ads, total, page, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        console.error('Fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch ads' });
    }
});

app.get('/api/keywords', requireAuth, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'Database not ready', code: 'DB_NOT_READY' });
        }
        const userId = req.userId;
        if (!userId || typeof userId !== 'string') {
            return res.status(400).json({ error: 'Invalid user context' });
        }
        const keywords = await Ad.distinct('keyword', { userId });
        res.json((Array.isArray(keywords) ? keywords : []).filter(Boolean));
    } catch (err) {
        console.error('Keywords fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch keywords' });
    }
});

app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const count = await Ad.countDocuments({ userId: req.userId });
        res.json({ total: count });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ─── Scrape Routes (rate limited) ────────────────────────────────────────────

app.post('/api/scrape', requireAuth, scrapeLimiter, async (req, res) => {
    const { keyword, maxAdsPerRequest, dailyLimit } = req.body;
    const filters = req.body.filters || {};
    const userId = req.userId;

    // Input validation
    if (!keyword || typeof keyword !== 'string') return res.status(400).json({ error: 'Keyword is required' });
    if (keyword.length > 200) return res.status(400).json({ error: 'Keyword too long (max 200 chars)' });

    const maxAds = maxAdsPerRequest || 1000;
    const dailyQuota = dailyLimit || 5000;

    if (maxAds > 10000000) return res.status(400).json({ error: 'maxAdsPerRequest cannot exceed 10,000,000' });
    if (dailyQuota > 10000000) return res.status(400).json({ error: 'dailyLimit cannot exceed 10,000,000' });

    // Concurrency guard
    const totalScraperCount = activeFacebookScrapers.size + activeGoogleScrapers.size;
    if (totalScraperCount >= MAX_CONCURRENT_SCRAPERS) {
        return res.status(429).json({
            error: `Server limit reached: ${totalScraperCount}/${MAX_CONCURRENT_SCRAPERS} scrapers running. Wait for a job to finish or stop one.`,
            activeMissions: totalScraperCount
        });
    }

    // Auto-resume logic
    if (!filters.startDate && !filters.endDate) {
        try {
            const oldestAd = await Ad.findOne({ keyword, userId }).sort({ ad_start_date: 1 }).exec();
            if (oldestAd && oldestAd.ad_start_date) {
                filters.endDate = oldestAd.ad_start_date.toISOString().split('T')[0];
                console.log(`[Auto-Resume] Setting End Date to ${filters.endDate}`);
            }
        } catch (dbError) {
            console.warn('[Auto-Resume] Failed:', dbError.message);
        }
    }

    console.log(`Triggering scrape: "${keyword}" (Max: ${maxAds}, Daily: ${dailyQuota})`);

    const mission = new Mission({
        userId, keyword, status: 'running', startTime: new Date(),
        maxAdsPerRequest: maxAds, dailyLimit: dailyQuota,
        country: filters?.country || 'IN', source: 'facebook'
    });
    await mission.save();

    const scraperArgs = ['--import', 'tsx', 'src/scraper.ts', keyword,
        '--max-ads', maxAds.toString(), '--daily-limit', dailyQuota.toString(),
        '--mission-id', mission._id.toString()];

    if (filters) {
        if (filters.language) scraperArgs.push('--language', filters.language);
        if (filters.advertiser) scraperArgs.push('--advertiser', filters.advertiser);
        if (filters.platforms && filters.platforms.length > 0) scraperArgs.push('--platforms', filters.platforms.join(','));
        if (filters.mediaType) scraperArgs.push('--media-type', filters.mediaType);
        if (filters.activeStatus) scraperArgs.push('--active-status', filters.activeStatus);
        if (filters.startDate) scraperArgs.push('--start-date', filters.startDate);
        if (filters.endDate) {
            scraperArgs.push('--end-date', filters.endDate);
            if (!req.body.filters?.endDate) scraperArgs.push('--resume-date', filters.endDate);
        }
        if (filters.country) scraperArgs.push('--country', filters.country);
    }

    await Mission.findByIdAndUpdate(mission._id, { $set: { status: 'running', updatedAt: new Date() } });

    const playwrightPath = path.resolve(process.cwd(), 'playwright-browsers');
    const scraperEnv = {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: playwrightPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=4096`.trim()
    };
    const scraper = spawn(process.execPath, scraperArgs, {
        shell: false, detached: false,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: scraperEnv
    });

    activeFacebookScrapers.set(mission._id.toString(), {
        process: scraper, keyword, mission, userId
    });

    // Size-limited output buffer (keeps last 512KB instead of growing forever)
    const MAX_OUTPUT_SIZE = 512 * 1024;
    let scriptOutput = '';
    let stdoutBuffer = '';

    scraper.stdout.on('data', (data) => {
        const chunk = data.toString();
        process.stdout.write(chunk);

        // Circular buffer: keep only last MAX_OUTPUT_SIZE chars
        scriptOutput += chunk;
        if (scriptOutput.length > MAX_OUTPUT_SIZE) {
            scriptOutput = scriptOutput.slice(-MAX_OUTPUT_SIZE);
        }

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop();

        lines.forEach(async (line) => {
            const currentMission = activeFacebookScrapers.get(mission._id.toString())?.mission;
            if (!currentMission) return;

            const inc = {};
            if (line.includes('NEW AD')) { inc.newAds = 1; inc.adsFound = 1; }
            if (line.includes('DUPLICATE')) { inc.duplicatesSkipped = 1; }

            if (Object.keys(inc).length > 0) {
                try {
                    await Mission.findByIdAndUpdate(mission._id, {
                        $set: { updatedAt: new Date() },
                        $inc: inc
                    });
                } catch (err) {
                    console.error('Error updating mission metrics:', err.message);
                }
            }
        });

        checkFinalResult();
    });

    function checkFinalResult() {
        const missionInfo = activeFacebookScrapers.get(mission._id.toString());
        if (!missionInfo) return;
        const resultMatch = scriptOutput.match(/\[MISSION_RESULT_JSON\] (.+)/);
        if (resultMatch) {
            try {
                const result = JSON.parse(resultMatch[1]);
                missionInfo.mission.adsFound = Math.max(missionInfo.mission.adsFound || 0, result.saved || 0);
                missionInfo.mission.newAds = Math.max(missionInfo.mission.newAds || 0, result.saved || 0);
            } catch { /* ignore parse errors */ }
        }
    }

    scraper.stderr.on('data', (data) => {
        const output = data.toString();
        process.stderr.write(output);
        scriptOutput += output;
        if (scriptOutput.length > MAX_OUTPUT_SIZE) {
            scriptOutput = scriptOutput.slice(-MAX_OUTPUT_SIZE);
        }
    });

    scraper.on('close', async (code) => {
        const missionInfo = activeFacebookScrapers.get(mission._id.toString());
        console.log(`Scraper for "${keyword}" finished with code ${code}`);
        checkFinalResult();

        if (missionInfo && missionInfo.mission) {
            const finalStatus = code === 0 ? 'completed' : (code === null ? 'stopped' : 'failed');
            try {
                await Mission.findByIdAndUpdate(missionInfo.mission._id, {
                    $set: { status: finalStatus, endTime: new Date(), updatedAt: new Date() }
                });
            } catch (err) {
                console.error('Error finalizing mission:', err);
            }
        }
        activeFacebookScrapers.delete(mission._id.toString());
    });

    res.json({ message: 'Scrape started successfully', keyword, missionId: mission._id });
});

app.post('/api/scrape/stop', requireAuth, async (req, res) => {
    const { missionId } = req.body;
    const userId = req.userId;

    if (missionId) {
        const missionInfo = activeFacebookScrapers.get(missionId);
        if (!missionInfo) return res.status(404).json({ error: 'Mission not found or not running' });
        const mission = await Mission.findById(missionId);
        if (mission && mission.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        await stopFacebookScraper(missionId, missionInfo);
        return res.json({ message: 'Scraper stopped successfully', missionId });
    } else {
        if (activeFacebookScrapers.size === 0) return res.status(400).json({ error: 'No active scrapers to stop' });
        const stopPromises = [];
        for (const [id, info] of activeFacebookScrapers.entries()) {
            const mission = await Mission.findById(id);
            if (mission && mission.userId !== userId) continue;
            stopPromises.push(stopFacebookScraper(id, info));
        }
        await Promise.all(stopPromises);
        return res.json({ message: `Stopped ${stopPromises.length} active scrapers` });
    }
});

async function stopFacebookScraper(id, info) {
    try {
        console.log(`Stopping scraper for mission ${id}...`);
        try {
            await Mission.findByIdAndUpdate(id, {
                $set: { status: 'stopped', endTime: new Date(), updatedAt: new Date() }
            });
        } catch (err) {
            console.error('Error stopping mission in DB:', err);
        }

        if (info.process) {
            if (process.platform === 'win32') {
                return new Promise((resolve) => {
                    // execFile instead of exec — prevents command injection
                    execFile('taskkill', ['/pid', String(info.process.pid), '/T', '/F'], (error) => {
                        if (error) console.error('Error killing process:', error);
                        activeFacebookScrapers.delete(id);
                        resolve();
                    });
                });
            } else {
                info.process.kill('SIGTERM');
                activeFacebookScrapers.delete(id);
            }
        }
    } catch (err) {
        console.error(`Error stopping scraper ${id}:`, err);
    }
}

app.get('/api/missions', requireAuth, async (req, res) => {
    try {
        const missions = await Mission.find({ userId: req.userId }).sort({ startTime: -1 }).limit(50);
        res.json(missions);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch missions' });
    }
});

app.get('/api/scrape/status', requireAuth, async (req, res) => {
    try {
        const userId = req.userId;
        const activeMissions = [];
        let totalAdsFound = 0, totalNewAds = 0, mostRecentKeyword = null;

        for (const [id, info] of activeFacebookScrapers.entries()) {
            const mission = await Mission.findById(id);
            if (mission && mission.userId === userId) {
                totalAdsFound += mission.adsFound || 0;
                totalNewAds += mission.newAds || 0;
                if (!mostRecentKeyword) mostRecentKeyword = info.keyword;
                activeMissions.push({
                    missionId: id, keyword: info.keyword,
                    stats: { adsFound: mission.adsFound || 0, newAds: mission.newAds || 0 }
                });
            }
        }

        res.json({
            isScraping: activeMissions.length > 0, activeMissions,
            count: activeMissions.length, currentKeyword: mostRecentKeyword,
            stats: { adsFound: totalAdsFound, newAds: totalNewAds }
        });
    } catch (err) {
        console.error('Error fetching status:', err);
        res.json({ isScraping: false, activeMissions: [], count: 0, currentKeyword: null, stats: { adsFound: 0, newAds: 0 } });
    }
});

app.delete('/api/ads/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const ad = await Ad.findById(id);
        if (!ad) return res.status(404).json({ error: 'Ad not found' });
        if (ad.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
        await Ad.findByIdAndDelete(id);
        res.json({ message: 'Ad deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete ad' });
    }
});

app.post('/api/ads/batch-delete', requireAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Invalid IDs' });
        if (ids.length > 500) return res.status(400).json({ error: 'Batch limit is 500 items' });
        const result = await Ad.deleteMany({ _id: { $in: ids }, userId: req.userId });
        res.json({ message: 'Ads deleted', count: result.deletedCount });
    } catch (err) {
        res.status(500).json({ error: 'Failed to batch delete ads' });
    }
});

app.delete('/api/missions/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const mission = await Mission.findById(id);
        if (!mission) return res.status(404).json({ error: 'Mission not found' });
        if (mission.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
        const keyword = mission.keyword || '';
        await Mission.findByIdAndDelete(id);
        const adsDeleted = keyword ? await Ad.deleteMany({ userId: req.userId, keyword }) : { deletedCount: 0 };
        res.json({ message: 'Mission deleted', adsDeleted: adsDeleted.deletedCount });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete mission' });
    }
});

app.get('/api/ads/keyword/:keyword', requireAuth, async (req, res) => {
    try {
        const { keyword } = req.params;
        const ads = await Ad.find({ keyword: decodeURIComponent(keyword), userId: req.userId }).sort({ scrape_date: -1 });
        res.json(ads);
    } catch (err) {
        console.error('Fetch ads by keyword error:', err);
        res.status(500).json({ error: 'Failed to fetch ads by keyword' });
    }
});

app.post('/api/missions/batch-delete', requireAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Invalid IDs' });
        if (ids.length > 100) return res.status(400).json({ error: 'Batch limit is 100 missions' });
        const missions = await Mission.find({ _id: { $in: ids }, userId: req.userId });
        const keywords = [...new Set(missions.map(m => m.keyword).filter(Boolean))];
        const missionResult = await Mission.deleteMany({ _id: { $in: ids }, userId: req.userId });
        let adsDeleted = 0;
        for (const kw of keywords) {
            const r = await Ad.deleteMany({ userId: req.userId, keyword: kw });
            adsDeleted += r.deletedCount;
        }
        res.json({ message: 'Missions deleted', count: missionResult.deletedCount, adsDeleted });
    } catch (err) {
        res.status(500).json({ error: 'Failed to batch delete missions' });
    }
});

// ─── Scheduler Routes ────────────────────────────────────────────────────────

app.get('/api/schedulers', requireAuth, async (req, res) => {
    try { res.json(await schedulerService.getSchedulers(req.userId)); }
    catch (err) { console.error('Fetch schedulers error:', err); res.status(500).json({ error: 'Failed to fetch schedulers' }); }
});

app.post('/api/schedulers', requireAuth, async (req, res) => {
    try {
        const { keyword, cronExpression, maxAdsPerRequest, dailyLimit } = req.body;
        if (!keyword || !cronExpression) return res.status(400).json({ error: 'Keyword and cron expression are required' });
        if (!cron.validate(cronExpression)) return res.status(400).json({ error: 'Invalid cron expression' });
        const scheduler = await schedulerService.addScheduler(keyword, cronExpression, maxAdsPerRequest || 100, dailyLimit || 1000, req.userId);
        res.json(scheduler);
    } catch (err) { console.error('Create scheduler error:', err); res.status(500).json({ error: 'Failed to create scheduler' }); }
});

app.put('/api/schedulers/:id', requireAuth, async (req, res) => {
    try {
        const scheduler = await schedulerService.updateScheduler(req.params.id, req.body, req.userId);
        if (!scheduler) return res.status(404).json({ error: 'Scheduler not found' });
        res.json({ message: 'Scheduler updated', scheduler });
    } catch (err) { console.error('Update scheduler error:', err); res.status(500).json({ error: 'Failed to update scheduler' }); }
});

app.delete('/api/schedulers/:id', requireAuth, async (req, res) => {
    try { await schedulerService.deleteScheduler(req.params.id, req.userId); res.json({ message: 'Scheduler deleted' }); }
    catch (err) { console.error('Delete scheduler error:', err); res.status(500).json({ error: 'Failed to delete scheduler' }); }
});

app.get('/api/schedulers/status', requireAuth, async (req, res) => {
    try {
        const status = schedulerService.getJobStatus();
        const activeJobs = await schedulerService.getActiveJobs();
        res.json({ ...status, activeJobs });
    } catch (err) { res.status(500).json({ error: 'Failed to get scheduler status' }); }
});

// ─── Google Ads Routes ───────────────────────────────────────────────────────

app.get('/api/google-ads/suggestions/:keyword', requireAuth, async (req, res) => {
    try {
        const { keyword } = req.params;
        if (!keyword || keyword.length < 2) return res.status(400).json({ error: 'Keyword must be at least 2 characters' });
        const suggestions = await googleAdsScraper.fetchSuggestions(keyword);
        res.json({ suggestions, keyword });
    } catch (err) {
        console.error('Google Ads suggestions error:', err);
        res.status(500).json({ error: 'Failed to fetch Google Ads suggestions' });
    }
});

app.post('/api/google-ads/scrape', requireAuth, scrapeLimiter, async (req, res) => {
    const { keyword, maxAdsPerRequest, dailyLimit } = req.body;
    const userId = req.userId;

    if (!keyword) return res.status(400).json({ error: 'Keyword is required' });
    if (typeof keyword === 'string' && keyword.length > 200) return res.status(400).json({ error: 'Keyword too long' });

    const maxAds = maxAdsPerRequest || 1000;
    const dailyQuota = dailyLimit || 5000;
    if (maxAds > 10000000) return res.status(400).json({ error: 'maxAdsPerRequest cannot exceed 10,000,000' });
    if (dailyQuota > 10000000) return res.status(400).json({ error: 'dailyLimit cannot exceed 10,000,000' });

    const mission = new Mission({
        userId, keyword: `google_${keyword}`, status: 'running', startTime: new Date(),
        maxAdsPerRequest: maxAds, dailyLimit: dailyQuota, source: 'google_ads'
    });
    await mission.save();

    const scraperInstance = new GoogleAdsScraper();
    activeGoogleScrapers.set(mission._id.toString(), { scraper: scraperInstance, keyword, mission });

    console.log(`Starting Google Ads scrape: "${keyword}" (Mission: ${mission._id})`);

    (async () => {
        try {
            const ads = await scraperInstance.scrapeAds(keyword, maxAds);
            mission.adsFound = ads.length;
            mission.newAds = 0;

            let savedCount = 0;
            for (const adData of ads) {
                try {
                    const doc = { ...adData };
                    if (userId) doc.userId = userId;
                    const ad = new Ad(doc);
                    await ad.save();
                    savedCount++;
                } catch (saveErr) {
                    console.error('Error saving Google ad:', saveErr.message);
                }
            }

            mission.newAds = savedCount;
            mission.status = 'completed';
            mission.endTime = new Date();
            await mission.save();
            console.log(`Google Ads scrape completed: ${ads.length} found, ${savedCount} saved`);
        } catch (error) {
            console.error(`Google Ads scrape failed [${mission._id}]:`, error);
            try { mission.status = 'failed'; mission.endTime = new Date(); await mission.save(); } catch {}
        } finally {
            activeGoogleScrapers.delete(mission._id.toString());
            await scraperInstance.close();
        }
    })().catch(err => {
        console.error('Fatal error in Google Ads task:', err);
        activeGoogleScrapers.delete(mission._id.toString());
    });

    res.json({ message: 'Google Ads scrape started', keyword, missionId: mission._id });
});

app.get('/api/google-ads/status', requireAuth, async (req, res) => {
    const activeMissions = [];
    for (const [id, info] of activeGoogleScrapers.entries()) {
        const mission = await Mission.findById(id);
        if (mission && mission.userId === req.userId) {
            activeMissions.push({ missionId: id, keyword: info.keyword, status: 'running' });
        }
    }
    res.json({ isScraping: activeMissions.length > 0, activeMissions, count: activeMissions.length });
});

app.post('/api/google-ads/stop', requireAuth, async (req, res) => {
    const { missionId } = req.body;
    const userId = req.userId;

    if (missionId) {
        const info = activeGoogleScrapers.get(missionId);
        if (!info) return res.status(404).json({ error: 'Google Ads mission not found' });
        const mission = await Mission.findById(missionId);
        if (mission && mission.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        await stopGoogleScraper(missionId, info);
        return res.json({ message: 'Google Ads scraper stopped', missionId });
    } else {
        if (activeGoogleScrapers.size === 0) return res.status(400).json({ error: 'No active Google Ads scrape' });
        const promises = [];
        for (const [id, info] of activeGoogleScrapers.entries()) promises.push(stopGoogleScraper(id, info));
        await Promise.all(promises);
        return res.json({ message: `Stopped ${promises.length} Google Ads scrapers` });
    }
});

async function stopGoogleScraper(id, info) {
    try {
        try {
            await Mission.findByIdAndUpdate(id, { $set: { status: 'stopped', endTime: new Date(), updatedAt: new Date() } });
        } catch {}
        if (info.scraper) await info.scraper.close();
        activeGoogleScrapers.delete(id);
    } catch (err) {
        console.error(`Error stopping Google scraper ${id}:`, err);
    }
}

// ─── Facebook Post Likes Extraction Routes ───────────────────────────────────

app.post('/api/facebook-extract/post-likes', requireAuth, scrapeLimiter, async (req, res) => {
    try {
        const { postUrl } = req.body;
        const userId = req.userId;

        if (!postUrl || typeof postUrl !== 'string') {
            return res.status(400).json({ error: 'Valid Facebook post URL is required' });
        }

        // Validate Facebook URL format
        const facebookUrlRegex = /^https:\/\/(www\.)?facebook\.com\/(share\/p\/|share\/r\/|reel\/|reels\/|posts\/|permalink\.php|watch\/|[^\/]+\/posts\/[^\/]+|[^\/]+\/videos\/[^\/]+|[^\/]+\/reels\/[^\/]+).*/;
        if (!facebookUrlRegex.test(postUrl.trim())) {
            return res.status(400).json({ error: 'Invalid Facebook URL. Use a normal post URL, or a Reel URL (facebook.com/reel/...), share links, videos, or permalinks.' });
        }

        console.log(`🚀 Starting Facebook post likes extraction for user ${userId}`);
        console.log(`📝 Target URL: ${postUrl}`);

        const startTime = Date.now();

        // Import the Facebook likes extractor
        const { extractFacebookPostLikes } = await import('./src/simpleFacebookExtractor.js');

        // Extract likes from the post
        const result = await extractFacebookPostLikes(postUrl.trim());

        const processingTime = Date.now() - startTime;

        console.log(`✅ Extraction completed in ${processingTime}ms`);
        console.log(`📊 Found ${result.users.length} users out of ${result.total} total likes`);

        // Store extracted users in database (optional - you can create a new collection)
        // For now, just return the data

        res.json({
            success: true,
            users: result.users,
            total: result.total,
            processingTime: `${processingTime}ms`,
            extractedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Facebook post likes extraction error:', error);
        console.error('❌ Full error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        
        if (error.message.includes('private') || error.message.includes('authentication')) {
            return res.status(401).json({ error: 'Authentication required. Post may be private or login required.' });
        }
        
        if (error.message.includes('rate limit')) {
            return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
        }

        if (error.message.includes('invalid') || error.message.includes('not found')) {
            return res.status(400).json({ error: 'Invalid Facebook post URL or post not found.' });
        }

        if (error.message.includes('Could not find likes button')) {
            return res.status(400).json({ error: 'Could not access likes for this post. The post may not have likes or be restricted.' });
        }

        if (error.message.includes('Could not find likes modal')) {
            return res.status(400).json({ error: 'Could not access likes list. The likes may be restricted due to privacy settings.' });
        }

        // Return more detailed error for debugging
        return res.status(500).json({ 
            error: 'Failed to extract post likes. Please try again.',
            details: error.message,
            type: error.name
        });
    }
});

// ─── Facebook Filter Bot Routes ───────────────────────────────────────────────

app.post('/api/facebook-filter-bot/extract-comments', requireAuth, scrapeLimiter, async (req, res) => {
    let runId = null;
    const startTime = Date.now();
    try {
        const { postUrl, action, maxUsers: maxUsersRaw } = req.body;
        const userId = req.userId;

        if (!postUrl || typeof postUrl !== 'string') {
            return res.status(400).json({ error: 'Valid Facebook post URL is required' });
        }

        if (!action || !['Like', 'Comment', 'Goal'].includes(action)) {
            return res.status(400).json({ error: 'Valid action is required (Like, Comment, or Goal)' });
        }

        let maxUsers = null;
        if (maxUsersRaw !== undefined && maxUsersRaw !== null && maxUsersRaw !== '') {
            const n = Number(maxUsersRaw);
            if (!Number.isFinite(n) || n < 1 || n > 100000) {
                return res.status(400).json({ error: 'maxUsers must be a number between 1 and 100000' });
            }
            maxUsers = Math.floor(n);
        }

        // Validate Facebook URL format
        const facebookUrlRegex = /^https:\/\/(www\.)?facebook\.com\/(share\/p\/|share\/r\/|reel\/|reels\/|posts\/|permalink\.php|watch\/|[^\/]+\/posts\/[^\/]+|[^\/]+\/videos\/[^\/]+|[^\/]+\/reels\/[^\/]+).*/;
        if (!facebookUrlRegex.test(postUrl.trim())) {
            return res.status(400).json({ error: 'Invalid Facebook URL. Use a normal post URL, or a Reel URL (facebook.com/reel/...), share links, videos, or permalinks.' });
        }

        console.log(`🤖 Starting Facebook Filter Bot for ${action} extraction for user ${userId}`);
        console.log(`📝 Target URL: ${postUrl}`);
        if (maxUsers != null) {
            console.log(`📌 maxUsers: ${maxUsers}`);
        }

        // Create run immediately so frontend can show partial rows while scraping.
        try {
            const created = await createFilterBotRun(userId, {
                postUrl: postUrl.trim(),
                action,
                maxUsers
            });
            runId = created.runId;
            startFilterBotAutoEnrichmentWorker(userId, runId);
        } catch (createErr) {
            console.error('❌ Failed to create running Filter Bot run:', createErr);
        }

        // Import the Facebook filter bot
        const { extractFacebookPostComments } = await import('./src/facebookFilterBot.js');

        // Extract comments from the post
        const result = await extractFacebookPostComments(postUrl.trim(), action, {
            maxUsers,
            onProgress: async (payload) => {
                if (!runId) return;
                const users = Array.isArray(payload?.users) ? payload.users : [];
                if (!users.length) return;
                try {
                    await saveFilterBotRunProgress(userId, runId, users);
                    startFilterBotAutoEnrichmentWorker(userId, runId);
                } catch (progressErr) {
                    console.error('⚠️ Failed to save Filter Bot progress:', progressErr?.message || progressErr);
                }
            }
        });

        const processingTime = Date.now() - startTime;

        console.log(`✅ Filter bot extraction completed in ${processingTime}ms`);
        console.log(`📊 Found ${result.users.length} users who commented on this post`);

        if (runId) {
            try {
                await saveFilterBotRunProgress(userId, runId, result.users);
                await finalizeFilterBotRun(userId, runId, {
                    status: 'completed',
                    total: result.total,
                    processingTimeMs: processingTime
                });
                startFilterBotAutoEnrichmentWorker(userId, runId);
            } catch (persistErr) {
                console.error('❌ Failed to persist/finalize Filter Bot results to database:', persistErr);
            }
        } else {
            try {
                const persisted = await persistFilterBotExtraction(
                    userId,
                    {
                        postUrl: postUrl.trim(),
                        action,
                        maxUsers,
                        total: result.total,
                        processingTimeMs: processingTime,
                        status: 'completed'
                    },
                    result.users
                );
                runId = persisted.runId;
            } catch (persistErr) {
                console.error('❌ Failed to persist Filter Bot results to database:', persistErr);
            }
        }

        res.json({
            success: true,
            runId,
            persisted: Boolean(runId),
            users: result.users,
            total: result.total,
            action: result.action,
            maxUsers: maxUsers,
            processingTime: `${processingTime}ms`,
            extractedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Facebook Filter Bot error:', error);
        if (runId) {
            try {
                await finalizeFilterBotRun(req.userId, runId, {
                    status: 'failed',
                    total: 0,
                    processingTimeMs: Date.now() - startTime,
                    errorMessage: error?.message || 'Unknown error'
                });
            } catch (finalizeErr) {
                console.error('⚠️ Failed to finalize failed Filter Bot run:', finalizeErr);
            }
        }

        console.error('❌ Full error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        
        if (error.message.includes('private') || error.message.includes('authentication')) {
            return res.status(401).json({ error: 'Authentication required. Post may be private or login required.' });
        }
        
        if (error.message.includes('rate limit')) {
            return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
        }

        if (error.message.includes('invalid') || error.message.includes('not found')) {
            return res.status(400).json({ error: 'Invalid Facebook post URL or post not found.' });
        }

        if (error.message.includes('Could not find comments')) {
            return res.status(400).json({ error: 'Could not access comments for this post. The post may not have comments or be restricted.' });
        }

        // Return more detailed error for debugging
        return res.status(500).json({ 
            error: 'Failed to extract post comments. Please try again.',
            details: error.message,
            type: error.name
        });
    }
});

app.get('/api/facebook-filter-bot/latest', requireAuth, filterBotReadLimiter, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
        const data = await getLatestFilterBotRunWithComments(req.userId, page, limit);
        res.json(data);
    } catch (err) {
        console.error('GET /api/facebook-filter-bot/latest:', err);
        res.status(500).json({ error: 'Failed to load Filter Bot data' });
    }
});

app.get('/api/facebook-filter-bot/runs', requireAuth, filterBotReadLimiter, async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
        const skip = Math.max(0, parseInt(String(req.query.skip || '0'), 10) || 0);
        const runs = await listFilterBotRuns(req.userId, limit, skip);
        res.json({ runs });
    } catch (err) {
        console.error('GET /api/facebook-filter-bot/runs:', err);
        res.status(500).json({ error: 'Failed to list runs' });
    }
});

app.get('/api/facebook-filter-bot/runs/:runId/comments', requireAuth, filterBotReadLimiter, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
        const data = await getFilterBotRunComments(req.userId, req.params.runId, page, limit);
        if (!data.run) {
            return res.status(404).json({ error: 'Run not found' });
        }
        res.json(data);
    } catch (err) {
        console.error('GET /api/facebook-filter-bot/runs/:runId/comments:', err);
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

app.delete('/api/facebook-filter-bot/runs/:runId/comments', requireAuth, filterBotReadLimiter, async (req, res) => {
    try {
        const runId = req.params.runId;
        const rowIndicesRaw = req.body?.rowIndices;
        if (!Array.isArray(rowIndicesRaw)) {
            return res.status(400).json({ error: 'rowIndices must be an array' });
        }
        const rowIndices = rowIndicesRaw.slice(0, 50000);
        const result = await deleteFilterBotRunComments(req.userId, runId, rowIndices);
        res.json({ ...result });
    } catch (err) {
        console.error('DELETE /api/facebook-filter-bot/runs/:runId/comments:', err);
        res.status(500).json({ error: 'Failed to delete comments' });
    }
});

app.delete('/api/facebook-filter-bot/runs/:runId', requireAuth, filterBotReadLimiter, async (req, res) => {
    try {
        const runId = req.params.runId;
        const result = await deleteFilterBotRun(req.userId, runId);
        res.json({ ...result });
    } catch (err) {
        console.error('DELETE /api/facebook-filter-bot/runs/:runId:', err);
        res.status(500).json({ error: 'Failed to delete run' });
    }
});

// Agent 2 — Profile enrichment (profile + About): phones, addresses, social links
const FILTER_BOT_ENRICH_MAX_ROWS = Math.min(25, Math.max(1, parseInt(process.env.FILTER_BOT_ENRICH_MAX_ROWS || '15', 10) || 15));
const FILTER_BOT_ENRICH_CONCURRENCY = Math.min(5, Math.max(1, parseInt(process.env.FILTER_BOT_ENRICH_CONCURRENCY || '3', 10) || 3));

app.post('/api/facebook-filter-bot/enrich-profiles', requireAuth, filterBotEnrichLimiter, async (req, res) => {
    const startedAt = Date.now();
    console.log(`[Agent2] enrich-profiles REQUEST user=${req.userId} body=${JSON.stringify(req.body || {}).slice(0, 500)}`);

    try {
        const { runId, rowIndices: rowIndicesRaw } = req.body || {};
        const userId = req.userId;

        if (!runId || typeof runId !== 'string') {
            console.warn('[Agent2] enrich-profiles 400: runId missing');
            return res.status(400).json({ error: 'runId is required' });
        }
        if (!Array.isArray(rowIndicesRaw) || rowIndicesRaw.length === 0) {
            console.warn('[Agent2] enrich-profiles 400: rowIndices empty');
            return res.status(400).json({ error: 'rowIndices must be a non-empty array' });
        }

        const rowIndices = rowIndicesRaw
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n >= 0)
            .slice(0, FILTER_BOT_ENRICH_MAX_ROWS);

        if (rowIndices.length === 0) {
            return res.status(400).json({ error: 'No valid row indices' });
        }

        const rows = await getFilterBotCommentersForRows(userId, runId, rowIndices);
        if (rows.length === 0) {
            console.warn('[Agent2] enrich-profiles 404: no rows for run', runId);
            return res.status(404).json({ error: 'No matching rows for this run' });
        }

        const { enrichFacebookProfilesParallel } = await import('./src/facebookProfileEnricher.js');

        console.log(
            `[Agent2] parallel START runId=${runId} rows=${rows.length} concurrency=${FILTER_BOT_ENRICH_CONCURRENCY} indices=${rowIndices.join(',')}`
        );

        const batchResults = await enrichFacebookProfilesParallel(rows, FILTER_BOT_ENRICH_CONCURRENCY);

        const results = [];
        for (const br of batchResults) {
            if (br.ok && br.data) {
                const { rowIndex } = br;
                const data = br.data;
                await updateFilterBotCommenterEnrichment(userId, runId, rowIndex, {
                    status: 'completed',
                    phones: data.phones,
                    addresses: data.addresses,
                    socialLinks: data.socialLinks,
                    profileUrlUsed: data.profileUrlUsed,
                    aboutUrlUsed: data.aboutUrlUsed,
                    error: null
                });
                results.push({
                    rowIndex,
                    ok: true,
                    phones: data.phones,
                    addresses: data.addresses,
                    socialLinks: data.socialLinks,
                    profileUrlUsed: data.profileUrlUsed,
                    aboutUrlUsed: data.aboutUrlUsed
                });
                console.log(`[Agent2] row ${rowIndex} OK phones=${data.phones?.length ?? 0}`);
            } else {
                const rowIndex = br.rowIndex;
                const msg = br.error || 'Unknown error';
                await updateFilterBotCommenterEnrichment(userId, runId, rowIndex, {
                    status: 'failed',
                    phones: [],
                    addresses: [],
                    socialLinks: [],
                    error: msg
                });
                results.push({ rowIndex, ok: false, error: msg });
                console.warn(`[Agent2] row ${rowIndex} FAIL: ${msg}`);
            }
        }

        const ms = Date.now() - startedAt;
        console.log(`[Agent2] enrich-profiles DONE processed=${results.length} in ${ms}ms`);

        res.json({
            success: true,
            runId,
            processed: results.length,
            concurrency: FILTER_BOT_ENRICH_CONCURRENCY,
            processingTimeMs: ms,
            results
        });
    } catch (err) {
        console.error('POST /api/facebook-filter-bot/enrich-profiles:', err);
        res.status(500).json({ error: 'Profile enrichment failed', details: err?.message });
    }
});

// ─── Lead Capture Routes ─────────────────────────────────────────────────────

const leadCaptureLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many lead capture requests. Slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const leadCaptureReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many requests.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * POST /api/lead-capture/run — Start a multi-agent lead capture pipeline.
 * Body: { companies: ["School A", "Real Estate B", ...] }
 */
app.post('/api/lead-capture/run', requireAuth, leadCaptureLimiter, async (req, res) => {
    const startTime = Date.now();
    let runId = null;

    try {
        const { companies } = req.body;
        const userId = req.userId;

        if (!Array.isArray(companies) || companies.length === 0) {
            return res.status(400).json({ error: 'companies must be a non-empty array of business names' });
        }
        if (companies.length > 50) {
            return res.status(400).json({ error: 'Maximum 50 companies per run' });
        }

        const cleaned = companies
            .map(c => (typeof c === 'string' ? c.trim() : ''))
            .filter(c => c.length >= 2 && c.length <= 300);

        if (cleaned.length === 0) {
            return res.status(400).json({ error: 'No valid company names provided (min 2 chars each)' });
        }

        // Create run + seed result rows
        const created = await createLeadCaptureRun(userId, cleaned);
        runId = created.runId;

        console.log(`[LeadCapture] Run ${runId} started — ${cleaned.length} companies`);

        // Return immediately, process in background
        res.json({
            success: true,
            runId,
            totalCompanies: cleaned.length,
            message: 'Lead capture pipeline started. Poll /api/lead-capture/runs/:runId for results.',
        });

        // ── Background multi-agent processing ──
        (async () => {
            let completedCount = 0;
            let failedCount = 0;
            let sharedSession = null;

            try {
                const { scrapeGoogleMaps } = await import('./src/leadCaptureGoogleMaps.js');
                const { analyzeWebsite } = await import('./src/leadCaptureWebsiteAnalyzer.js');
                const { createStealthSession } = await import('./src/browserFlow.js');

                try {
                    sharedSession = await createStealthSession({
                        headless: process.env.LEAD_CAPTURE_HEADLESS === '1',
                        locale: 'en-US',
                        timezoneId: 'Asia/Kolkata',
                        viewport: { width: 1920, height: 1080 },
                    });
                } catch (sessionErr) {
                    console.warn(`[LeadCapture] Shared browser session init failed: ${sessionErr?.message || sessionErr}`);
                }

                for (let i = 0; i < cleaned.length; i++) {
                    const companyName = cleaned[i];
                    console.log(`[LeadCapture][${i + 1}/${cleaned.length}] Processing: "${companyName}"`);

                    // ── Agent 1: Google Maps ──
                    let mapsData = null;
                    try {
                        await updateLeadCaptureAgent1(userId, runId, i, { agent1Status: 'running' });
                        mapsData = await scrapeGoogleMaps(companyName, sharedSession);
                        await updateLeadCaptureAgent1(userId, runId, i, {
                            agent1Status: 'completed',
                            mapsAddress: mapsData.address || '',
                            mapsPhone: mapsData.phone || '',
                            mapsWebsite: mapsData.website || '',
                            mapsRating: mapsData.rating || '',
                            mapsReviewCount: mapsData.reviewCount || '',
                            mapsCategory: mapsData.category || '',
                            openingTime: mapsData.openingTime || '',
                            closingTime: mapsData.closingTime || '',
                            currentStatus: mapsData.currentStatus || '',
                            openingHours: mapsData.openingHours || [],
                        });
                        console.log(`[LeadCapture] Agent1 done for "${companyName}" — website: ${mapsData.website || '(none)'}`);
                    } catch (a1Err) {
                        console.error(`[LeadCapture] Agent1 FAILED for "${companyName}":`, a1Err?.message);
                        await updateLeadCaptureAgent1(userId, runId, i, {
                            agent1Status: 'failed',
                            agent1Error: a1Err?.message || 'Unknown error',
                        });
                    }

                    // ── Agent 2: Website Analyzer (only if we got a website) ──
                    const websiteUrl = mapsData?.website || '';
                    let analysisFailed = false;
                    if (websiteUrl) {
                        try {
                            await updateLeadCaptureAgent2(userId, runId, i, { agent2Status: 'running', websiteUrl });
                            const analysis = await analyzeWebsite(websiteUrl, companyName, sharedSession, {
                                runId,
                                rowIndex: i,
                                mapsPhone: mapsData?.phone || '',
                            });
                            await updateLeadCaptureAgent2(userId, runId, i, {
                                agent2Status: 'completed',
                                websiteUrl: analysis.websiteUrl,
                                popupDetected: analysis.popupDetected,
                                popupType: analysis.popupType,
                                extractedText: analysis.extractedText,
                                ocrText: analysis.ocrText,
                                interpretedMeaning: analysis.interpretedMeaning,
                                score: analysis.score,
                                signals: analysis.signals,
                                summary: analysis.summary,
                                popupScreenshot: analysis.popupScreenshot,
                                fullScreenshot: analysis.fullScreenshot,
                                pageTitle: analysis.pageTitle,
                                lastUpdatedYears: analysis.lastUpdatedYears,
                                lastUpdatedAt: analysis.lastUpdatedAt,
                                freshnessSource: analysis.freshnessSource,
                                freshnessScore: analysis.freshnessScore,
                                techProfile: analysis.techProfile,
                                recommendedServices: analysis.recommendedServices,
                            });
                            console.log(`[LeadCapture] Agent2 done for "${companyName}" — score: ${analysis.score}`);
                        } catch (a2Err) {
                            analysisFailed = true;
                            console.error(`[LeadCapture] Agent2 FAILED for "${companyName}":`, a2Err?.message);
                            await updateLeadCaptureAgent2(userId, runId, i, {
                                agent2Status: 'failed',
                                agent2Error: a2Err?.message || 'Unknown error',
                            });
                        }
                    } else {
                        await updateLeadCaptureAgent2(userId, runId, i, {
                            agent2Status: 'skipped',
                            agent2Error: 'No website URL found on Google Maps',
                        });
                    }

                    // Track per-company outcome based on actual agent statuses,
                    // not the loop counter (so failures don't masquerade as successes).
                    const a1Failed = !mapsData;
                    const a2Failed = !!websiteUrl && analysisFailed;
                    if (a1Failed || a2Failed) failedCount++;
                    else completedCount++;

                    // Update run progress
                    await finalizeLeadCaptureRun(userId, runId, {
                        status: 'running',
                        processedCount: i + 1,
                        completedCount,
                        failedCount,
                        processingTimeMs: Date.now() - startTime,
                    });

                    // ── Self-heal: if the shared browser/context died (e.g., Chrome
                    // crashed, OS killed it, persistent context closed unexpectedly),
                    // rebuild the session before the next company instead of failing
                    // the entire remaining batch. Cheap probe: try a no-op pages() call.
                    if (sharedSession) {
                        let alive = true;
                        try {
                            await sharedSession.context?.pages();
                        } catch {
                            alive = false;
                        }
                        if (!alive && i + 1 < cleaned.length) {
                            console.warn('[LeadCapture] Shared session appears dead — rebuilding...');
                            try {
                                await sharedSession.context?.close().catch(() => {});
                                if (sharedSession.ownsBrowser) {
                                    await sharedSession.browser?.close().catch(() => {});
                                }
                            } catch {}
                            try {
                                sharedSession = await createStealthSession({
                                    headless: process.env.LEAD_CAPTURE_HEADLESS === '1',
                                    locale: 'en-US',
                                    timezoneId: 'Asia/Kolkata',
                                    viewport: { width: 1920, height: 1080 },
                                });
                                console.log('[LeadCapture] Session rebuilt successfully.');
                            } catch (rebuildErr) {
                                console.error(`[LeadCapture] Session rebuild failed: ${rebuildErr?.message}`);
                                sharedSession = null;
                            }
                        }
                    }
                }
            } catch (pipelineErr) {
                console.error(`[LeadCapture] Pipeline error for run ${runId}:`, pipelineErr);
                failedCount = cleaned.length - completedCount;
            } finally {
                if (sharedSession?.ownsContext && sharedSession?.context) {
                    await sharedSession.context.close().catch(() => {});
                }
                if (sharedSession?.ownsBrowser && sharedSession?.browser) {
                    await sharedSession.browser.close().catch(() => {});
                }
            }

            // Finalize the run
            await finalizeLeadCaptureRun(userId, runId, {
                status: failedCount === cleaned.length ? 'failed' : 'completed',
                processedCount: cleaned.length,
                completedCount,
                failedCount,
                processingTimeMs: Date.now() - startTime,
            });

            console.log(`[LeadCapture] Run ${runId} DONE — completed: ${completedCount}, failed: ${failedCount}, time: ${Date.now() - startTime}ms`);
        })();

    } catch (error) {
        console.error('POST /api/lead-capture/run error:', error);
        if (runId) {
            await finalizeLeadCaptureRun(req.userId, runId, {
                status: 'failed',
                errorMessage: error?.message || 'Unknown error',
                processingTimeMs: Date.now() - startTime,
            });
        }
        res.status(500).json({ error: 'Failed to start lead capture pipeline', details: error?.message });
    }
});

/**
 * GET /api/lead-capture/runs — List all runs for current user.
 */
app.get('/api/lead-capture/runs', requireAuth, leadCaptureReadLimiter, async (req, res) => {
    try {
        const runs = await listLeadCaptureRuns(req.userId);
        res.json({ runs });
    } catch (err) {
        console.error('GET /api/lead-capture/runs:', err);
        res.status(500).json({ error: 'Failed to load lead capture runs' });
    }
});

/**
 * GET /api/lead-capture/latest — Get latest run with results (paginated).
 */
app.get('/api/lead-capture/latest', requireAuth, leadCaptureReadLimiter, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
        const data = await getLatestLeadCaptureRun(req.userId, page, limit);
        res.json(data);
    } catch (err) {
        console.error('GET /api/lead-capture/latest:', err);
        res.status(500).json({ error: 'Failed to load latest lead capture data' });
    }
});

/**
 * GET /api/lead-capture/runs/:runId — Get specific run with results.
 */
app.get('/api/lead-capture/runs/:runId', requireAuth, leadCaptureReadLimiter, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
        const data = await getLeadCaptureRunResults(req.userId, req.params.runId, page, limit);
        if (!data.run) return res.status(404).json({ error: 'Run not found' });
        res.json(data);
    } catch (err) {
        console.error('GET /api/lead-capture/runs/:runId:', err);
        res.status(500).json({ error: 'Failed to load lead capture results' });
    }
});

/**
 * DELETE /api/lead-capture/runs/:runId — Delete a run and all results.
 */
app.delete('/api/lead-capture/runs/:runId', requireAuth, leadCaptureReadLimiter, async (req, res) => {
    try {
        const result = await deleteLeadCaptureRun(req.userId, req.params.runId);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('DELETE /api/lead-capture/runs/:runId:', err);
        res.status(500).json({ error: 'Failed to delete lead capture run' });
    }
});

/**
 * POST /api/lead-capture/audit — Agent 3: run an on-demand website audit
 * for a single LeadCaptureResult. Caches the result on the document;
 * pass { refresh: true } to force a re-run.
 * Body: { resultId: string, refresh?: boolean }
 */
app.post('/api/lead-capture/audit', requireAuth, leadCaptureReadLimiter, async (req, res) => {
    try {
        const { resultId, refresh } = req.body || {};
        if (!resultId) return res.status(400).json({ error: 'resultId is required' });

        const doc = await LeadCaptureResult.findOne({ _id: resultId, userId: req.userId });
        if (!doc) return res.status(404).json({ error: 'Result not found' });

        if (doc.audit && doc.audit.status === 'completed' && !refresh) {
            return res.json({ audit: doc.audit, cached: true });
        }

        if (!doc.websiteUrl) {
            const failed = {
                status: 'failed',
                error: 'No website URL available for this lead',
                auditedAt: new Date(),
            };
            doc.audit = failed;
            doc.auditStatus = 'failed';
            await doc.save();
            return res.json({ audit: failed, cached: false });
        }

        doc.auditStatus = 'running';
        await doc.save();

        const audit = await auditWebsite({
            websiteUrl: doc.websiteUrl,
            companyName: doc.companyName,
            category: doc.mapsCategory || '',
            countryHint: doc.mapsAddress || '',
        });

        doc.audit = audit;
        doc.auditStatus = audit.status === 'completed' ? 'completed' : 'failed';
        await doc.save();

        res.json({ audit, cached: false });
    } catch (err) {
        console.error('POST /api/lead-capture/audit:', err);
        res.status(500).json({ error: 'Audit failed', details: err?.message });
    }
});

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
    console.log(`${signal} received, shutting down gracefully`);
    for (const [id, info] of activeFacebookScrapers.entries()) await stopFacebookScraper(id, info);
    for (const [id, info] of activeGoogleScrapers.entries()) await stopGoogleScraper(id, info);
    try { await mongoose.connection.close(); console.log('MongoDB connection closed'); } catch {}
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Startup ─────────────────────────────────────────────────────────────────

(async () => {
    try {
        await ensureMongoConnected();
        const dbCount = await Ad.countDocuments();
        console.log('Ad collection:', Ad.collection.name, 'Total ads:', dbCount);

        // Stale mission cleanup on restart
        const staleResult = await Mission.updateMany(
            { status: 'running' },
            { $set: { status: 'failed', endTime: new Date(), error: 'Server restarted — mission was orphaned' } }
        );
        if (staleResult.modifiedCount > 0) {
            console.log(`Cleaned up ${staleResult.modifiedCount} stale missions`);
        }
    } catch (err) {
        console.error('MongoDB connection error:', err);
        if (IS_PRODUCTION) process.exit(1);
    }

    const bindHost = IS_PRODUCTION ? '0.0.0.0' : '127.0.0.1';
    const server = app.listen(Number(PORT) || 5001, bindHost, async () => {
        console.log(`Server running on http://localhost:${PORT} [${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
        console.log(`Max concurrent scrapers: ${MAX_CONCURRENT_SCRAPERS}`);
        try {
            await schedulerService.start();
            console.log('Scheduler service initialized');
        } catch (error) {
            console.error('Failed to initialize scheduler:', error);
        }
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use.`);
            process.exit(1);
        } else {
            console.error('Server error:', err);
        }
    });
})();
