/**
 * Website freshness detection — "kab last update hui?"
 *
 * Combines multiple signals and picks the most recent *trustworthy* date:
 *   1. sitemap.xml <lastmod> tags (most reliable — server-reported)
 *   2. HTTP Last-Modified header on homepage (server file mtime)
 *   3. JSON-LD dateModified in structured data
 *   4. Footer copyright year — LATEST year, but rejected if it equals the
 *      current year AND no other source corroborates (likely auto-generated
 *      via `new Date().getFullYear()`).
 *
 * Returns { lastUpdatedYears, lastUpdatedAt, source } or nulls when undetectable.
 *
 * Score curve (range -5..+5):
 *   < 0.5y: +5
 *   0.5-2y: +3
 *   2-4y:    0
 *   4-7y:   -3
 *   7+y:    -5
 */

const HTTP_TIMEOUT_MS = 4000;

export async function getWebsiteFreshness(websiteUrl, pageText = '') {
    const result = {
        lastUpdatedYears: null,
        lastUpdatedAt: null,
        source: 'unknown',
    };

    if (!websiteUrl) return result;

    let origin = '';
    try {
        const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
        origin = `${u.protocol}//${u.host}`;
    } catch {
        return result;
    }

    // Run all signal lookups in parallel
    const [sitemapDate, lastModDate, jsonLdDate, footerYear] = await Promise.all([
        fetchSitemapLastmod(origin).catch(() => null),
        fetchLastModifiedHeader(websiteUrl).catch(() => null),
        Promise.resolve(extractJsonLdDateModified(pageText)),
        Promise.resolve(extractLatestCopyrightYear(pageText)),
    ]);

    const currentYear = new Date().getFullYear();
    const candidates = [];
    if (sitemapDate) candidates.push({ date: sitemapDate, source: 'sitemap', weight: 3 });
    if (lastModDate) candidates.push({ date: lastModDate, source: 'http-header', weight: 2 });
    if (jsonLdDate) candidates.push({ date: jsonLdDate, source: 'json-ld', weight: 2 });

    // Footer year: trust only if it's NOT the current year, OR another source confirms a recent date
    if (footerYear) {
        const isCurrentYear = footerYear === currentYear;
        const otherSourceRecent = candidates.some(
            (c) => c.date.getFullYear() >= currentYear - 1
        );
        if (!isCurrentYear || otherSourceRecent) {
            candidates.push({
                date: new Date(footerYear, 11, 31), // end-of-year as best estimate
                source: 'footer-copyright',
                weight: 1,
            });
        }
    }

    if (candidates.length === 0) return result;

    // Pick the MOST RECENT date — that's "last updated"
    candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
    const best = candidates[0];

    result.lastUpdatedAt = best.date;
    result.lastUpdatedYears = yearsBetween(best.date, new Date());
    result.source = best.source;
    return result;
}

export function scoreFreshness(years) {
    if (years == null || Number.isNaN(years)) return 0;
    if (years < 0.5) return 5;
    if (years < 2) return 3;
    if (years < 4) return 0;
    if (years < 7) return -3;
    return -5;
}

async function fetchSitemapLastmod(origin) {
    const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
    for (const url of candidates) {
        try {
            const xml = await fetchText(url);
            if (!xml) continue;
            const lastmods = [...xml.matchAll(/<lastmod[^>]*>([^<]+)<\/lastmod>/gi)]
                .map((m) => new Date(m[1].trim()))
                .filter((d) => !Number.isNaN(d.getTime()));
            if (lastmods.length === 0) continue;
            lastmods.sort((a, b) => b.getTime() - a.getTime());
            return lastmods[0];
        } catch {
            // try next
        }
    }
    return null;
}

async function fetchLastModifiedHeader(url) {
    const target = url.startsWith('http') ? url : `https://${url}`;
    try {
        // Try HEAD first (cheap), fallback to GET if not allowed
        let res = await fetchWithTimeout(target, { method: 'HEAD' });
        if (!res.ok || !res.headers.get('last-modified')) {
            res = await fetchWithTimeout(target, { method: 'GET' });
        }
        const header = res.headers.get('last-modified');
        if (!header) return null;
        const d = new Date(header);
        return Number.isNaN(d.getTime()) ? null : d;
    } catch {
        return null;
    }
}

function extractJsonLdDateModified(text) {
    if (!text) return null;
    const matches = [...text.matchAll(/"dateModified"\s*:\s*"([^"]+)"/gi)];
    const dates = matches
        .map((m) => new Date(m[1]))
        .filter((d) => !Number.isNaN(d.getTime()));
    if (dates.length === 0) return null;
    dates.sort((a, b) => b.getTime() - a.getTime());
    return dates[0];
}

function extractLatestCopyrightYear(text) {
    if (!text) return null;
    // Match BOTH "© 2024" and "2024 ©" formats
    const patternA = /(?:©|&copy;|copyright)\s*(?:\(c\)\s*)?(\d{4})(?:\s*[-–—]\s*(\d{4}))?/gi;
    const patternB = /(\d{4})(?:\s*[-–—]\s*(\d{4}))?\s*(?:©|&copy;)/gi;
    const years = [];
    const currentYear = new Date().getFullYear();
    for (const m of text.matchAll(patternA)) {
        const y2 = m[2] ? parseInt(m[2], 10) : null;
        const y1 = parseInt(m[1], 10);
        if (y2 && y2 >= 1995 && y2 <= currentYear + 1) years.push(y2);
        else if (y1 >= 1995 && y1 <= currentYear + 1) years.push(y1);
    }
    for (const m of text.matchAll(patternB)) {
        const y2 = m[2] ? parseInt(m[2], 10) : null;
        const y1 = parseInt(m[1], 10);
        if (y2 && y2 >= 1995 && y2 <= currentYear + 1) years.push(y2);
        else if (y1 >= 1995 && y1 <= currentYear + 1) years.push(y1);
    }
    if (years.length === 0) return null;
    return Math.max(...years);
}

async function fetchText(url) {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return res.text();
}

async function fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...init,
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; LeadCapture/1.0)',
                ...(init.headers || {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

function yearsBetween(from, to) {
    const ms = to.getTime() - from.getTime();
    return Math.max(0, Math.round((ms / (365.25 * 24 * 3600 * 1000)) * 10) / 10);
}
