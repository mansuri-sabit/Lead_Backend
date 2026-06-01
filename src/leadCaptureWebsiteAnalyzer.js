import Tesseract from 'tesseract.js';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createStealthPage, waitForCloudflare, waitForHomepageReady, isCloudflareChallenge } from './browserFlow.js';
import { getWebsiteFreshness, scoreFreshness } from './leadCaptureFreshness.js';
import { recommendServices } from './leadCaptureServicePitch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NAV_TIMEOUT = 25000;
const HEADLESS = process.env.LEAD_CAPTURE_HEADLESS === '1';

// Python OCR bridge script location (PaddleOCR)
const OCR_BRIDGE_SCRIPT = path.resolve(__dirname, '..', 'ocr', 'deepseek_ocr.py');
const VENV_PYTHON = path.resolve(__dirname, '..', 'ocr', '.venv', 'Scripts', 'python.exe');
const PYTHON_BIN = process.env.OCR_PYTHON || process.env.DEEPSEEK_OCR_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python');
// Timeout for Python OCR process
const OCR_BRIDGE_TIMEOUT = parseInt(process.env.OCR_BRIDGE_TIMEOUT || process.env.DEEPSEEK_OCR_TIMEOUT || '45000', 10);

/**
 * Agent 2 — Website Analyzer
 *
 * Opens a website URL, waits for the homepage to fully load,
 * detects alert/popup overlays (Admissions Open, Hiring Now, Now Booking, etc.),
 * captures a screenshot of the popup, runs OCR via Tesseract.js,
 * and scores the lead based on detected intent signals.
 *
 * @param {string} websiteUrl - The URL to analyze
 * @param {string} companyName - For context in scoring
 * @returns {Promise<object>} Analysis result with extracted text, score, and summary
 */
export async function analyzeWebsite(websiteUrl, companyName = '', sharedSession = null, opts = {}) {
    const mapsPhone = opts.mapsPhone || '';
    let browser, context, page;
    const tmpDir = os.tmpdir();
    const usingSharedContext = Boolean(sharedSession?.context);
    let ownsBrowser = true;
    let ownsContext = true;

    // Persistent screenshot dir for this run (served via /screenshots static route)
    const screenshotsRoot = path.resolve(__dirname, '..', 'screenshots');
    const runId = String(opts.runId || 'misc');
    const rowIndex = opts.rowIndex != null ? String(opts.rowIndex) : `r${Date.now()}`;
    const persistentDir = path.join(screenshotsRoot, runId);
    try { fs.mkdirSync(persistentDir, { recursive: true }); } catch {}
    const buildPath = (label) => path.join(persistentDir, `${rowIndex}-${label}.jpg`);
    const buildPublicUrl = (label) => `/screenshots/${runId}/${rowIndex}-${label}.jpg`;

    try {
        console.log(`[Agent2][WebAnalyzer] Analyzing: ${websiteUrl}`);

        if (!websiteUrl || typeof websiteUrl !== 'string') {
            return buildEmptyResult(companyName, websiteUrl, 'No website URL provided');
        }

        // Normalize URL
        let url = websiteUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
            url = 'https://' + url;
        }

        if (usingSharedContext) {
            browser = sharedSession.browser || null;
            context = sharedSession.context;
            page = await context.newPage();
            ownsBrowser = Boolean(sharedSession?.ownsBrowser);
            ownsContext = Boolean(sharedSession?.ownsContext);
        } else {
            ({ browser, context, page, ownsBrowser, ownsContext } = await createStealthPage({
                headless: HEADLESS,
                locale: 'en-US',
                timezoneId: 'Asia/Kolkata',
                viewport: { width: 1920, height: 1080 },
                blockMedia: false,
            }));
        }
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(NAV_TIMEOUT);

        // ── Navigate and wait for full load ──
        console.log(`[Agent2] Loading homepage: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(async (navErr) => {
            console.warn(`[Agent2] Initial goto failed (${navErr.message}), retrying...`);
            await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
        });

        // ── Conditional Cloudflare / Bot Protection Bypass ──
        // Only enter the polling loop if we actually see a challenge.
        // Saves ~20s on the 95% of sites without CF.
        if (await isCloudflareChallenge(page)) {
            console.log('[Agent2] Cloudflare/anti-bot challenge detected — waiting...');
            const cfBypassed = await waitForCloudflare(page, 18);
            if (cfBypassed) {
                console.log('[Agent2] Challenge resolved.');
            }
        }

        // ── Wait for homepage to be fully ready (adaptive, capped at 8s) ──
        await waitForHomepageReady(page, { maxMs: 8000, settleMs: 800 });

        // ── Detect popups / overlays / banners ──
        console.log('[Agent2] Scanning for alert popups and banners...');
        const popupData = await detectPopups(page);

        let ocrText = '';
        let popupScreenshotUrl = null;
        let fullScreenshotUrl = null;

        // ── Take viewport screenshot (JPEG q70 — ~5x smaller than PNG) ──
        const fullScreenPath = buildPath('full');
        try {
            await page.screenshot({ path: fullScreenPath, fullPage: false, type: 'jpeg', quality: 70 });
            fullScreenshotUrl = buildPublicUrl('full');
        } catch (ssErr) {
            console.warn(`[Agent2] Viewport screenshot failed: ${ssErr.message}`);
        }

        // ── Take popup-specific screenshot if DOM popup found ──
        let popupScreenshotPath = null;
        if (popupData.found) {
            console.log(`[Agent2] DOM popup detected: "${popupData.text.slice(0, 100)}..."`);
            popupScreenshotPath = buildPath('popup');
            try {
                if (popupData.elementHandle) {
                    await popupData.elementHandle.screenshot({ path: popupScreenshotPath, type: 'jpeg', quality: 75 });
                } else {
                    await page.screenshot({ path: popupScreenshotPath, fullPage: false, type: 'jpeg', quality: 75 });
                }
                popupScreenshotUrl = buildPublicUrl('popup');
            } catch (popupSsErr) {
                console.warn(`[Agent2] Popup screenshot failed: ${popupSsErr.message}`);
                popupScreenshotPath = null;
            }
        } else {
            console.log('[Agent2] No DOM popup overlay — relying on OCR + deep DOM scan...');
        }

        // ── Scroll down and take below-fold screenshot (kept in tmp; only used for OCR) ──
        let belowFoldPath = null;
        let belowFoldOcr = '';
        try {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
            await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
            belowFoldPath = path.join(tmpDir, `lead-below-${Date.now()}.jpg`);
            await page.screenshot({ path: belowFoldPath, fullPage: false, type: 'jpeg', quality: 70 });
            await page.evaluate(() => window.scrollTo(0, 0));
        } catch {
            // non-critical
        }

        // ── Kick off freshness lookup in parallel with OCR (no wall-time cost) ──
        // Sitemap + Last-Modified header run now; copyright/JSON-LD will be re-checked
        // after deepDomText is available.
        const freshnessPromise = getWebsiteFreshness(url, '').catch((err) => {
            console.warn(`[Agent2] Freshness lookup failed: ${err.message}`);
            return { lastUpdatedYears: null, lastUpdatedAt: null, source: 'unknown' };
        });

        // ── OCR Pipeline: Python PaddleOCR bridge (primary) → Tesseract.js (fallback) ──
        const screenshotsToOcr = [
            { label: 'viewport', path: fullScreenPath },
            popupScreenshotPath ? { label: 'popup', path: popupScreenshotPath } : null,
            belowFoldPath ? { label: 'below-fold', path: belowFoldPath } : null,
        ].filter(Boolean);

        const ocrResults = [];
        for (const shot of screenshotsToOcr) {
            if (!shot.path || !fs.existsSync(shot.path)) continue;

            const result = await runOcr(shot.path, shot.label);
            ocrResults.push(result);
            console.log(`[Agent2] OCR [${shot.label}] via ${result.method}: ${result.text.length} chars`);
            if (result.text.length > 0) {
                console.log(`[Agent2] OCR [${shot.label}] sample: "${result.text.slice(0, 200).replace(/\n/g, ' ')}"`);
            }
        }

        // Combine all OCR texts
        ocrText = ocrResults.map(r => r.text).filter(Boolean).join('\n');
        belowFoldOcr = ocrResults.find(r => r.label === 'below-fold')?.text || '';
        const ocrMethod = ocrResults[0]?.method || 'none';
        console.log(`[Agent2] Combined OCR: ${ocrText.length} chars via ${ocrMethod}`);

        // Clean up below-fold tmp file only (full + popup are persisted under /screenshots).
        if (belowFoldPath && fs.existsSync(belowFoldPath)) {
            try { fs.unlinkSync(belowFoldPath); } catch {}
        }

        // ── Full page DOM text scan for signals ──
        const pageSignals = await scanPageForSignals(page);

        // ── Tech profile scan: chat widgets, WhatsApp, forms, mobile, jQuery, CMS ──
        const tech = await detectTechProfile(page);
        console.log(`[Agent2] Tech profile: chat=${tech.hasChatWidget} wa=${tech.hasWhatsAppLink} forms=${tech.formCount} mobile=${tech.hasMobileViewport} jq=${tech.jqueryVersion || '-'}`);

        // ── Deep DOM extraction: sliders, carousels, meta tags, hidden text ──
        // This catches "ADMISSION OPEN" text hidden inside hero sliders, marquees,
        // image alt/title attributes, meta descriptions, and JS-rendered carousel captions.
        const deepDomText = await deepExtractPageText(page);
        console.log(`[Agent2] Deep DOM extraction: ${deepDomText.length} chars`);
        if (deepDomText.length > 0) {
            console.log(`[Agent2] Deep DOM sample: "${deepDomText.slice(0, 300).replace(/\n/g, ' ')}"`);
        }

        // Combine ALL text sources: DOM popup + OCR viewport + OCR below-fold + DOM signals + deep DOM
        const allText = [popupData.text, ocrText, belowFoldOcr, pageSignals.signalText, deepDomText]
            .filter(Boolean)
            .join('\n')
            .trim();

        // Detect if ANY source found visual popup signals that the DOM popup detector missed
        const combinedOcrAndDom = [ocrText, belowFoldOcr, deepDomText].join(' ');
        const signalInContent = /admission[s]?\s*open|hiring\s*now|now\s*booking|enroll\s*now|book\s*now|registration\s*open|enrollment\s*open|apply\s*now|new\s*batch|open\s*for\s*admission/i.test(combinedOcrAndDom);
        const effectivePopupDetected = popupData.found || (!popupData.found && signalInContent);
        const effectivePopupType = popupData.found ? popupData.type : (signalInContent ? 'image-banner' : 'none');

        if (!popupData.found && signalInContent) {
            console.log('[Agent2] Deep extraction / OCR detected intent signal that DOM popup scan missed');
        }

        // ── Resolve freshness; re-run with deepDomText to pick up footer/JSON-LD signals ──
        let freshness = await freshnessPromise;
        const reFreshness = await getWebsiteFreshness(url, deepDomText).catch(() => null);
        if (reFreshness && reFreshness.lastUpdatedAt) {
            // Prefer the more-recent / higher-confidence result between the two passes
            const a = freshness.lastUpdatedAt ? new Date(freshness.lastUpdatedAt).getTime() : 0;
            const b = new Date(reFreshness.lastUpdatedAt).getTime();
            if (b >= a) freshness = reFreshness;
        }
        const freshnessScore = scoreFreshness(freshness.lastUpdatedYears);
        if (freshness.lastUpdatedYears != null) {
            console.log(`[Agent2] Last updated ~${freshness.lastUpdatedYears}y ago via ${freshness.source} → freshnessScore ${freshnessScore}`);
        }

        // ── Scoring ──
        const scoring = scoreLeadSignals(allText, effectivePopupDetected, companyName);
        const finalScore = Math.max(-5, Math.min(10, scoring.score + freshnessScore));

        // ── Service pitch recommendations (Troika services) ──
        const recommendedServices = recommendServices({
            freshnessYears: freshness.lastUpdatedYears,
            freshnessScore,
            signals: scoring.signals,
            mapsPhone,
            popupDetected: effectivePopupDetected,
            tech,
            leadScore: finalScore,
        });
        if (recommendedServices.length > 0) {
            console.log(`[Agent2] Top pitches: ${recommendedServices.map((r) => `${r.service}(${r.confidence}%)`).join(', ')}`);
        }

        const freshnessNote = freshness.lastUpdatedYears != null
            ? ` Last updated ~${freshness.lastUpdatedYears}y ago (${freshness.source}); freshness ${freshnessScore >= 0 ? '+' : ''}${freshnessScore}.`
            : '';

        const result = {
            websiteUrl: url,
            companyName,
            popupDetected: effectivePopupDetected,
            popupType: effectivePopupType,
            extractedText: allText.slice(0, 5000),
            ocrText: ocrText.slice(0, 3000),
            interpretedMeaning: scoring.meaning,
            score: finalScore,
            signals: scoring.signals,
            summary: scoring.summary + freshnessNote,
            popupScreenshot: popupScreenshotUrl,
            fullScreenshot: fullScreenshotUrl,
            pageTitle: await page.title().catch(() => ''),
            lastUpdatedYears: freshness.lastUpdatedYears,
            lastUpdatedAt: freshness.lastUpdatedAt,
            freshnessSource: freshness.source,
            freshnessScore,
            techProfile: tech,
            recommendedServices,
            analyzedAt: new Date().toISOString(),
        };

        console.log(`[Agent2] Analysis complete — Score: ${result.score} (signals ${scoring.score}, freshness ${freshnessScore}), Signals: [${result.signals.join(', ')}]`);
        return result;
    } catch (error) {
        console.error(`[Agent2] Website analysis failed for "${websiteUrl}":`, error.message);
        return buildEmptyResult(companyName, websiteUrl, error.message);
    } finally {
        // Close persistent context cleanly after each run.
        if (page) await page.close().catch(() => {});
        if (!usingSharedContext && ownsContext && context) await context.close().catch(() => {});
        if (!usingSharedContext && ownsBrowser && browser) await browser.close().catch(() => {});
    }
}

/**
 * Detect popups, modals, overlays, sticky banners, and alert bars on the page.
 */
/**
 * Deep DOM extraction — goes far beyond innerText to find text hidden in:
 * - Carousel / slider captions (Slick, Swiper, Owl, Bootstrap, custom)
 * - Marquee / ticker elements
 * - Image alt, title, aria-label attributes
 * - Meta tags (description, og:title, og:description, keywords)
 * - Page <title>
 * - Hidden/offscreen elements (visibility:hidden, display:none, opacity:0)
 * - Data attributes containing text (data-caption, data-text, data-title)
 * - Link text and button text
 * - Inline style background images alt text
 *
 * This catches "ADMISSION OPEN" rendered as hero image overlay text,
 * carousel slide captions, or text inside elements not visible in the viewport.
 */
/**
 * Run OCR on an image file.
 * Pipeline: Python PaddleOCR bridge (high quality) → Tesseract.js (fast fallback)
 *
 * @param {string} imagePath - Absolute path to the screenshot PNG
 * @param {string} label - Label for logging (e.g. 'viewport', 'popup')
 * @returns {Promise<{text: string, method: string, label: string}>}
 */
async function runOcr(imagePath, label = 'image') {
    // ── Try Python OCR bridge first ──
    if (fs.existsSync(OCR_BRIDGE_SCRIPT)) {
        try {
            console.log(`[Agent2] Trying Python OCR bridge on ${label}...`);
            const bridgeResult = await runPythonOcrBridge(imagePath);
            if (bridgeResult.success && bridgeResult.text && bridgeResult.text.length > 5) {
                return { text: bridgeResult.text, method: bridgeResult.method || 'paddleocr', label };
            }
            console.log('[Agent2] Python OCR bridge returned empty/short text, falling back to Tesseract');
        } catch (bridgeErr) {
            console.warn(`[Agent2] Python OCR bridge failed for ${label}: ${bridgeErr.message}`);
        }
    }

    // ── Fallback: Tesseract.js ──
    try {
        console.log(`[Agent2] Running Tesseract OCR on ${label}...`);
        const result = await Tesseract.recognize(imagePath, 'eng', { logger: () => {} });
        return { text: result.data.text || '', method: 'tesseract', label };
    } catch (tessErr) {
        console.warn(`[Agent2] Tesseract OCR failed for ${label}: ${tessErr.message}`);
        return { text: '', method: 'none', label };
    }
}

/**
 * Spawn the Python OCR bridge script and return parsed result.
 * The script outputs a JSON line to stdout with { success, text, method }.
 */
function runPythonOcrBridge(imagePath) {
    return new Promise((resolve, reject) => {
        const proc = execFile(
            PYTHON_BIN,
            [OCR_BRIDGE_SCRIPT, imagePath],
            {
                timeout: OCR_BRIDGE_TIMEOUT,
                maxBuffer: 10 * 1024 * 1024, // 10MB for large OCR output
                env: { ...process.env },
            },
            (error, stdout, stderr) => {
                if (stderr) {
                    // OCR bridge logs progress to stderr — print it
                    for (const line of stderr.split('\n').filter(Boolean)) {
                        console.log(`  [OCR-Bridge] ${line}`);
                    }
                }

                if (error) {
                    return reject(new Error(`Python OCR process failed: ${error.message}`));
                }

                // Parse the last JSON line from stdout (script prints exactly one JSON line)
                const lines = stdout.trim().split('\n').filter(Boolean);
                const lastLine = lines[lines.length - 1] || '';
                try {
                    const result = JSON.parse(lastLine);
                    resolve(result);
                } catch (parseErr) {
                    reject(new Error(`Failed to parse OCR bridge output: ${lastLine.slice(0, 200)}`));
                }
            }
        );

        // If the process takes too long, the timeout in execFile handles it
        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn Python: ${err.message}. Is Python installed?`));
        });
    });
}

async function deepExtractPageText(page) {
    return await page.evaluate(() => {
        const chunks = [];

        // 1. Page title
        chunks.push(document.title || '');

        // 2. Meta tags
        const metaSelectors = [
            'meta[name="description"]',
            'meta[property="og:title"]',
            'meta[property="og:description"]',
            'meta[name="keywords"]',
            'meta[name="twitter:title"]',
            'meta[name="twitter:description"]',
        ];
        for (const sel of metaSelectors) {
            const el = document.querySelector(sel);
            if (el) chunks.push(el.getAttribute('content') || '');
        }

        // 3. All image alt and title attributes
        const imgs = document.querySelectorAll('img[alt], img[title]');
        for (const img of imgs) {
            const alt = img.getAttribute('alt') || '';
            const title = img.getAttribute('title') || '';
            if (alt.length > 3) chunks.push(alt);
            if (title.length > 3) chunks.push(title);
        }

        // 4. Carousel / slider / hero section text (covers most slider libraries)
        const sliderSelectors = [
            // Generic slider/carousel containers
            '.slider', '.carousel', '.swiper', '.slick-slider', '.owl-carousel',
            '.hero', '.hero-section', '.hero-banner', '.banner', '.main-banner',
            '[class*="slider"]', '[class*="carousel"]', '[class*="swiper"]',
            '[class*="hero"]', '[class*="banner"]', '[class*="marquee"]',
            // Bootstrap carousel
            '.carousel-item', '.carousel-caption',
            // Slick
            '.slick-slide', '.slick-track',
            // Swiper
            '.swiper-slide', '.swiper-wrapper',
            // Owl
            '.owl-item', '.owl-stage',
            // Generic slide classes
            '[class*="slide"]', '[class*="caption"]',
            // Admission-specific sections
            '[class*="admission"]', '[class*="enroll"]', '[class*="recruit"]',
            '[class*="hiring"]', '[class*="booking"]', '[class*="announce"]',
        ];

        const seenTexts = new Set();
        for (const sel of sliderSelectors) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const text = el.textContent?.trim() || '';
                    // Only include if has enough text and is not a duplicate
                    if (text.length > 5 && text.length < 5000 && !seenTexts.has(text.slice(0, 100))) {
                        seenTexts.add(text.slice(0, 100));
                        chunks.push(text);
                    }
                }
            } catch {
                // continue
            }
        }

        // 5. Data attributes that often contain slider/popup text
        const dataAttrs = ['data-caption', 'data-text', 'data-title', 'data-content',
            'data-description', 'data-subtitle', 'data-heading', 'data-slide-text',
            'aria-label', 'title'];
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
            for (const attr of dataAttrs) {
                const val = el.getAttribute(attr);
                if (val && val.length > 5 && val.length < 1000) {
                    chunks.push(val);
                }
            }
        }

        // 6. Marquee elements (still used by some school/govt sites)
        const marquees = document.querySelectorAll('marquee, [class*="marquee"], [class*="ticker"], [class*="scroll-text"]');
        for (const m of marquees) {
            const text = m.textContent?.trim() || '';
            if (text.length > 5) chunks.push(text);
        }

        // 7. Hidden/offscreen elements (display:none, visibility:hidden, opacity:0)
        // These often contain slider text not yet visible
        const hiddenEls = document.querySelectorAll('[style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"], .hidden, .d-none, [hidden]');
        for (const el of hiddenEls) {
            const text = el.textContent?.trim() || '';
            if (text.length > 10 && text.length < 3000) {
                chunks.push(text);
            }
        }

        // 8. Links and buttons text (CTAs like "Apply Now", "Enroll Now")
        const ctas = document.querySelectorAll('a, button, [role="button"], input[type="submit"]');
        for (const el of ctas) {
            const text = (el.textContent || el.getAttribute('value') || '').trim();
            if (text.length >= 4 && text.length < 200) {
                chunks.push(text);
            }
        }

        // 9. Full body innerText (truncated) as final fallback
        const bodyText = document.body?.innerText || '';
        chunks.push(bodyText.slice(0, 10000));

        // 10. Full page HTML source scan — catch text in inline styles, scripts setting text, etc.
        const html = document.documentElement.outerHTML || '';
        // Extract any quoted strings containing admission/hiring/booking signals
        const htmlSignalMatches = html.match(
            /["']([^"']*(?:admission[s]?\s*open|hiring\s*now|now\s*booking|enroll\s*now|apply\s*now|registration\s*open|enrollment\s*open|new\s*batch|open\s*for\s*admission|book\s*now)[^"']*)["']/gi
        );
        if (htmlSignalMatches) {
            for (const m of htmlSignalMatches) {
                chunks.push(m.replace(/^["']|["']$/g, ''));
            }
        }

        return chunks.filter(Boolean).join('\n').slice(0, 15000);
    }).catch(() => '');
}

async function detectPopups(page) {
    return await page.evaluate(() => {
        const extractPopupText = (el) => {
            if (!el) return '';
            const heading = Array.from(el.querySelectorAll('h1,h2,h3,h4,.modal-title,[id*="lblHeading"]'))
                .map((n) => (n.textContent || '').trim())
                .filter(Boolean)
                .join(' | ');
            const body = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const links = Array.from(el.querySelectorAll('a[href]'))
                .map((a) => {
                    const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
                    const href = (a.getAttribute('href') || '').trim();
                    return txt || href ? `${txt}${href ? ` -> ${href}` : ''}` : '';
                })
                .filter(Boolean)
                .slice(0, 10)
                .join(' | ');
            return [heading, body, links].filter(Boolean).join(' | ').slice(0, 3000);
        };

        const result = {
            found: false,
            text: '',
            type: 'none',
            selector: '',
        };

        // ── Strategy 1: Modal / dialog overlays ──
        const modalSelectors = [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '.modal.show',
            '.modal.in',
            '.modal[style*="display: block"]',
            '.modal[style*="display:block"]',
            '.modal.active',
            '.modal-content',
            '.popup',
            '.popup-overlay',
            '.overlay-modal',
            '#popup',
            '.lightbox',
            '.fancybox-container',
            '[data-dismiss="modal"]',
            '[class*="modal"][class*="open"]',
            '[class*="modal"][class*="show"]',
            '[class*="popup"][class*="active"]',
            '[class*="popup"][class*="visible"]',
            '[class*="dialog"][class*="open"]',
        ];

        for (const sel of modalSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null && (el.textContent || '').trim().length > 10) {
                result.found = true;
                // Prefer content container if selector points to wrapper/button.
                const container =
                    el.closest('.modal-content,[role="dialog"],.popup,.lightbox') ||
                    el.querySelector('.modal-content,.modal-body,[role="document"]') ||
                    el;
                result.text = extractPopupText(container);
                result.type = 'modal';
                result.selector = sel;
                return result;
            }
        }

        // ── Strategy 2: Fixed/sticky positioned overlays ──
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            const style = window.getComputedStyle(el);
            const isOverlay =
                (style.position === 'fixed' || style.position === 'sticky') &&
                parseFloat(style.zIndex) > 100 &&
                el.offsetWidth > 200 &&
                el.offsetHeight > 100;

            if (isOverlay) {
                const text = el.textContent?.trim() || '';
                const signalPattern =
                    /admissions?\s*open|hiring\s*now|now\s*booking|enroll\s*now|register\s*now|apply\s*now|limited\s*seats|open\s*house|join\s*us|subscribe|sign\s*up|book\s*now|schedule\s*a?\s*tour|free\s*trial|get\s*started|contact\s*us|enquire?\s*now|limited\s*offer|early\s*bird|scholarship|vacancy|vacancies|openings?\s*available|we.?re\s*hiring|job\s*openings?|career|new\s*batch|open\s*for\s*admission/i;

                if (signalPattern.test(text)) {
                    result.found = true;
                    result.text = text.slice(0, 3000);
                    result.type = 'overlay';
                    result.selector = el.tagName + (el.className ? '.' + el.className.split(' ')[0] : '');
                    return result;
                }
            }
        }

        // ── Strategy 3: Banner / notification bars ──
        const bannerSelectors = [
            '[class*="banner"]',
            '[class*="notification"]',
            '[class*="alert"]',
            '[class*="announcement"]',
            '[class*="topbar"]',
            '[class*="promo"]',
            '[class*="cta"]',
            '[role="banner"]',
            '[role="alert"]',
        ];

        const signalRegex =
            /admissions?\s*open|hiring\s*now|now\s*booking|enroll|register\s*now|apply\s*now|limited\s*seats|book\s*now|enquire|open\s*house|new\s*batch/i;

        for (const sel of bannerSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (el.offsetParent !== null) {
                    const text = el.textContent?.trim() || '';
                    if (signalRegex.test(text) && text.length > 10 && text.length < 2000) {
                        result.found = true;
                        result.text = text.slice(0, 3000);
                        result.type = 'banner';
                        result.selector = sel;
                        return result;
                    }
                }
            }
        }

        return result;
    });
}

/**
 * Tech profile scan — detects chat widgets, WhatsApp links, form count,
 * mobile viewport meta, jQuery version, and CMS hints. Used by the service
 * pitch recommender. Pure page-side DOM read; ~50ms.
 */
async function detectTechProfile(page) {
    return await page.evaluate(() => {
        const out = {
            hasChatWidget: false,
            chatWidget: null,
            hasWhatsAppLink: false,
            formCount: 0,
            hasMobileViewport: false,
            jqueryVersion: '',
            cmsHints: [],
        };

        // Chat widgets — selectors AND known global vars
        const chatSelectors = [
            '#intercom-frame', '.intercom-launcher', '[id^="intercom-"]',
            '#tawkchat-container', '.tawk-min-container', '[id^="tawk-"]',
            '.crisp-client', '#crisp-chatbox',
            'iframe[src*="zopim"]', 'iframe[src*="zendesk"]', '.zEWidget-launcher',
            'iframe[src*="drift.com"]', '.drift-frame-controller',
            'iframe[src*="tidio"]', '#tidio-chat',
            'iframe[src*="freshchat"]', '#fc_frame',
            'iframe[src*="livechatinc"]', '#chat-widget-container',
            'iframe[src*="hubspot"][src*="chat"]',
            '[class*="chat-widget"]', '[class*="chatbot"]', '[id*="chatbot"]',
        ];
        for (const sel of chatSelectors) {
            if (document.querySelector(sel)) {
                out.hasChatWidget = true;
                out.chatWidget = sel;
                break;
            }
        }
        if (!out.hasChatWidget) {
            const w = window;
            if (w.Intercom || w.Tawk_API || w.$crisp || w.zE || w.drift || w.tidioChatApi || w.fcWidget || w.LC_API || w.HubSpotConversations) {
                out.hasChatWidget = true;
                out.chatWidget = 'global-var';
            }
        }

        // WhatsApp link
        out.hasWhatsAppLink = !!document.querySelector(
            'a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="web.whatsapp.com"], a[href^="whatsapp:"]'
        );

        // Forms
        out.formCount = document.querySelectorAll('form').length;

        // Mobile viewport
        out.hasMobileViewport = !!document.querySelector('meta[name="viewport"]');

        // jQuery version
        try {
            if (window.jQuery?.fn?.jquery) out.jqueryVersion = String(window.jQuery.fn.jquery);
            else if (window.$?.fn?.jquery) out.jqueryVersion = String(window.$.fn.jquery);
        } catch {
            // ignore
        }

        // CMS hints
        const generator = document.querySelector('meta[name="generator"]');
        if (generator) out.cmsHints.push(generator.getAttribute('content') || '');
        const html = document.documentElement.outerHTML;
        if (/wp-content|wp-includes/.test(html)) out.cmsHints.push('WordPress');
        if (/sites\/all\/modules|drupal\.js/i.test(html)) out.cmsHints.push('Drupal');
        if (/shopify\.com|cdn\.shopify/.test(html)) out.cmsHints.push('Shopify');
        if (/wix\.com|static\.wixstatic/.test(html)) out.cmsHints.push('Wix');
        if (/squarespace\.com|squarespace-cdn/.test(html)) out.cmsHints.push('Squarespace');

        return out;
    }).catch(() => ({
        hasChatWidget: false,
        chatWidget: null,
        hasWhatsAppLink: false,
        formCount: 0,
        hasMobileViewport: false,
        jqueryVersion: '',
        cmsHints: [],
    }));
}

/**
 * Scan the full page for intent signals even without a popup.
 */
async function scanPageForSignals(page) {
    return await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const truncated = bodyText.slice(0, 10000);

        const signalPatterns = [
            { pattern: /admissions?\s*open/gi, signal: 'admissions_open' },
            { pattern: /hiring\s*now|we.?re\s*hiring|job\s*openings?|career\s*opportunit/gi, signal: 'hiring' },
            { pattern: /now\s*booking|book\s*(?:now|today|online)/gi, signal: 'booking_open' },
            { pattern: /enroll\s*now|enrollment\s*open/gi, signal: 'enrollment_open' },
            { pattern: /register\s*now|registration\s*open/gi, signal: 'registration_open' },
            { pattern: /apply\s*now|applications?\s*open/gi, signal: 'applications_open' },
            { pattern: /limited\s*seats|seats?\s*available|few\s*seats/gi, signal: 'limited_availability' },
            { pattern: /open\s*house|campus\s*tour|schedule\s*(?:a\s*)?visit/gi, signal: 'open_house' },
            { pattern: /free\s*trial|get\s*started|start\s*free/gi, signal: 'free_trial' },
            { pattern: /new\s*batch|batch\s*starting|upcoming\s*batch/gi, signal: 'new_batch' },
            { pattern: /scholarship|financial\s*aid/gi, signal: 'scholarship' },
            { pattern: /early\s*bird|limited\s*(?:time\s*)?offer|special\s*offer/gi, signal: 'special_offer' },
            { pattern: /vacancy|vacancies|openings?\s*available/gi, signal: 'vacancies' },
            { pattern: /enquire?\s*now|contact\s*(?:us|now)|get\s*in\s*touch/gi, signal: 'contact_cta' },
            { pattern: /under\s*construction|coming\s*soon|launching\s*soon/gi, signal: 'coming_soon' },
        ];

        const found = [];
        const matchedTexts = [];

        for (const { pattern, signal } of signalPatterns) {
            const matches = truncated.match(pattern);
            if (matches && matches.length > 0) {
                found.push(signal);
                matchedTexts.push(...matches.slice(0, 3));
            }
        }

        return {
            signals: found,
            signalText: matchedTexts.join(' | '),
        };
    });
}

/**
 * Score the lead based on detected signals and extracted text.
 *
 * Score range: 0-10
 *  - 0: No actionable signals
 *  - 1-3: Weak signals (generic CTAs like "contact us")
 *  - 4-6: Moderate signals (enrollment open, hiring page exists)
 *  - 7-10: Strong signals (popup with admissions, active hiring banner, booking open)
 */
function scoreLeadSignals(allText, hasPopup, companyName) {
    const text = (allText || '').toLowerCase();
    const signals = [];
    let score = 0;

    // High-intent signals (each worth 2-3 points)
    const highIntent = [
        { regex: /admission[s]?\s*open/i, name: 'admissions_open', points: 3 },
        { regex: /hiring\s*now|we.?re\s*hiring/i, name: 'hiring_now', points: 3 },
        { regex: /now\s*booking|book\s*now/i, name: 'booking_open', points: 3 },
        { regex: /enroll\s*now|enrollment\s*open/i, name: 'enrollment_open', points: 3 },
        { regex: /registration\s*open|register\s*now/i, name: 'registration_open', points: 2 },
        { regex: /apply\s*now|applications?\s*open/i, name: 'applications_open', points: 2 },
        { regex: /limited\s*seats|few\s*seats/i, name: 'limited_seats', points: 2 },
        { regex: /new\s*batch|batch\s*starting/i, name: 'new_batch', points: 2 },
    ];

    // Medium-intent signals (each worth 1 point)
    const mediumIntent = [
        { regex: /open\s*house|campus\s*tour/i, name: 'open_house', points: 1 },
        { regex: /scholarship|financial\s*aid/i, name: 'scholarship', points: 1 },
        { regex: /early\s*bird|special\s*offer|limited\s*offer/i, name: 'special_offer', points: 1 },
        { regex: /vacancy|vacancies|job\s*openings?/i, name: 'vacancies', points: 1 },
        { regex: /free\s*trial|get\s*started/i, name: 'free_trial', points: 1 },
        { regex: /enquire?\s*now|contact\s*us/i, name: 'contact_cta', points: 1 },
    ];

    for (const { regex, name, points } of [...highIntent, ...mediumIntent]) {
        if (regex.test(text)) {
            signals.push(name);
            score += points;
        }
    }

    // Popup multiplier: signals in popups are more intentional
    if (hasPopup && signals.length > 0) {
        score = Math.ceil(score * 1.5);
    }

    // Cap at 10
    score = Math.min(10, score);

    // Generate interpreted meaning
    let meaning = '';
    let summary = '';

    if (signals.length === 0) {
        meaning = 'No actionable intent signals detected on the website.';
        summary = `${companyName || 'Business'} website shows no active campaigns or calls to action.`;
    } else {
        const signalDescriptions = {
            admissions_open: 'actively accepting admissions',
            hiring_now: 'actively hiring / recruiting',
            booking_open: 'accepting bookings',
            enrollment_open: 'enrollment is open',
            registration_open: 'registration is open',
            applications_open: 'accepting applications',
            limited_seats: 'limited availability (urgency)',
            new_batch: 'new batch/cohort starting soon',
            open_house: 'hosting open house / tours',
            scholarship: 'offering scholarships / financial aid',
            special_offer: 'running limited-time promotions',
            vacancies: 'has job openings',
            free_trial: 'offering free trials',
            contact_cta: 'actively requesting contact/enquiries',
        };

        const descriptions = signals.map((s) => signalDescriptions[s] || s).slice(0, 5);
        meaning = `Business is ${descriptions.join(', ')}.`;
        summary = `${companyName || 'Business'} shows ${signals.length} intent signal(s): ${descriptions.join('; ')}. ${
            hasPopup ? 'A prominent popup/banner was detected, indicating high priority.' : ''
        } Lead score: ${score}/10.`;
    }

    return { score, signals, meaning, summary };
}

function buildEmptyResult(companyName, websiteUrl, errorMsg) {
    return {
        websiteUrl: websiteUrl || '',
        companyName: companyName || '',
        popupDetected: false,
        popupType: 'none',
        extractedText: '',
        ocrText: '',
        interpretedMeaning: errorMsg || 'Analysis failed',
        score: 0,
        signals: [],
        summary: `Could not analyze website: ${errorMsg}`,
        popupScreenshot: null,
        fullScreenshot: null,
        pageTitle: '',
        lastUpdatedYears: null,
        lastUpdatedAt: null,
        freshnessSource: 'unknown',
        freshnessScore: 0,
        techProfile: {},
        recommendedServices: [],
        analyzedAt: new Date().toISOString(),
    };
}
