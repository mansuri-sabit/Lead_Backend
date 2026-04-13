import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { config, getSearchUrl, getSearchUrlWithFilters } from './config.js';
import { saveAd, saveAdsBulk, getStats, updateMission, getMissionById } from './db.js';
import process from 'node:process';

chromium.use(stealth());

// ─────────────────────────────────────────────────────────────────────────────
// Production Logger — structured, timestamped, with performance tracking
// ─────────────────────────────────────────────────────────────────────────────

const LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
const CURRENT_LOG_LEVEL = LOG_LEVEL.INFO;

class Logger {
    public executionId: string;
    private startTime: number;
    private scrollMetrics = {
        totalScrollAttempts: 0,
        successfulScrolls: 0,
        failedScrolls: 0,
        nudgeRecoveries: 0,
        popupRecoveries: 0,
        totalScrollWaitMs: 0,
        consecutiveFailures: 0,
        maxConsecutiveFailures: 0,
    };
    private resourceWarnings: string[] = [];
    private lastMemoryCheck = 0;
    private readonly MEMORY_CHECK_INTERVAL = 30_000;
    private readonly MEMORY_WARN_MB = 1500;

    constructor(executionId: string) {
        this.executionId = executionId;
        this.startTime = Date.now();
    }

    private ts(): string { return new Date().toISOString(); }

    private elapsed(): string {
        const ms = Date.now() - this.startTime;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
        if (m > 0) return `${m}m${s % 60}s`;
        return `${s}s`;
    }

    debug(msg: string, data?: Record<string, unknown>) {
        if (CURRENT_LOG_LEVEL <= LOG_LEVEL.DEBUG)
            console.log(`[${this.ts()}] [DEBUG] [${this.executionId}] [${this.elapsed()}] ${msg}`, data ? JSON.stringify(data) : '');
    }

    info(msg: string, data?: Record<string, unknown>) {
        if (CURRENT_LOG_LEVEL <= LOG_LEVEL.INFO)
            console.log(`[${this.ts()}] [INFO] [${this.executionId}] [${this.elapsed()}] ${msg}`, data ? JSON.stringify(data) : '');
    }

    warn(msg: string, data?: Record<string, unknown>) {
        if (CURRENT_LOG_LEVEL <= LOG_LEVEL.WARN)
            console.warn(`[${this.ts()}] [WARN] [${this.executionId}] [${this.elapsed()}] ${msg}`, data ? JSON.stringify(data) : '');
    }

    error(msg: string, err?: Error | unknown, data?: Record<string, unknown>) {
        if (CURRENT_LOG_LEVEL <= LOG_LEVEL.ERROR) {
            const errObj = err instanceof Error
                ? { message: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') }
                : { message: String(err) };
            console.error(`[${this.ts()}] [ERROR] [${this.executionId}] [${this.elapsed()}] ${msg}`, JSON.stringify({ ...errObj, ...data }));
        }
    }

    recordScroll(success: boolean, waitMs: number) {
        this.scrollMetrics.totalScrollAttempts++;
        this.scrollMetrics.totalScrollWaitMs += waitMs;
        if (success) {
            this.scrollMetrics.successfulScrolls++;
            this.scrollMetrics.consecutiveFailures = 0;
        } else {
            this.scrollMetrics.failedScrolls++;
            this.scrollMetrics.consecutiveFailures++;
            this.scrollMetrics.maxConsecutiveFailures = Math.max(
                this.scrollMetrics.maxConsecutiveFailures,
                this.scrollMetrics.consecutiveFailures
            );
        }
    }

    recordNudgeRecovery() { this.scrollMetrics.nudgeRecoveries++; }
    recordPopupRecovery() { this.scrollMetrics.popupRecoveries++; }
    getConsecutiveFailures(): number { return this.scrollMetrics.consecutiveFailures; }

    checkResources(): { rss: number; heapUsed: number; heapTotal: number; warning: string | null } {
        const now = Date.now();
        const mem = process.memoryUsage();
        const rssMB = Math.round(mem.rss / 1024 / 1024);
        const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
        let warning: string | null = null;
        if (rssMB > this.MEMORY_WARN_MB) {
            warning = `HIGH MEMORY: RSS=${rssMB}MB exceeds ${this.MEMORY_WARN_MB}MB threshold`;
            if (now - this.lastMemoryCheck > this.MEMORY_CHECK_INTERVAL) {
                this.warn(warning, { rssMB, heapUsedMB, heapTotalMB });
                this.resourceWarnings.push(warning);
                this.lastMemoryCheck = now;
            }
        }
        return { rss: rssMB, heapUsed: heapUsedMB, heapTotal: heapTotalMB, warning };
    }

    printSummary(stats: any) {
        const duration = Date.now() - this.startTime;
        const summary = {
            duration: this.elapsed(), durationMs: duration,
            ads: { saved: stats.savedCount, duplicates: stats.duplicateCount, processed: stats.processedCount },
            scrolling: { ...this.scrollMetrics },
            performance: {
                adsPerMinute: duration > 0 ? Math.round((stats.savedCount / duration) * 60000 * 100) / 100 : 0,
                avgScrollWaitMs: this.scrollMetrics.totalScrollAttempts > 0
                    ? Math.round(this.scrollMetrics.totalScrollWaitMs / this.scrollMetrics.totalScrollAttempts) : 0,
                scrollSuccessRate: this.scrollMetrics.totalScrollAttempts > 0
                    ? `${Math.round((this.scrollMetrics.successfulScrolls / this.scrollMetrics.totalScrollAttempts) * 100)}%` : 'N/A',
            },
            errors: stats.errorCount, memoryCleanups: stats.memoryCleanups,
            resourceWarnings: this.resourceWarnings.length, finalMemory: this.checkResources(),
        };
        this.info('SCRAPE COMPLETE — Summary:', summary as any);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scraper Configuration
// ─────────────────────────────────────────────────────────────────────────────

const getDefaultScraperConfig = () => ({
    maxAds: 100,
    scrollDelay: 600,
    maxScrollAttempts: 5000,
    batchProcessingSize: 50,
    memoryCleanupInterval: 20,
    maxExecutionTime: 600 * 60 * 1000,
    errorRetryAttempts: 5,
    errorRetryDelay: 10000,
    healthCheckInterval: 30000,
    refreshInterval: 3000,
    navigationTimeout: 20000,
    elementWaitTimeout: 10000,
    dailyLimitCheckInterval: 10,
    scrollWaitTimeout: 8000,
    scrollStallThreshold: 5,
    scrollMaxConsecutiveFails: 12,
    scrollBackoffBaseMs: 1000,
    scrollBackoffMaxMs: 15000,
});

const createScraperConfig = () => {
    const d = getDefaultScraperConfig();
    const e = {
        maxAds: process.env.SCRAPER_MAX_ADS ? parseInt(process.env.SCRAPER_MAX_ADS) : d.maxAds,
        scrollDelay: process.env.SCRAPER_SCROLL_DELAY ? parseInt(process.env.SCRAPER_SCROLL_DELAY) : d.scrollDelay,
        maxScrollAttempts: process.env.SCRAPER_MAX_SCROLL_ATTEMPTS ? parseInt(process.env.SCRAPER_MAX_SCROLL_ATTEMPTS) : d.maxScrollAttempts,
        batchProcessingSize: process.env.SCRAPER_BATCH_SIZE ? parseInt(process.env.SCRAPER_BATCH_SIZE) : d.batchProcessingSize,
        memoryCleanupInterval: process.env.SCRAPER_MEMORY_CLEANUP_INTERVAL ? parseInt(process.env.SCRAPER_MEMORY_CLEANUP_INTERVAL) : d.memoryCleanupInterval,
        maxExecutionTime: process.env.SCRAPER_MAX_EXECUTION_TIME ? parseInt(process.env.SCRAPER_MAX_EXECUTION_TIME) : d.maxExecutionTime,
        errorRetryAttempts: process.env.SCRAPER_ERROR_RETRY_ATTEMPTS ? parseInt(process.env.SCRAPER_ERROR_RETRY_ATTEMPTS) : d.errorRetryAttempts,
        errorRetryDelay: process.env.SCRAPER_ERROR_RETRY_DELAY ? parseInt(process.env.SCRAPER_ERROR_RETRY_DELAY) : d.errorRetryDelay,
        healthCheckInterval: process.env.SCRAPER_HEALTH_CHECK_INTERVAL ? parseInt(process.env.SCRAPER_HEALTH_CHECK_INTERVAL) : d.healthCheckInterval,
    };
    return {
        maxAds: Math.max(1, Math.min(10000000, e.maxAds)),
        scrollDelay: Math.max(300, Math.min(30000, e.scrollDelay)),
        maxScrollAttempts: Math.max(5, Math.min(100000, e.maxScrollAttempts)),
        batchProcessingSize: Math.max(10, Math.min(500, e.batchProcessingSize)),
        memoryCleanupInterval: Math.max(1, Math.min(50, e.memoryCleanupInterval)),
        maxExecutionTime: Math.max(300000, Math.min(36000000, e.maxExecutionTime)),
        errorRetryAttempts: Math.max(0, Math.min(10, e.errorRetryAttempts)),
        errorRetryDelay: Math.max(1000, Math.min(60000, e.errorRetryDelay)),
        healthCheckInterval: Math.max(10000, Math.min(300000, e.healthCheckInterval)),
        refreshInterval: d.refreshInterval,
        navigationTimeout: process.env.SCRAPER_NAV_TIMEOUT ? parseInt(process.env.SCRAPER_NAV_TIMEOUT) : d.navigationTimeout,
        elementWaitTimeout: process.env.SCRAPER_ELEMENT_TIMEOUT ? parseInt(process.env.SCRAPER_ELEMENT_TIMEOUT) : d.elementWaitTimeout,
        dailyLimitCheckInterval: d.dailyLimitCheckInterval,
        scrollWaitTimeout: d.scrollWaitTimeout,
        scrollStallThreshold: d.scrollStallThreshold,
        scrollMaxConsecutiveFails: d.scrollMaxConsecutiveFails,
        scrollBackoffBaseMs: d.scrollBackoffBaseMs,
        scrollBackoffMaxMs: d.scrollBackoffMaxMs,
    };
};

const scraperConfig = createScraperConfig();

// ─────────────────────────────────────────────────────────────────────────────
// Human Behavior Simulation Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a random integer between min and max (inclusive). */
function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Returns a random float between min and max. */
function randFloat(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

/** Sleeps for a random duration between min and max ms. */
function randomSleep(minMs: number, maxMs: number): Promise<void> {
    return new Promise(r => setTimeout(r, randInt(minMs, maxMs)));
}

/**
 * Generates a Bezier-curved mouse path between two points.
 * Real humans don't move mice in straight lines — they curve.
 */
function generateMousePath(
    startX: number, startY: number,
    endX: number, endY: number,
    steps: number
): Array<{ x: number; y: number }> {
    // Random control points for a cubic bezier curve
    const cp1x = startX + (endX - startX) * randFloat(0.2, 0.5) + randInt(-50, 50);
    const cp1y = startY + (endY - startY) * randFloat(0.0, 0.4) + randInt(-30, 30);
    const cp2x = startX + (endX - startX) * randFloat(0.5, 0.8) + randInt(-50, 50);
    const cp2y = startY + (endY - startY) * randFloat(0.6, 1.0) + randInt(-30, 30);

    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        // Cubic bezier formula
        const x = u * u * u * startX + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * endX;
        const y = u * u * u * startY + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * endY;
        points.push({
            x: Math.round(x * 10) / 10,
            y: Math.round(y * 10) / 10
        });
    }
    return points;
}

/**
 * Moves the mouse along a human-like curved path using CDP Input.dispatchMouseEvent.
 * These generate isTrusted-equivalent mouse events at the browser level.
 */
async function humanMouseMove(page: any, toX: number, toY: number, log: Logger) {
    try {
        const cdp = await page.context().newCDPSession(page);
        const viewport = page.viewportSize() || { width: 1280, height: 800 };

        // Start from a random position in the viewport (simulates cursor already being somewhere)
        const startX = randInt(100, viewport.width - 100);
        const startY = randInt(100, viewport.height - 100);
        const steps = randInt(8, 18);
        const path = generateMousePath(startX, startY, toX, toY, steps);

        for (const point of path) {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: Math.max(0, Math.min(point.x, viewport.width)),
                y: Math.max(0, Math.min(point.y, viewport.height)),
                modifiers: 0,
            });
            // Variable delay: humans move fast in the middle, slow at start/end
            await new Promise(r => setTimeout(r, randInt(5, 25)));
        }

        await cdp.detach();
    } catch {
        // Mouse movement is enhancement-only — never crash the scraper
    }
}

/**
 * Simulates mouse wheel scrolling via CDP Input.dispatchMouseEvent.
 * This produces trusted wheel events with realistic deltaY values.
 *
 * Real mouse wheels scroll in discrete "ticks" of ~100-120px (depends on OS/driver).
 * We simulate variable tick sizes with micro-pauses between them.
 */
async function humanWheelScroll(page: any, totalDelta: number, log: Logger): Promise<void> {
    try {
        const cdp = await page.context().newCDPSession(page);
        const viewport = page.viewportSize() || { width: 1280, height: 800 };

        // Mouse position for scrolling — center-ish but with random offset
        const mouseX = randInt(viewport.width * 0.3, viewport.width * 0.7);
        const mouseY = randInt(viewport.height * 0.3, viewport.height * 0.7);

        let scrolled = 0;
        const direction = totalDelta > 0 ? 1 : -1;
        const absDelta = Math.abs(totalDelta);

        while (scrolled < absDelta) {
            // Each wheel tick: 80-140px (like a real mouse notch)
            const tickSize = Math.min(randInt(80, 140), absDelta - scrolled);
            scrolled += tickSize;

            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: mouseX + randInt(-3, 3),  // Tiny jitter — hand tremor
                y: mouseY + randInt(-3, 3),
                deltaX: 0,
                deltaY: tickSize * direction,
                modifiers: 0,
            });

            // Pause between ticks: fast bursts (30-60ms) with occasional slow ticks (100-250ms)
            if (Math.random() < 0.15) {
                // 15% chance of a "reading pause" between wheel ticks
                await new Promise(r => setTimeout(r, randInt(100, 250)));
            } else {
                await new Promise(r => setTimeout(r, randInt(30, 60)));
            }
        }

        await cdp.detach();
    } catch (e: any) {
        // Fallback: if CDP wheel fails, use page.mouse.wheel (still better than scrollBy)
        log.debug(`CDP wheel fallback: ${e.message}`);
        try {
            await page.mouse.wheel(0, totalDelta);
        } catch {
            // Last resort — programmatic scroll (least stealthy)
            await page.evaluate((delta: number) => window.scrollBy(0, delta), totalDelta);
        }
    }
}

/**
 * Occasional idle mouse movements — simulates a human reading the page.
 * Called between scroll cycles to add behavioral entropy.
 */
async function idleMouseJitter(page: any, log: Logger) {
    try {
        const viewport = page.viewportSize() || { width: 1280, height: 800 };
        const moves = randInt(1, 3);
        for (let i = 0; i < moves; i++) {
            const x = randInt(200, viewport.width - 200);
            const y = randInt(150, viewport.height - 150);
            await humanMouseMove(page, x, y, log);
            await randomSleep(50, 200);
        }
    } catch {
        // Non-critical
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const params: any = {
        keyword: '', maxAds: config.maxAdsPerDay, dailyLimit: config.maxAdsPerDay,
        customConfig: {}, missionId: null, resumeDate: null,
        filters: { country: config.country }
    };
    let keywordParts: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const currentArg = args[i];
        if (!currentArg) continue;
        if (currentArg === '--max-ads' && i + 1 < args.length) { params.maxAds = parseInt(args[++i] || '1000'); }
        else if (currentArg === '--daily-limit' && i + 1 < args.length) { params.dailyLimit = parseInt(args[++i] || '5000'); }
        else if (currentArg === '--language' && i + 1 < args.length) { params.filters.language = args[++i]; }
        else if (currentArg === '--advertiser' && i + 1 < args.length) { params.filters.advertiser = args[++i]; }
        else if (currentArg === '--platforms' && i + 1 < args.length) { params.filters.platforms = args[++i]?.split(',') || []; }
        else if (currentArg === '--media-type' && i + 1 < args.length) { params.filters.mediaType = args[++i]; }
        else if (currentArg === '--active-status' && i + 1 < args.length) { params.filters.activeStatus = args[++i]; }
        else if (currentArg === '--start-date' && i + 1 < args.length) { params.filters.startDate = args[++i]; }
        else if (currentArg === '--end-date' && i + 1 < args.length) { params.filters.endDate = args[++i]; }
        else if (currentArg === '--country' && i + 1 < args.length) { params.filters.country = args[++i]; }
        else if (currentArg === '--mission-id' && i + 1 < args.length) { params.missionId = args[++i]; }
        else if (currentArg === '--resume-date' && i + 1 < args.length) {
            const dateVal = args[++i];
            if (dateVal) params.resumeDate = new Date(dateVal);
        }
        else if (currentArg.startsWith('--')) continue;
        else keywordParts.push(currentArg);
    }
    params.keyword = keywordParts.join(' ');
    return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Scraper Entry
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeAds(keyword: string, maxAds: number, dailyLimit: number, filters?: any, missionId?: string | null, resumeDate: Date | null = null) {
    const startTime = Date.now();
    const executionId = missionId || `scrape_${keyword}_${startTime}`;
    const log = new Logger(executionId);
    let userId: string | null = null;

    if (missionId) {
        const mission = await getMissionById(missionId);
        if (mission && mission.userId != null) userId = mission.userId;
        log.info(`Mission lookup: ${mission ? 'found' : 'NOT FOUND'}, userId: "${userId}"`);
    }

    let browser: any = null, context: any = null, page: any = null;
    let healthCheckTimer: any = null, memoryCleanupTimer: any = null;

    const stats = {
        savedCount: 0, duplicateCount: 0, processedCount: 0,
        scrollAttempts: 0, errorCount: 0, memoryCleanups: 0,
        lastProgressTime: Date.now(), batchesProcessed: 0,
    };

    try {
        // ── Browser Launch ──
        // REMOVED: --disable-web-security (detectable via CORS behavior)
        // REMOVED: --disable-gpu (causes WebGL fingerprint mismatch)
        // KEPT: --disable-blink-features=AutomationControlled (stealth plugin also adds this)
        log.info('Launching browser', { headless: config.headless, maxAds, dailyLimit });
        browser = await chromium.launch({
            headless: config.headless,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                // Realistic window size (not the default 800x600)
                '--window-size=1920,1080',
            ]
        });

        // ── Browser Context ──
        // Updated UA to current Chrome version. The stealth plugin's user-agent-override
        // will also strip "HeadlessChrome" and set proper Client Hints on top of this.
        const currentChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
        context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: currentChromeUA,
            locale: 'en-US',
            timezoneId: 'Asia/Kolkata',
            // DO NOT set ignoreHTTPSErrors — detectable through error handling behavior
        });
        page = await context.newPage();

        // ── Smart Resource Blocking ──
        // Block only heavy media (video/audio) — allow images and fonts to load normally.
        // Blocking images creates a detectable abnormal resource pattern.
        // Facebook uses tracking pixels in images — blocking them is a strong bot signal.
        await page.route('**/*', (route: any) => {
            const type = route.request().resourceType();
            // Only block video and audio — these are heavy and never needed for scraping
            if (['media'].includes(type)) {
                return route.abort();
            }
            return route.continue();
        });

        // ── Inject Helpers (Hidden from enumeration) ──
        // CRITICAL FIX: Uses Symbol-keyed + non-enumerable properties instead of
        // plain window.__findAdCards which any FB script can detect.
        await page.addInitScript(() => {
            (globalThis as any).__name = (globalThis as any).__name || ((t: any, _v?: any) => t);

            // Use a Symbol so these don't appear in for...in or Object.keys(window)
            const SYM = Symbol.for('__fb_scraper_internal__');

            const getAdRoot = function(): Element {
                const main = document.querySelector('[role="main"]');
                if (main) return main;
                const adLibraryContent = document.querySelector('[data-testid="ad_library_main_content"]');
                if (adLibraryContent) return adLibraryContent;
                const searchResults = document.querySelector('[data-testid="search_results_container"]');
                if (searchResults) return searchResults;
                return document.body || document.documentElement;
            };

            const findAdCards = function(root?: Element): Element[] {
                let searchRoot = root || getAdRoot();
                if (!searchRoot || !searchRoot.querySelectorAll) {
                    searchRoot = document.body || document.documentElement;
                }
                if (!searchRoot) return [];

                const testIdCards = searchRoot.querySelectorAll('[data-testid="fb-ad-library-ad-card"]');
                if (testIdCards.length > 0) return Array.from(testIdCards);

                const allLinks = searchRoot.querySelectorAll('a, span, div');
                const adDetailContainers: Element[] = [];
                const seen = new Set<Element>();
                for (const link of allLinks) {
                    const text = (link.textContent || '').trim().toLowerCase();
                    if (text === 'see ad details' || text === 'ad details' || text === 'see summary details') {
                        let parent: Element | null = link as Element;
                        for (let i = 0; i < 12 && parent; i++) {
                            parent = parent.parentElement;
                            if (!parent || parent === searchRoot || parent === document.body) break;
                            const rect = parent.getBoundingClientRect();
                            if (rect.width > 200 && rect.height > 100) {
                                const parentEl = parent.parentElement;
                                if (parentEl && !seen.has(parent)) {
                                    seen.add(parent);
                                    adDetailContainers.push(parent);
                                }
                                break;
                            }
                        }
                    }
                }
                if (adDetailContainers.length > 0) return adDetailContainers;

                if (searchRoot !== document.body) {
                    const classCards = searchRoot.querySelectorAll('div.xh8yej3, div.x1plvlek');
                    const filtered: Element[] = Array.from<Element>(classCards).filter((c) => (c.textContent || '').length > 50);
                    if (filtered.length > 0) return filtered;
                }

                const allDivs = document.querySelectorAll('div');
                for (const div of allDivs) {
                    const children = Array.from(div.children);
                    if (children.length < 3 || children.length > 200) continue;
                    let cardLikeCount = 0;
                    for (const child of children) {
                        const hasLink = child.querySelector('a');
                        const textLen = (child.textContent || '').length;
                        const rect = child.getBoundingClientRect();
                        if (hasLink && textLen > 100 && rect.height > 80) cardLikeCount++;
                    }
                    if (cardLikeCount >= 3 && cardLikeCount / children.length > 0.6) {
                        return children.filter((child: Element) => {
                            const hasLink = child.querySelector('a');
                            const textLen = (child.textContent || '').length;
                            return hasLink && textLen > 100;
                        });
                    }
                }
                return [];
            };

            // Store on window via Symbol — invisible to Object.keys, for..in, JSON.stringify
            Object.defineProperty(window, SYM, {
                value: { getAdRoot, findAdCards },
                enumerable: false,
                configurable: false,
                writable: false,
            });

            // Additional fingerprint hardening
            // Spoof navigator.deviceMemory (not covered by stealth plugin)
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,  // 8GB — common for desktop
                enumerable: true,
                configurable: true,
            });

            // Spoof navigator.connection (not covered by stealth plugin)
            if (!(navigator as any).connection) {
                Object.defineProperty(navigator, 'connection', {
                    get: () => ({
                        effectiveType: '4g',
                        rtt: 50,
                        downlink: 10,
                        saveData: false,
                    }),
                    enumerable: true,
                    configurable: true,
                });
            }

            // Prevent WebRTC IP leak
            const origRTCPeerConnection = (window as any).RTCPeerConnection;
            if (origRTCPeerConnection) {
                (window as any).RTCPeerConnection = function(...args: any[]) {
                    // Strip STUN/TURN servers to prevent IP leak
                    if (args[0] && args[0].iceServers) {
                        args[0].iceServers = [];
                    }
                    return new origRTCPeerConnection(...args);
                };
                (window as any).RTCPeerConnection.prototype = origRTCPeerConnection.prototype;
            }
        });

        // ── Additional anti-detection via CDP ──
        // Set proper Accept-Language and other headers that stealth might miss with Playwright
        try {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Network.setExtraHTTPHeaders', {
                headers: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'DNT': '1',
                    'Sec-CH-UA': '"Chromium";v="133", "Not(A:Brand";v="99", "Google Chrome";v="133"',
                    'Sec-CH-UA-Mobile': '?0',
                    'Sec-CH-UA-Platform': '"Windows"',
                }
            });
            await cdp.detach();
        } catch {
            log.debug('CDP header injection skipped (non-critical)');
        }

        page.setDefaultTimeout(scraperConfig.elementWaitTimeout);
        page.setDefaultNavigationTimeout(scraperConfig.navigationTimeout);

        // Health check timer
        healthCheckTimer = setInterval(() => {
            const stallMs = Date.now() - stats.lastProgressTime;
            if (stallMs > 600000) log.warn(`No progress for ${Math.round(stallMs / 60000)}m`);
            if (Date.now() - startTime > scraperConfig.maxExecutionTime) {
                log.error('Max execution time exceeded — aborting');
                throw new Error('Max execution time exceeded');
            }
            log.checkResources();
        }, scraperConfig.healthCheckInterval);

        memoryCleanupTimer = setInterval(() => performMemoryCleanup(log, stats), 120000);

        const url = filters && Object.keys(filters).length > 0 ? getSearchUrlWithFilters(keyword, filters) : getSearchUrl(keyword, filters?.country);
        log.info('Navigating to Ad Library', { url, filters });
        await navigateWithRetry(page, url, log);
        await dismissPopups(page, log);
        await waitForResultsWithRetry(page, log);
        await dismissPopups(page, log);

        // Initial mouse movement — a real user moves their mouse after page load
        await humanMouseMove(page, randInt(300, 900), randInt(200, 600), log);
        await randomSleep(500, 1500);

        await performEnhancedScraping(page, keyword, maxAds, dailyLimit, log, stats, resumeDate, userId);

        if (missionId) {
            await updateMission(missionId, {
                status: 'completed', adsFound: stats.processedCount, newAds: stats.savedCount,
                duplicatesSkipped: stats.duplicateCount, adsProcessed: stats.processedCount, endTime: new Date()
            });
        }

        log.printSummary(stats);
        const resultJson = { saved: stats.savedCount, duplicates: stats.duplicateCount, processed: stats.processedCount };
        console.log(`[MISSION_RESULT_JSON] ${JSON.stringify(resultJson)}`);

    } catch (error: any) {
        log.error('Scrape failed', error, { saved: stats.savedCount, processed: stats.processedCount });
        await savePartialResults(log, stats, keyword, maxAds, dailyLimit, error, missionId);
        log.printSummary(stats);
    } finally {
        await cleanupResources(browser, context, page, healthCheckTimer, memoryCleanupTimer, log);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol accessor — used by all evaluate() calls to access hidden helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Code snippet injected into every evaluate() to access the Symbol-keyed helpers. */
const GET_HELPERS = `
    const _sym = Symbol.for('__fb_scraper_internal__');
    const _h = window[_sym] || {};
    const _findCards = _h.findAdCards || (() => []);
    const _getRoot = _h.getAdRoot || (() => document.body);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Batch Extraction
// ─────────────────────────────────────────────────────────────────────────────

async function extractAllCardsInBrowser(page: any, startIndex: number, batchSize: number): Promise<Array<{ advertiser: string; description: string; phone: string | null }>> {
    return await page.evaluate(({ startIdx, size }: { startIdx: number; size: number }) => {
        const results: Array<{ advertiser: string; description: string; phone: string | null }> = [];
        const _sym = Symbol.for('__fb_scraper_internal__');
        const _h = (window as any)[_sym] || {};
        const _findCards = _h.findAdCards || (() => []);

        let allCards: Element[] = [];
        try { allCards = _findCards() || []; } catch { return results; }

        const end = Math.min(startIdx + size, allCards.length);
        for (let i = startIdx; i < end; i++) {
            const card = allCards[i];
            if (!card) continue;
            try {
                let advertiser = '';
                const header = card.querySelector('h4, h3');
                if (header) advertiser = (header.textContent || '').trim();

                if (!advertiser) {
                    const links = card.querySelectorAll('a[role="link"], a[href*="facebook.com"], span[role="button"], a');
                    const skipTexts = ['sponsored', 'active', 'inactive', 'see ad details', 'ad details', 'see summary details', 'learn more'];
                    for (const link of links) {
                        const t = (link.textContent || '').trim();
                        if (t.length > 1 && t.length < 100 && !skipTexts.includes(t.toLowerCase())) { advertiser = t; break; }
                    }
                }

                if (!advertiser) {
                    const bold = card.querySelector('span[style*="font-weight: 600"], span[style*="font-weight: bold"]');
                    if (bold) advertiser = (bold.textContent || '').trim();
                }
                if (!advertiser) advertiser = 'Unknown';

                let description = '';
                const descEl = card.querySelector('div[style*="white-space: pre-wrap"]');
                if (descEl) {
                    description = (descEl.textContent || '').trim();
                } else {
                    const divs = card.querySelectorAll('div, span');
                    let longestText = '';
                    for (const d of divs) {
                        const t = (d.textContent || '').trim();
                        if (t.length > longestText.length && t.length > 20 && t !== advertiser) longestText = t;
                    }
                    description = longestText;
                }

                let phone: string | null = null;
                const phoneMatch = description.match(/(?:\+91[\-\s]?)?[6-9]\d{9}/);
                if (phoneMatch) phone = phoneMatch[0];

                results.push({ advertiser, description, phone });
            } catch { /* skip */ }
        }
        return results;
    }, { startIdx: startIndex, size: batchSize });
}

// ─────────────────────────────────────────────────────────────────────────────
// Card Count & DOM Pruning
// ─────────────────────────────────────────────────────────────────────────────

async function getCardCount(page: any): Promise<number> {
    return await page.evaluate(() => {
        try {
            const _sym = Symbol.for('__fb_scraper_internal__');
            const _h = (window as any)[_sym] || {};
            if (_h.findAdCards) return _h.findAdCards().length;
            return 0;
        } catch { return 0; }
    });
}

async function pruneProcessedCards(page: any, keepCount: number, log: Logger): Promise<number> {
    try {
        const pruned = await page.evaluate((keep: number) => {
            try {
                const _sym = Symbol.for('__fb_scraper_internal__');
                const _h = (window as any)[_sym] || {};
                if (!_h.findAdCards) return 0;
                const cards = _h.findAdCards();
                if (!cards || cards.length <= keep) return 0;
                const removeCount = cards.length - keep;
                for (let i = 0; i < removeCount; i++) { if (cards[i]) cards[i].remove(); }
                return removeCount;
            } catch { return 0; }
        }, keepCount);
        if (pruned > 0) log.info(`Pruned ${pruned} DOM nodes (kept last ${keepCount})`);
        return pruned;
    } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLLING — Mouse wheel simulation with human-like behavior
//
// KEY DESIGN:
// 1. Uses CDP Input.dispatchMouseEvent(mouseWheel) — produces trusted events
// 2. Variable tick sizes (80-140px) mimicking real mouse notch scrolling
// 3. Micro-pauses with occasional "reading stops" between ticks
// 4. Random mouse jitter between scroll cycles
// 5. Forward-only — never scrolls back to top
// 6. Nudge recovery uses tiny backward wheel + forward (not scrollTo)
// ─────────────────────────────────────────────────────────────────────────────

async function scrollForMoreContent(page: any, log: Logger, stats: any): Promise<boolean> {
    const scrollStart = Date.now();

    // Snapshot before scrolling
    const [prevHeight, prevCardCount] = await page.evaluate(() => {
        const _sym = Symbol.for('__fb_scraper_internal__');
        const _h = (window as any)[_sym] || {};
        let cc = 0;
        try { if (_h.findAdCards) cc = _h.findAdCards().length; } catch {}
        return [document.body.scrollHeight, cc];
    });

    // ── Phase 1: Human-like wheel scroll ──
    // Total distance: 2000-4000px in realistic mouse wheel ticks
    const totalScrollPx = randInt(2000, 4000);
    await humanWheelScroll(page, totalScrollPx, log);

    // Small random pause after scrolling (human looking at content)
    await randomSleep(300, 800);

    // ── Phase 2: Wait for content — MutationObserver + polling ──
    const loaded = await page.evaluate(
        (opts: { prevCards: number; prevH: number; timeout: number }) => {
            return new Promise<boolean>(resolve => {
                let settled = false;
                const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };

                const _sym = Symbol.for('__fb_scraper_internal__');
                const _h = (window as any)[_sym] || {};
                const checkNew = () => {
                    let cc = 0;
                    try { if (_h.findAdCards) cc = _h.findAdCards().length; } catch {}
                    return cc > opts.prevCards || document.body.scrollHeight > opts.prevH;
                };
                if (checkNew()) { finish(true); return; }

                let obs: MutationObserver | null = null;
                try {
                    const target = document.querySelector('[role="main"]') || document.body;
                    obs = new MutationObserver(() => {
                        if (checkNew()) { obs?.disconnect(); finish(true); }
                    });
                    obs.observe(target, { childList: true, subtree: true });
                } catch {}

                const poll = setInterval(() => {
                    if (checkNew()) { clearInterval(poll); obs?.disconnect(); finish(true); }
                }, 300);

                setTimeout(() => { clearInterval(poll); obs?.disconnect(); finish(false); }, opts.timeout);
            });
        },
        { prevCards: prevCardCount, prevH: prevHeight, timeout: scraperConfig.scrollWaitTimeout }
    );

    if (loaded) {
        const elapsed = Date.now() - scrollStart;
        const newCC = await getCardCount(page);
        log.info(`Scroll OK: cards ${prevCardCount}->${newCC} (+${newCC - prevCardCount}), waited ${elapsed}ms`);
        log.recordScroll(true, elapsed);
        return true;
    }

    // ── Phase 3: Nudge recovery via mouse wheel (backward + forward) ──
    log.debug('No content after scroll. Trying wheel nudge...');
    await humanWheelScroll(page, -200, log);   // Small backward wheel
    await randomSleep(600, 1200);
    await humanWheelScroll(page, 400, log);    // Forward wheel

    const nudgeLoaded = await page.evaluate(
        (opts: { prevCards: number; prevH: number; timeout: number }) => {
            return new Promise<boolean>(resolve => {
                let settled = false;
                const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
                const _sym = Symbol.for('__fb_scraper_internal__');
                const _h = (window as any)[_sym] || {};
                const checkNew = () => {
                    let cc = 0;
                    try { if (_h.findAdCards) cc = _h.findAdCards().length; } catch {}
                    return cc > opts.prevCards || document.body.scrollHeight > opts.prevH;
                };
                if (checkNew()) { finish(true); return; }
                const poll = setInterval(() => {
                    if (checkNew()) { clearInterval(poll); finish(true); }
                }, 200);
                setTimeout(() => { clearInterval(poll); finish(false); }, opts.timeout);
            });
        },
        { prevCards: prevCardCount, prevH: prevHeight, timeout: 3000 }
    );

    if (nudgeLoaded) {
        const elapsed = Date.now() - scrollStart;
        log.info(`Nudge recovery succeeded (${elapsed}ms)`);
        log.recordScroll(true, elapsed);
        log.recordNudgeRecovery();
        return true;
    }

    // ── Phase 4: Popup check ──
    const popupDismissed = await dismissPopups(page, log);
    if (popupDismissed) {
        await humanWheelScroll(page, 300, log);
        const afterPopup = await page.evaluate(
            (opts: { prevCards: number; prevH: number }) => {
                const _sym = Symbol.for('__fb_scraper_internal__');
                const _h = (window as any)[_sym] || {};
                let cc = 0;
                try { if (_h.findAdCards) cc = _h.findAdCards().length; } catch {}
                return cc > opts.prevCards || document.body.scrollHeight > opts.prevH;
            },
            { prevCards: prevCardCount, prevH: prevHeight }
        );
        if (afterPopup) {
            const elapsed = Date.now() - scrollStart;
            log.info(`Popup recovery succeeded (${elapsed}ms)`);
            log.recordScroll(true, elapsed);
            log.recordPopupRecovery();
            return true;
        }
    }

    const elapsed = Date.now() - scrollStart;
    log.recordScroll(false, elapsed);
    return false;
}

function getBackoffDelay(consecutiveFailures: number): number {
    return Math.round(Math.min(
        scraperConfig.scrollBackoffBaseMs * Math.pow(1.5, Math.min(consecutiveFailures, 10)),
        scraperConfig.scrollBackoffMaxMs
    ));
}

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Scraping Loop
// ─────────────────────────────────────────────────────────────────────────────

async function performEnhancedScraping(page: any, keyword: string, maxAds: number, dailyLimit: number, log: Logger, stats: any, resumeDate: Date | null, userId: string | null = null) {
    if (resumeDate) await performSafetyScroll(page, resumeDate, log);

    const maxEmptyBatchPatience = Math.max(5, Math.min(15, Math.ceil(maxAds / 1000)));
    const maxPageRefreshes = Math.max(2, Math.min(6, Math.ceil(maxAds / 2000)));
    let emptyBatchPatience = 0;
    let pageRefreshCount = 0;

    log.info('Scraping started', {
        maxAds, dailyLimit,
        emptyPatience: maxEmptyBatchPatience, maxRefreshes: maxPageRefreshes,
        scrollStallThreshold: scraperConfig.scrollStallThreshold,
        scrollMaxConsecutiveFails: scraperConfig.scrollMaxConsecutiveFails,
    });

    const adBuffer: Array<{ advertiser: string; description: string; phone: string | null }> = [];
    const FLUSH_THRESHOLD = 50;

    const flushAdBuffer = async () => {
        if (adBuffer.length === 0) return;
        const flushStart = Date.now();
        try {
            const result = await saveAdsBulk(
                adBuffer.map(ad => ({ advertiser: ad.advertiser, description: ad.description, keyword, phone: ad.phone })),
                userId
            );
            for (let i = 0; i < adBuffer.length; i++) {
                if (result.newFlags[i]) {
                    stats.savedCount++;
                    console.log(`✅ [${log.executionId}] NEW AD [${stats.savedCount}/${maxAds}]: [${adBuffer[i]?.advertiser}]`);
                } else {
                    stats.duplicateCount++;
                }
            }
            if (result.saved > 0) {
                log.info(`Bulk flush: +${result.saved} new, ${result.duplicates} dupes`, {
                    saved: stats.savedCount, target: maxAds, flushMs: Date.now() - flushStart,
                });
            }
        } catch (e: any) {
            log.warn(`Bulk save failed, falling back: ${e.message}`);
            for (const ad of adBuffer) {
                try {
                    if (await saveAd(ad.advertiser, ad.description, keyword, ad.phone, null, null, userId)) {
                        stats.savedCount++;
                        console.log(`✅ [${log.executionId}] NEW AD [${stats.savedCount}/${maxAds}]: [${ad.advertiser}]`);
                    } else {
                        stats.duplicateCount++;
                    }
                } catch { /* skip */ }
            }
        }
        adBuffer.length = 0;
    };

    const DOM_PRUNE_THRESHOLD = 500;
    const DOM_KEEP_COUNT = 50;
    const POPUP_CHECK_INTERVAL = 10;
    const MOUSE_JITTER_INTERVAL = 5;  // Add mouse movement every N batches

    while (stats.savedCount < maxAds && stats.scrollAttempts < scraperConfig.maxScrollAttempts) {
        stats.lastProgressTime = Date.now();

        if (stats.batchesProcessed > 0 && stats.batchesProcessed % scraperConfig.memoryCleanupInterval === 0) {
            await performMemoryCleanup(log, stats);
        }

        if (stats.batchesProcessed > 0 && stats.batchesProcessed % POPUP_CHECK_INTERVAL === 0) {
            await dismissPopups(page, log);
        }

        // Periodic idle mouse jitter — adds behavioral entropy
        if (stats.batchesProcessed > 0 && stats.batchesProcessed % MOUSE_JITTER_INTERVAL === 0) {
            await idleMouseJitter(page, log);
        }

        if (stats.batchesProcessed > 0 && stats.batchesProcessed % 50 === 0) {
            const res = log.checkResources();
            log.info('Resource checkpoint', { rss: res.rss, heapUsed: res.heapUsed, batch: stats.batchesProcessed });
        }

        let count: number;
        try {
            count = await getCardCount(page);
        } catch (e: any) {
            stats.errorCount++;
            log.error(`Card count error (${stats.errorCount}/${scraperConfig.errorRetryAttempts})`, e);
            if (stats.errorCount >= scraperConfig.errorRetryAttempts) {
                log.error('Too many card count errors — stopping');
                await flushAdBuffer();
                break;
            }
            await randomSleep(1500, 3000);
            continue;
        }

        log.info(`Batch ${stats.batchesProcessed + 1}: ${count} cards, ${stats.processedCount} processed, ${stats.savedCount}/${maxAds} saved`);

        if (count === 0) {
            emptyBatchPatience++;

            if (stats.batchesProcessed === 0 && emptyBatchPatience === 1) {
                const diag = await page.evaluate(() => {
                    const _sym = Symbol.for('__fb_scraper_internal__');
                    const _h = (window as any)[_sym] || {};
                    let findResult = -1;
                    try { if (_h.findAdCards) findResult = _h.findAdCards().length; } catch {}
                    let seeAdDetails = 0;
                    document.querySelectorAll('a, span, div').forEach((el: Element) => {
                        const t = (el.textContent || '').trim().toLowerCase();
                        if (t === 'see ad details' || t === 'ad details') seeAdDetails++;
                    });
                    return {
                        hasMain: !!document.querySelector('[role="main"]'),
                        findResult, bodyTextLength: document.body.textContent?.length || 0,
                        url: location.href,
                        testIdCount: document.querySelectorAll('[data-testid="fb-ad-library-ad-card"]').length,
                        seeAdDetailsCount: seeAdDetails,
                        title: document.title,
                    };
                });
                log.warn('PAGE DIAGNOSTIC (0 cards on first batch)', diag);
            }

            if (emptyBatchPatience >= maxEmptyBatchPatience) {
                if (pageRefreshCount < maxPageRefreshes) {
                    await flushAdBuffer();
                    pageRefreshCount++;
                    log.warn(`Stuck with 0 cards. Page refresh ${pageRefreshCount}/${maxPageRefreshes}`);
                    await refreshPage(page, log);
                    emptyBatchPatience = 0;
                    stats.processedCount = 0;
                    continue;
                }
                log.warn('Max refreshes reached with 0 cards — stopping');
                break;
            }
            stats.scrollAttempts++;
            await scrollForMoreContent(page, log, stats);
            continue;
        }

        emptyBatchPatience = 0;

        const batchSize = Math.min(scraperConfig.batchProcessingSize, count - stats.processedCount);
        if (batchSize <= 0) {
            stats.scrollAttempts++;

            // Human-like reading pause before scrolling for more
            await randomSleep(200, 600);

            const scrollWorked = await scrollForMoreContent(page, log, stats);

            if (!scrollWorked) {
                const consecutiveFails = log.getConsecutiveFailures();
                log.info(`Scroll stall #${consecutiveFails}`, {
                    threshold: scraperConfig.scrollStallThreshold,
                    maxFails: scraperConfig.scrollMaxConsecutiveFails,
                });

                if (consecutiveFails >= scraperConfig.scrollStallThreshold) {
                    const backoff = getBackoffDelay(consecutiveFails - scraperConfig.scrollStallThreshold);
                    log.info(`Applying backoff: ${backoff}ms`);
                    await new Promise(r => setTimeout(r, backoff));
                }

                if (consecutiveFails >= scraperConfig.scrollMaxConsecutiveFails) {
                    if (pageRefreshCount < maxPageRefreshes) {
                        await flushAdBuffer();
                        pageRefreshCount++;
                        log.warn(`Circuit breaker — page refresh ${pageRefreshCount}/${maxPageRefreshes}`);
                        await refreshPage(page, log);
                        stats.processedCount = 0;
                        continue;
                    }
                    log.warn('Exhausted all attempts — stopping');
                    break;
                }
            }
            continue;
        }

        let extractedAds;
        try {
            extractedAds = await extractAllCardsInBrowser(page, stats.processedCount, batchSize);
        } catch (e: any) {
            stats.errorCount++;
            log.error(`Extraction error (${stats.errorCount}/${scraperConfig.errorRetryAttempts})`, e);
            if (stats.errorCount >= scraperConfig.errorRetryAttempts) {
                log.error('Too many extraction errors — stopping');
                await flushAdBuffer();
                break;
            }
            await randomSleep(1500, 3000);
            continue;
        }

        for (const adData of extractedAds) {
            adBuffer.push({ advertiser: adData.advertiser, description: adData.description, phone: adData.phone });
            stats.processedCount++;
        }
        stats.batchesProcessed++;

        if (adBuffer.length >= FLUSH_THRESHOLD) await flushAdBuffer();

        if (stats.processedCount > DOM_PRUNE_THRESHOLD) {
            const pruned = await pruneProcessedCards(page, DOM_KEEP_COUNT, log);
            if (pruned > 0) stats.processedCount = DOM_KEEP_COUNT;
        }

        if (stats.savedCount > 0 && stats.savedCount % scraperConfig.refreshInterval === 0) {
            await flushAdBuffer();
            log.info(`Stability refresh at ${stats.savedCount} ads`);
            await refreshPage(page, log);
            stats.processedCount = 0;
            continue;
        }

        if (stats.savedCount < maxAds && stats.processedCount >= count) {
            stats.scrollAttempts++;
            await randomSleep(150, 400); // Brief pause before scrolling
            await scrollForMoreContent(page, log, stats);
        } else if (stats.savedCount >= maxAds) break;

        if (stats.batchesProcessed % scraperConfig.dailyLimitCheckInterval === 0) {
            if ((await getStats(userId)) >= dailyLimit) {
                log.info('Daily limit reached — stopping');
                break;
            }
        }
    }

    await flushAdBuffer();
    if (stats.scrollAttempts >= scraperConfig.maxScrollAttempts) {
        log.warn(`Max scroll attempts (${scraperConfig.maxScrollAttempts}) reached`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page Refresh Helper
// ─────────────────────────────────────────────────────────────────────────────

async function refreshPage(page: any, log: Logger) {
    const refreshStart = Date.now();
    try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: scraperConfig.navigationTimeout });
    } catch {
        log.warn('Page reload timed out — continuing');
    }
    await randomSleep(2000, 4000);
    await dismissPopups(page, log);
    await waitForResultsWithRetry(page, log).catch(() => {});
    await dismissPopups(page, log);
    // Move mouse after reload — humans do this
    await humanMouseMove(page, randInt(300, 900), randInt(200, 500), log);
    log.info(`Page refreshed in ${Date.now() - refreshStart}ms`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function performMemoryCleanup(log: Logger, stats: any) {
    if (global.gc) global.gc();
    stats.memoryCleanups++;
    const res = log.checkResources();
    log.info(`Memory cleanup #${stats.memoryCleanups}`, { rss: res.rss, heapUsed: res.heapUsed, heapTotal: res.heapTotal });
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling & Resource Cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function savePartialResults(log: Logger, stats: any, _kw: string, _max: number, _daily: number, err: any, mId?: string | null) {
    if (mId) {
        try {
            await updateMission(mId, {
                status: 'failed', error: err.message, adsFound: stats.processedCount,
                newAds: stats.savedCount, duplicatesSkipped: stats.duplicateCount, endTime: new Date()
            });
        } catch (dbErr) { log.error('Failed to save partial results', dbErr); }
    }
}

async function cleanupResources(browser: any, context: any, page: any, h: any, m: any, log: Logger) {
    if (h) clearInterval(h);
    if (m) clearInterval(m);
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    log.info('Browser resources cleaned up');
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

async function navigateWithRetry(page: any, url: string, log: Logger) {
    const startNav = Date.now();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: scraperConfig.navigationTimeout });
        log.info(`DOM loaded in ${Date.now() - startNav}ms`);
    } catch {
        log.warn('DOM load timeout, trying commit...');
        try {
            await page.goto(url, { waitUntil: 'commit', timeout: scraperConfig.navigationTimeout });
            log.info(`Page committed in ${Date.now() - startNav}ms`);
        } catch (err2: any) {
            log.error('Navigation failed', err2);
            throw err2;
        }
    }
    await randomSleep(1500, 3000); // Variable wait instead of fixed 2000ms
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup Dismissal
// ─────────────────────────────────────────────────────────────────────────────

async function dismissPopups(page: any, log: Logger): Promise<boolean> {
    try {
        const dismissed = await page.evaluate(() => {
            const buttons = document.querySelectorAll('div[role="button"], button, span[role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (text === 'OK' || text === 'Ok' || text === 'ok') {
                    const parent = btn.closest('div[role="dialog"], div[role="alertdialog"]');
                    if (parent) {
                        const parentText = (parent.textContent || '').toLowerCase();
                        if (parentText.includes('ad blocker') || parentText.includes('turn off')) {
                            (btn as HTMLElement).click();
                            return 'ad_blocker';
                        }
                    }
                    let walker: Element | null = btn as Element;
                    for (let i = 0; i < 8 && walker; i++) {
                        walker = walker.parentElement;
                        if (walker) {
                            const wText = (walker.textContent || '').toLowerCase();
                            if (wText.includes('ad blocker') || wText.includes('turn off ad blocker')) {
                                (btn as HTMLElement).click();
                                return 'ad_blocker_fallback';
                            }
                        }
                    }
                }
            }
            const closeButtons = document.querySelectorAll('[aria-label="Close"], [aria-label="close"]');
            for (const btn of closeButtons) {
                const dialog = btn.closest('div[role="dialog"]');
                if (dialog) { (btn as HTMLElement).click(); return 'generic_dialog'; }
            }
            return null;
        });
        if (dismissed) {
            log.info(`Dismissed popup: ${dismissed}`);
            await randomSleep(800, 1500);
            return true;
        }
    } catch { /* non-critical */ }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wait for Initial Results
// ─────────────────────────────────────────────────────────────────────────────

async function waitForResultsWithRetry(page: any, log: Logger) {
    const startWait = Date.now();
    const waitTimeout = Math.max(scraperConfig.elementWaitTimeout, 20000);
    try {
        await page.waitForFunction(() => {
            try {
                const _sym = Symbol.for('__fb_scraper_internal__');
                const _h = (window as any)[_sym] || {};
                if (_h.findAdCards) {
                    const cards = _h.findAdCards();
                    if (cards && cards.length > 0) return true;
                }
            } catch {}
            try {
                const allEls = document.querySelectorAll('a, span, div');
                for (const el of allEls) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t === 'see ad details' || t === 'ad details') return true;
                }
            } catch {}
            try {
                return document.querySelectorAll('[data-testid="fb-ad-library-ad-card"]').length > 0;
            } catch { return false; }
        }, { timeout: waitTimeout });
        log.info(`Results ready in ${Date.now() - startWait}ms`);
    } catch {
        log.warn(`Element wait timeout after ${Date.now() - startWait}ms — continuing`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety Scroll (resume-date)
// ─────────────────────────────────────────────────────────────────────────────

async function performSafetyScroll(page: any, _rd: Date, log: Logger) {
    log.info('Performing safety scroll for resume-date');
    await scrollForMoreContent(page, log, { savedCount: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    const p = parseArgs();
    if (!p.keyword) process.exit(1);
    await scrapeAds(p.keyword, p.maxAds, p.dailyLimit, p.filters, p.missionId, p.resumeDate);
}

main().catch(() => process.exit(1));
