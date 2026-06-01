import { chromium } from 'playwright';
import { getChromeEndpoint } from './chromeManager.js';

const SYSTEM_CHROME_PATH =
    process.env.CHROME_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_USER_DATA_DIR =
    process.env.CHROME_USER_DATA_DIR ||
    process.env.LEAD_CAPTURE_CHROME_USER_DATA ||
    'C:\\Users\\godwi\\AppData\\Local\\Google\\Chrome\\User Data';
const CHROME_PROFILE_DIR =
    process.env.CHROME_PROFILE_DIR ||
    process.env.LEAD_CAPTURE_CHROME_PROFILE ||
    'Profile 68';
const DEFAULT_UA =
    process.env.AUTOMATION_CHROME_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const STEALTH_INIT_SCRIPT = `
() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  delete Navigator.prototype.webdriver;
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'connection', {
    get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
  });
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ];
      arr.refresh = () => {};
      return arr;
    }
  });
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  }
  const origRTC = window.RTCPeerConnection;
  if (origRTC) {
    window.RTCPeerConnection = function(config, constraints) {
      if (config && config.iceServers) config.iceServers = [];
      return new origRTC(config, constraints);
    };
    window.RTCPeerConnection.prototype = origRTC.prototype;
  }
}
`;

function getLaunchArgs() {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--window-size=1920,1080',
    ];
}

export async function createStealthPage(options = {}) {
    const {
        headless = true,
        storageState,
        viewport = { width: 1920, height: 1080 },
        locale = 'en-US',
        timezoneId = 'Asia/Kolkata',
        userAgent = DEFAULT_UA,
        blockMedia = false,
        preferSystemChrome = true,
        navigationTimeout = 45000,
        defaultTimeout = 30000,
    } = options;

    const session = await createStealthSession({
        headless,
        storageState,
        viewport,
        locale,
        timezoneId,
        userAgent,
        blockMedia: false,
        preferSystemChrome,
        navigationTimeout,
        defaultTimeout,
    });
    const { browser, context, ownsBrowser, ownsContext, mode } = session;

    const page = await context.newPage();
    if (blockMedia) {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (type === 'media' || type === 'websocket') {
                return route.abort();
            }
            return route.continue();
        });
    }

    return {
        browser,
        context,
        page,
        ownsBrowser,
        ownsContext,
        mode,
    };
}

export async function createStealthSession(options = {}) {
    const {
        headless = true,
        storageState,
        viewport = { width: 1920, height: 1080 },
        locale = 'en-US',
        timezoneId = 'Asia/Kolkata',
        userAgent = DEFAULT_UA,
        preferSystemChrome = true,
        useCdp = process.env.AUTOMATION_USE_CDP !== '0',
        navigationTimeout = 45000,
        defaultTimeout = 30000,
    } = options;

    let browser = null;
    let context = null;
    let ownsBrowser = true;
    let ownsContext = true;
    let mode = 'launch';

    if (useCdp) {
        try {
            const cdpEndpoint = await getChromeEndpoint();
            browser = await chromium.connectOverCDP(cdpEndpoint);
            context = browser.contexts()[0] || null;
            if (!context) {
                context = await browser.newContext({
                    viewport,
                    userAgent,
                    locale,
                    timezoneId,
                    javaScriptEnabled: true,
                    ...(storageState ? { storageState } : {}),
                });
                ownsContext = true;
            } else {
                ownsContext = false;
            }
            ownsBrowser = false;
            mode = 'cdp';
        } catch (cdpErr) {
            console.warn(`[BrowserFlow] CDP attach failed, falling back to launch: ${cdpErr?.message || cdpErr}`);
            browser = null;
            context = null;
            ownsBrowser = true;
            ownsContext = true;
            mode = 'launch';
        }
    }

    if (!browser) {
        const launchArgs = getLaunchArgs();
        const persistentArgs = [
            ...launchArgs,
            `--profile-directory=${CHROME_PROFILE_DIR}`,
            '--remote-allow-origins=*',
            '--no-first-run',
            '--no-default-browser-check',
        ];
        try {
            context = await chromium.launchPersistentContext(CHROME_USER_DATA_DIR, {
                headless,
                executablePath: preferSystemChrome ? SYSTEM_CHROME_PATH : undefined,
                viewport,
                userAgent,
                locale,
                timezoneId,
                javaScriptEnabled: true,
                args: persistentArgs,
            });
            browser = context.browser();
        } catch {
            browser = await chromium.launch({
                headless,
                executablePath: preferSystemChrome ? SYSTEM_CHROME_PATH : undefined,
                args: launchArgs,
            });
            context = await browser.newContext({
                viewport,
                userAgent,
                locale,
                timezoneId,
                javaScriptEnabled: true,
                ...(storageState ? { storageState } : {}),
            });
        }
        ownsBrowser = true;
        ownsContext = true;
        mode = 'launch';
    }

    context.setDefaultTimeout(defaultTimeout);
    context.setDefaultNavigationTimeout(navigationTimeout);
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    try {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.setExtraHTTPHeaders', {
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                DNT: '1',
                'Sec-CH-UA': '"Chromium";v="147", "Not)A;Brand";v="99", "Google Chrome";v="147"',
                'Sec-CH-UA-Mobile': '?0',
                'Sec-CH-UA-Platform': '"Windows"',
            },
        });
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
        await cdp.detach();
        await page.close().catch(() => {});
    } catch {
        // Non-blocking.
    }

    return {
        browser,
        context,
        ownsBrowser,
        ownsContext,
        mode,
    };
}

export async function waitForCloudflare(page, timeoutSeconds = 15) {
    for (let i = 0; i < timeoutSeconds * 2; i++) {
        try {
            const body = (await page.innerText('body', { timeout: 2000 })).toLowerCase();
            const challenging = [
                'verify you are human',
                'performing security verification',
                'checking your browser',
                'just a moment',
            ].some((phrase) => body.includes(phrase));
            if (!challenging) {
                return true;
            }
        } catch {
            // Retry.
        }
        await page.waitForTimeout(500);
    }
    return false;
}

export async function randomSleep(minMs = 500, maxMs = 1500) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect whether the current page is on a Cloudflare/anti-bot challenge.
 * Cheap (one innerText read with a short timeout) so we can gate the longer
 * waitForCloudflare polling loop behind it.
 */
export async function isCloudflareChallenge(page) {
    try {
        const [title, body] = await Promise.all([
            page.title().catch(() => ''),
            page.innerText('body', { timeout: 1500 }).catch(() => ''),
        ]);
        const haystack = `${title}\n${body}`.toLowerCase();
        return [
            'just a moment',
            'verify you are human',
            'checking your browser',
            'performing security verification',
            'cloudflare',
            'ddos-guard',
        ].some((p) => haystack.includes(p));
    } catch {
        return false;
    }
}

/**
 * Wait for a homepage to be "fully ready" using adaptive signals instead of
 * fixed sleeps. Resolves as soon as DOM is interactive, body has meaningful
 * content, and either networkidle or the cap is reached. Returns quickly on
 * fast sites; never exceeds `maxMs`.
 */
export async function waitForHomepageReady(page, { maxMs = 8000, settleMs = 600 } = {}) {
    const start = Date.now();
    const remaining = () => Math.max(0, maxMs - (Date.now() - start));

    await page.waitForLoadState('domcontentloaded', { timeout: remaining() }).catch(() => {});

    await page.waitForFunction(
        () => {
            if (document.readyState === 'loading') return false;
            const body = document.body;
            if (!body) return false;
            const text = (body.innerText || '').trim();
            const hasStructure = !!(
                document.querySelector('h1, h2, main, [role="main"], header, nav, img')
            );
            return text.length > 40 || hasStructure;
        },
        { timeout: remaining(), polling: 150 }
    ).catch(() => {});

    await page.waitForLoadState('networkidle', { timeout: Math.min(remaining(), 3000) }).catch(() => {});

    if (settleMs > 0) {
        await page.waitForTimeout(Math.min(settleMs, remaining()));
    }
}
