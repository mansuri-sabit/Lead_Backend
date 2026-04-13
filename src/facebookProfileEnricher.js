/**
 * Agent 2 — Profile enrichment: opens Facebook profile + About (sk=about),
 * collects phone-like strings, address hints, and external social links.
 * Requires the same logged-in / headless context as Filter Bot (FILTER_BOT_HEADLESS).
 */
import { chromium } from 'playwright';

const HEADLESS = process.env.FILTER_BOT_HEADLESS !== '0';

const SOCIAL_RULES = [
    { platform: 'instagram', host: /(^|\.)instagram\.com$/i },
    { platform: 'twitter', host: /(^|\.)twitter\.com$/i },
    { platform: 'x', host: /(^|\.)x\.com$/i },
    { platform: 'tiktok', host: /(^|\.)tiktok\.com$/i },
    { platform: 'youtube', host: /(^|\.)youtube\.com$/i },
    { platform: 'linkedin', host: /(^|\.)linkedin\.com$/i },
    { platform: 'whatsapp', host: /(^|\.)wa\.me$|(^|\.)whatsapp\.com$/i },
    { platform: 'snapchat', host: /(^|\.)snapchat\.com$/i },
    { platform: 'pinterest', host: /(^|\.)pinterest\.com$/i },
    { platform: 'threads', host: /(^|\.)threads\.net$/i },
    { platform: 'telegram', host: /(^|\.)t\.me$/i }
];

function normalizeFacebookUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let s = input.trim();
    if (!s.startsWith('http')) s = `https://${s}`;
    try {
        const u = new URL(s);
        if (!u.hostname.includes('facebook.com')) return null;
        return u.toString();
    } catch {
        return null;
    }
}

function decodeFacebookRedirect(href) {
    try {
        const u = new URL(href);
        if (u.hostname.includes('facebook.com') && u.pathname.includes('/l.php')) {
            const target = u.searchParams.get('u');
            if (target) return decodeURIComponent(target);
        }
    } catch {
        /* ignore */
    }
    return href;
}

function looksLikeProfileUrl(u) {
    try {
        const url = new URL(u);
        if (!url.hostname.includes('facebook.com')) return false;
        const q = url.search;
        if (q.includes('comment_id=') || q.includes('story_fbid=')) return false;
        if (url.pathname.includes('/permalink.php')) return false;
        if (url.pathname.includes('profile.php')) return true;
        if (url.pathname.includes('/people/')) return true;
        const seg = url.pathname.split('/').filter(Boolean);
        if (seg.length === 1) {
            const bad = new Set([
                'watch',
                'reel',
                'reels',
                'groups',
                'share',
                'marketplace',
                'events',
                'gaming',
                'ads',
                'policies',
                'legal'
            ]);
            return !bad.has(seg[0].toLowerCase());
        }
        if (seg.length === 2 && seg[1].toLowerCase() === 'about') return true;
        return false;
    } catch {
        return false;
    }
}

function buildAboutUrl(profileUrl) {
    const u = new URL(profileUrl);
    u.searchParams.set('sk', 'about');
    return u.toString();
}

function extractPhones(text) {
    if (!text) return [];
    const re =
        /(?:\+?\d{1,4}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}[\s\-.]?\d{0,6})/g;
    const raw = text.match(re) || [];
    const out = [];
    const seen = new Set();
    for (let s of raw) {
        s = s.replace(/\s+/g, ' ').trim();
        const digits = s.replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

function extractAddresses(text) {
    if (!text) return [];
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const keys = [
        /^lives?\s+in\s*[:\s·]/i,
        /^from\s*[:\s·]/i,
        /^current\s+city\s*[:\s·]/i,
        /^address\s*[:\s·]/i,
        /^home\s*town\s*[:\s·]/i,
        /^hometown\s*[:\s·]/i
    ];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const re of keys) {
            const m = line.match(re);
            if (m) {
                const rest = line.slice(m[0].length).trim();
                if (rest.length > 2 && rest.length < 300 && !seen.has(rest)) {
                    seen.add(rest);
                    out.push(rest);
                }
            }
        }
        const next = lines[i + 1];
        if (next && /^(lives in|from|current city|address)$/i.test(line) && next.length < 300) {
            if (!seen.has(next)) {
                seen.add(next);
                out.push(next);
            }
        }
    }
    return out.slice(0, 10);
}

function classifySocialUrl(href) {
    let u = decodeFacebookRedirect(href);
    try {
        const url = new URL(u);
        const host = url.hostname.replace(/^www\./, '');
        if (host.includes('facebook.com') || host.includes('fb.com') || host.includes('messenger.com')) {
            return null;
        }
        for (const r of SOCIAL_RULES) {
            if (r.host.test(host)) {
                return { platform: r.platform, url: url.toString() };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function mergeSocialFromHrefs(hrefs) {
    const list = [];
    const seen = new Set();
    for (const h of hrefs) {
        const item = classifySocialUrl(h);
        if (item && !seen.has(item.url)) {
            seen.add(item.url);
            list.push(item);
        }
    }
    return list;
}

async function collectPageSignals(page) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const hrefs = await page
        .$$eval('a[href]', (els) => els.map((a) => a.getAttribute('href')).filter(Boolean))
        .catch(() => []);
    const absolute = [];
    for (const h of hrefs) {
        try {
            absolute.push(new URL(h, 'https://www.facebook.com').href);
        } catch {
            /* skip */
        }
    }
    return { bodyText, hrefs: absolute };
}

async function resolveProfileUrl(page, { profileUrl, anchorHref }) {
    const n = normalizeFacebookUrl(profileUrl);
    if (n && looksLikeProfileUrl(n)) return n;

    if (!anchorHref || typeof anchorHref !== 'string') {
        throw new Error('No usable profile URL and no anchor URL to resolve');
    }

    const target = normalizeFacebookUrl(anchorHref) || anchorHref.trim();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((err) => {
        throw new Error(`Failed to open anchor URL: ${err.message}`);
    });
    await page.waitForTimeout(4000);

    const rawHrefs = await page
        .$$eval('a[href*="facebook.com"]', (els) =>
            els.map((e) => e.getAttribute('href')).filter(Boolean)
        )
        .catch(() => []);

    for (const h of rawHrefs) {
        let full;
        try {
            full = new URL(h, 'https://www.facebook.com').href;
        } catch {
            continue;
        }
        if (looksLikeProfileUrl(full)) return full;
    }

    throw new Error('Could not resolve a profile URL from the anchor page');
}

/**
 * @param {{ profileUrl?: string | null, anchorHref?: string | null }} input
 * @returns {Promise<{
 *   phones: string[],
 *   addresses: string[],
 *   socialLinks: { platform: string, url: string }[],
 *   profileUrlUsed: string,
 *   aboutUrlUsed: string
 * }>}
 */
/**
 * Run multiple profile enrichments in parallel (separate browser per row — watch RAM).
 * @param {Array<{ rowIndex: number, profileUrl: string | null, anchorHref: string | null }>} rows
 * @param {number} [concurrency=3]
 */
export async function enrichFacebookProfilesParallel(rows, concurrency = 3) {
    const results = new Array(rows.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= rows.length) return;
            const row = rows[i];
            try {
                const data = await enrichFacebookProfile({
                    profileUrl: row.profileUrl,
                    anchorHref: row.anchorHref
                });
                results[i] = { ok: true, rowIndex: row.rowIndex, data };
            } catch (err) {
                results[i] = {
                    ok: false,
                    rowIndex: row.rowIndex,
                    error: err?.message || String(err)
                };
            }
        }
    }
    const workers = Math.min(Math.max(1, concurrency), rows.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

export async function enrichFacebookProfile(input = {}) {
    const profileUrlIn = input.profileUrl ?? null;
    const anchorHref = input.anchorHref ?? null;

    let browser;
    let page;

    try {
        console.log(
            `[Agent2] single enrich row profileUrl=${profileUrlIn ? 'yes' : 'no'} anchor=${anchorHref ? 'yes' : 'no'}`
        );
        browser = await chromium.launch({
            headless: HEADLESS,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const context = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 }
        });

        page = await context.newPage();

        const profileUrlUsed = await resolveProfileUrl(page, {
            profileUrl: profileUrlIn,
            anchorHref
        });

        const aboutUrlUsed = buildAboutUrl(profileUrlUsed);

        let combinedText = '';
        const allHrefs = new Set();

        await page.goto(profileUrlUsed, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(3500);
        const p1 = await collectPageSignals(page);
        combinedText += `\n${p1.bodyText}`;
        for (const h of p1.hrefs) allHrefs.add(h);

        await page.goto(aboutUrlUsed, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(3500);
        const p2 = await collectPageSignals(page);
        combinedText += `\n${p2.bodyText}`;
        for (const h of p2.hrefs) allHrefs.add(h);

        const phones = extractPhones(combinedText);
        const addresses = extractAddresses(combinedText);
        const socialLinks = mergeSocialFromHrefs(allHrefs);

        return {
            phones,
            addresses,
            socialLinks,
            profileUrlUsed,
            aboutUrlUsed
        };
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}
