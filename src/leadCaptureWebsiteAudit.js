// Agent 3 — Website Auditor
// Fetches a homepage via plain HTTP, extracts contact info, scans for common
// SEO issues, computes an urgency score, and asks OpenAI to draft a pitch.
// Performance metrics come from locally-run Lighthouse (no API, no quota).

import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import tls from 'node:tls';
import { URL as NodeURL } from 'node:url';

const FETCH_TIMEOUT_MS = 20000;
const HEAD_TIMEOUT_MS = 8000;
const SSL_TIMEOUT_MS = 8000;
const MAX_BROKEN_LINK_CHECKS = 15;
const BROKEN_LINK_CONCURRENCY = 5;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function normalizeUrl(url) {
    if (!url) return '';
    let u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
}

async function fetchHomepage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        });
        const html = await res.text().catch(() => '');
        return {
            httpCode: res.status,
            finalUrl: res.url || url,
            headers: Object.fromEntries(res.headers.entries()),
            html,
        };
    } finally {
        clearTimeout(timer);
    }
}

function stripTags(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractContactInfo(html, headers = {}) {
    const text = stripTags(html);
    const body = html + ' ' + text;

    const emailSet = new Set();
    const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    (body.match(emailRe) || []).forEach((e) => {
        const lower = e.toLowerCase();
        if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.svg') || lower.endsWith('.gif') || lower.endsWith('.webp')) return;
        if (lower.includes('sentry') || lower.includes('wixpress') || lower.includes('example.com')) return;
        emailSet.add(e);
    });

    const phoneSet = new Set();
    const telRe = /href\s*=\s*["']tel:([^"']+)["']/gi;
    let m;
    while ((m = telRe.exec(html))) phoneSet.add(m[1].replace(/\s+/g, '').trim());
    const phoneTextRe = /(\+?\d[\d\s().-]{8,}\d)/g;
    (text.match(phoneTextRe) || []).slice(0, 10).forEach((p) => {
        const digits = p.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) phoneSet.add(p.trim());
    });

    const whatsappLinks = [];
    const waRe = /https?:\/\/(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/[^\s"'<>]+/gi;
    (html.match(waRe) || []).forEach((w) => whatsappLinks.push(w));

    const socialLinks = {};
    const socialPatterns = {
        facebook: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/i,
        instagram: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i,
        linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/i,
        twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/i,
        youtube: /https?:\/\/(?:www\.)?youtube\.com\/[^\s"'<>]+/i,
    };
    for (const [k, re] of Object.entries(socialPatterns)) {
        const hit = html.match(re);
        if (hit) socialLinks[k] = hit[0];
    }

    let address = '';
    const addrTagRe = /<address[^>]*>([\s\S]*?)<\/address>/i;
    const addrTag = html.match(addrTagRe);
    if (addrTag) address = stripTags(addrTag[1]).slice(0, 300);
    if (!address) {
        const postalRe = /\b\d{5,6}\b[^.\n]{0,40}(india|bharat|mumbai|delhi|bangalore|bengaluru|chennai|kolkata|hyderabad|pune|gurugram|noida)\b/i;
        const pm = text.match(postalRe);
        if (pm) address = pm[0].slice(0, 200);
    }

    return {
        emails: Array.from(emailSet).slice(0, 10),
        phones: Array.from(phoneSet).slice(0, 10),
        whatsapp: whatsappLinks.slice(0, 3),
        social: socialLinks,
        address,
    };
}

function extractBuiltYear(html) {
    const text = stripTags(html);
    const rangeRe = /(?:©|&copy;|copyright)\s*(\d{4})\s*[-–—]\s*(\d{4})/i;
    const single = /(?:©|&copy;|copyright)\s*(\d{4})/i;
    const r = text.match(rangeRe);
    if (r) return parseInt(r[1], 10);
    const s = text.match(single);
    if (s) return parseInt(s[1], 10);
    const established = text.match(/(?:established|since|founded)\s+(?:in\s+)?(\d{4})/i);
    if (established) return parseInt(established[1], 10);
    return null;
}

function analyzeSEO(html, finalUrl, headers = {}) {
    const issues = [];
    const lower = html.toLowerCase();

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]).trim() : '';
    if (!title) issues.push({ severity: 'high', label: 'Missing <title> tag' });
    else if (title.length < 15) issues.push({ severity: 'medium', label: `Title too short (${title.length} chars)` });
    else if (title.length > 70) issues.push({ severity: 'low', label: `Title too long (${title.length} chars)` });

    const metaDescRe = /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i;
    const metaDesc = html.match(metaDescRe);
    if (!metaDesc || !metaDesc[1].trim()) {
        issues.push({ severity: 'high', label: 'Missing meta description' });
    } else if (metaDesc[1].length < 50) {
        issues.push({ severity: 'low', label: `Meta description too short (${metaDesc[1].length} chars)` });
    }

    const h1Count = (html.match(/<h1\b/gi) || []).length;
    if (h1Count === 0) issues.push({ severity: 'high', label: 'No <h1> heading' });
    else if (h1Count > 1) issues.push({ severity: 'low', label: `Multiple <h1> tags (${h1Count})` });

    if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) {
        issues.push({ severity: 'high', label: 'No mobile viewport meta (not mobile-friendly)' });
    }

    if (!/^https:/i.test(finalUrl)) {
        issues.push({ severity: 'high', label: 'Site not served over HTTPS' });
    }

    if (!/<meta[^>]+property\s*=\s*["']og:title["']/i.test(html)) {
        issues.push({ severity: 'medium', label: 'Missing Open Graph tags (poor social sharing)' });
    }

    if (!/<link[^>]+rel\s*=\s*["'](?:icon|shortcut icon)["']/i.test(html)) {
        issues.push({ severity: 'low', label: 'Missing favicon' });
    }

    const imgTags = html.match(/<img\b[^>]*>/gi) || [];
    const imgsNoAlt = imgTags.filter((t) => !/\balt\s*=/i.test(t)).length;
    if (imgsNoAlt > 3) {
        issues.push({ severity: 'medium', label: `${imgsNoAlt} images missing alt attributes` });
    }

    if (!/<link[^>]+rel\s*=\s*["']canonical["']/i.test(html)) {
        issues.push({ severity: 'low', label: 'Missing canonical URL' });
    }

    if (lower.includes('jquery-1.') || lower.includes('jquery-2.')) {
        issues.push({ severity: 'medium', label: 'Uses outdated jQuery (security/performance risk)' });
    }

    const sizeKB = Math.round(html.length / 1024);
    if (sizeKB > 800) {
        issues.push({ severity: 'medium', label: `Very heavy HTML payload (${sizeKB} KB)` });
    }

    return { title, metaDescription: metaDesc ? metaDesc[1] : '', issues };
}

// ─── SSL certificate expiry ─────────────────────────────────────────────────

function checkSsl(hostUrl) {
    return new Promise((resolve) => {
        let host;
        try {
            host = new NodeURL(hostUrl).hostname;
        } catch {
            return resolve({ error: 'Invalid URL' });
        }
        if (!host) return resolve({ error: 'No hostname' });

        const socket = tls.connect(
            {
                host,
                port: 443,
                servername: host,
                rejectUnauthorized: false,
                timeout: SSL_TIMEOUT_MS,
            },
            () => {
                const cert = socket.getPeerCertificate(true);
                if (!cert || !cert.valid_to) {
                    socket.destroy();
                    return resolve({ error: 'No certificate' });
                }
                const validTo = new Date(cert.valid_to);
                const validFrom = new Date(cert.valid_from);
                const daysRemaining = Math.round((validTo.getTime() - Date.now()) / 86400000);
                const issuer = cert.issuer?.O || cert.issuer?.CN || '';
                const subject = cert.subject?.CN || '';
                const authorized = socket.authorized;
                const authError = socket.authorizationError ? String(socket.authorizationError) : null;
                socket.destroy();
                resolve({
                    host,
                    issuer,
                    subject,
                    validFrom: validFrom.toISOString(),
                    validTo: validTo.toISOString(),
                    daysRemaining,
                    authorized,
                    authError,
                    error: null,
                });
            }
        );
        socket.on('error', (err) => {
            resolve({ error: err?.message || 'SSL connect failed' });
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ error: 'SSL timeout' });
        });
    });
}

// ─── Tech stack detection (lightweight Wappalyzer-ish) ──────────────────────

function detectTechStack(html, headers = {}, finalUrl = '') {
    const h = (html || '').toLowerCase();
    const hdr = Object.fromEntries(
        Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v || '').toLowerCase()])
    );
    const detected = [];
    const add = (category, name, version = null) => {
        if (!detected.find((d) => d.name === name)) detected.push({ category, name, version });
    };

    // CMS / Site builders
    if (h.includes('/wp-content/') || h.includes('/wp-includes/') || /name=["']generator["']\s+content=["']wordpress/i.test(html)) {
        const m = html.match(/name=["']generator["']\s+content=["']wordpress\s*([\d.]+)?/i);
        add('CMS', 'WordPress', m?.[1] || null);
    }
    if (h.includes('cdn.shopify.com') || h.includes('shopify.theme') || hdr['x-shopify-stage']) add('CMS', 'Shopify');
    if (h.includes('static.wixstatic.com') || hdr['x-wix-request-id']) add('CMS', 'Wix');
    if (h.includes('static1.squarespace.com') || h.includes('squarespace.com')) add('CMS', 'Squarespace');
    if (h.includes('webflow.com') || h.includes('assets.website-files.com')) add('CMS', 'Webflow');
    if (h.includes('/wp-content/plugins/woocommerce')) add('Ecommerce', 'WooCommerce');
    if (h.includes('/wp-content/plugins/elementor')) add('Page Builder', 'Elementor');
    if (h.includes('ghost-sdk')) add('CMS', 'Ghost');
    if (h.includes('drupal-settings-json') || /name=["']generator["']\s+content=["']drupal/i.test(html)) add('CMS', 'Drupal');
    if (h.includes('/sites/default/files') && h.includes('drupal')) add('CMS', 'Drupal');
    if (h.includes('joomla')) add('CMS', 'Joomla');

    // JS frameworks
    if (h.includes('/_next/static/')) add('Framework', 'Next.js');
    if (h.includes('___gatsby') || h.includes('gatsby-chunk-mapping')) add('Framework', 'Gatsby');
    if (h.includes('/_nuxt/')) add('Framework', 'Nuxt.js');
    if (/ng-version=["']([\d.]+)["']/i.test(html)) {
        const m = html.match(/ng-version=["']([\d.]+)["']/i);
        add('Framework', 'Angular', m?.[1] || null);
    }
    if (h.includes('data-reactroot') || h.includes('react-dom') || /__REACT_DEVTOOLS_GLOBAL_HOOK__/i.test(html)) add('Framework', 'React');
    if (h.includes('vue.runtime') || h.includes('data-v-') || h.includes('__vue__')) add('Framework', 'Vue.js');
    if (h.includes('/@remix-run/') || h.includes('__remixcontext')) add('Framework', 'Remix');
    if (h.includes('svelte-')) add('Framework', 'Svelte');

    // Libraries
    const jq = html.match(/jquery[-.]([\d.]+)(?:\.min)?\.js/i);
    if (jq) add('JS Library', 'jQuery', jq[1]);
    else if (h.includes('jquery')) add('JS Library', 'jQuery');
    if (h.includes('bootstrap.min.css') || h.includes('bootstrap.css') || h.includes('bootstrap.min.js')) {
        const b = html.match(/bootstrap[/-]([\d.]+)/i);
        add('UI Framework', 'Bootstrap', b?.[1] || null);
    }
    if (h.includes('tailwind') || /\btw-/i.test(html)) add('UI Framework', 'Tailwind CSS');
    if (h.includes('fontawesome') || h.includes('font-awesome')) add('UI Library', 'Font Awesome');
    if (h.includes('swiper-') || h.includes('swiper.min.js')) add('JS Library', 'Swiper');

    // Analytics / marketing
    if (/gtag\(|googletagmanager\.com\/gtag|UA-\d+|G-[A-Z0-9]+/.test(html)) add('Analytics', 'Google Analytics');
    if (/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i.test(html)) add('Tag Manager', 'Google Tag Manager');
    if (/fbq\(\s*['"]init['"]|connect\.facebook\.net.*fbevents/.test(html)) add('Analytics', 'Facebook Pixel');
    if (h.includes('hotjar')) add('Analytics', 'Hotjar');
    if (h.includes('clarity.ms')) add('Analytics', 'Microsoft Clarity');
    if (h.includes('mixpanel')) add('Analytics', 'Mixpanel');
    if (h.includes('segment.com/analytics.js') || h.includes('cdn.segment.com')) add('Analytics', 'Segment');

    // Chat / engagement
    if (h.includes('tawk.to')) add('Chat', 'Tawk.to');
    if (h.includes('intercom')) add('Chat', 'Intercom');
    if (h.includes('drift.com') || h.includes('js.driftt.com')) add('Chat', 'Drift');
    if (h.includes('crisp.chat')) add('Chat', 'Crisp');
    if (h.includes('zendesk') || h.includes('zdassets')) add('Support', 'Zendesk');
    if (h.includes('freshchat') || h.includes('freshworks')) add('Support', 'Freshchat');

    // CDN / Infra (from headers)
    if (hdr['cf-ray'] || hdr['server']?.includes('cloudflare')) add('CDN', 'Cloudflare');
    if (hdr['x-amz-cf-id'] || hdr['via']?.includes('cloudfront')) add('CDN', 'AWS CloudFront');
    if (hdr['x-fastly-request-id'] || hdr['fastly-debug-digest']) add('CDN', 'Fastly');
    if (hdr['x-vercel-id']) add('Hosting', 'Vercel');
    if (hdr['x-nf-request-id'] || hdr['server']?.includes('netlify')) add('Hosting', 'Netlify');
    if (hdr['x-github-request-id']) add('Hosting', 'GitHub Pages');
    if (hdr['server']) {
        const s = hdr['server'];
        if (s.includes('nginx')) add('Web Server', 'Nginx');
        else if (s.includes('apache')) add('Web Server', 'Apache');
        else if (s.includes('iis')) add('Web Server', 'IIS');
        else if (s.includes('litespeed')) add('Web Server', 'LiteSpeed');
    }
    if (hdr['x-powered-by']) {
        const p = hdr['x-powered-by'];
        if (p.includes('php')) {
            const m = p.match(/php\/([\d.]+)/i);
            add('Language', 'PHP', m?.[1] || null);
        }
        if (p.includes('express')) add('Framework', 'Express');
        if (p.includes('asp.net')) add('Framework', 'ASP.NET');
    }

    // Payments
    if (h.includes('stripe.com') || h.includes('js.stripe.com')) add('Payments', 'Stripe');
    if (h.includes('checkout.razorpay') || h.includes('razorpay.com')) add('Payments', 'Razorpay');
    if (h.includes('paypal.com') || h.includes('paypalobjects.com')) add('Payments', 'PayPal');

    // Fonts
    if (h.includes('fonts.googleapis.com')) add('Fonts', 'Google Fonts');
    if (h.includes('use.typekit.net')) add('Fonts', 'Adobe Fonts');

    // CRM/marketing automation
    if (h.includes('hs-scripts.com') || h.includes('hubspot')) add('Marketing', 'HubSpot');
    if (h.includes('marketo')) add('Marketing', 'Marketo');
    if (h.includes('mailchimp')) add('Marketing', 'Mailchimp');

    void finalUrl; // reserved for future URL-based hints
    return detected;
}

// ─── Broken internal links checker ──────────────────────────────────────────

function extractInternalLinks(html, baseUrl) {
    let base;
    try { base = new NodeURL(baseUrl); } catch { return []; }
    const links = new Set();
    const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
        const raw = m[1].trim();
        if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
        try {
            const u = new NodeURL(raw, base);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
            if (u.hostname !== base.hostname) continue;
            u.hash = '';
            const href = u.toString();
            if (href === baseUrl || href === baseUrl + '/') continue;
            links.add(href);
        } catch { /* skip invalid */ }
    }
    return Array.from(links).slice(0, MAX_BROKEN_LINK_CHECKS);
}

async function headCheck(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
    try {
        let res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': UA },
        });
        // Some servers reject HEAD — retry with GET (Range 0-0 to stay light)
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
            });
        }
        return { url, status: res.status, ok: res.ok || (res.status >= 200 && res.status < 400), finalUrl: res.url || url };
    } catch (err) {
        const name = err?.name || '';
        return {
            url,
            status: 0,
            ok: false,
            error: name === 'AbortError' ? 'Timeout' : (err?.message || 'Fetch failed'),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function checkBrokenLinks(html, baseUrl) {
    const links = extractInternalLinks(html, baseUrl);
    if (links.length === 0) return { total: 0, checked: 0, broken: [], ok: [] };

    const results = [];
    let i = 0;
    async function worker() {
        while (i < links.length) {
            const idx = i++;
            results[idx] = await headCheck(links[idx]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(BROKEN_LINK_CONCURRENCY, links.length) }, worker));

    const broken = results.filter((r) => !r.ok);
    const ok = results.filter((r) => r.ok);
    return { total: links.length, checked: results.length, broken, ok };
}

// ─── Competitor detection + comparison ──────────────────────────────────────

async function suggestCompetitorUrl({ companyName, category, countryHint }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { url: '', error: 'OPENAI_API_KEY not configured' };
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const prompt = `You suggest ONE real competitor's primary website URL for a company.
Return ONLY the bare https URL of the competitor's homepage, nothing else — no text, no quotes, no markdown.
If you cannot think of a clearly real, currently-operating competitor, return the single word NONE.

Company: ${companyName}
${category ? `Category: ${category}` : ''}
${countryHint ? `Region hint: ${countryHint}` : ''}
Avoid suggesting the same company. Prefer a comparable competitor operating in the same region when possible.`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 80,
            }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return { url: '', error: `OpenAI ${res.status}: ${errText.slice(0, 200)}` };
        }
        const data = await res.json();
        const raw = (data?.choices?.[0]?.message?.content || '').trim();
        if (!raw || /^none$/i.test(raw)) return { url: '', error: 'No competitor suggested' };

        // Extract first URL-like token
        const match = raw.match(/https?:\/\/[^\s"'<>()]+/i);
        if (!match) return { url: '', error: `Unparseable: ${raw.slice(0, 80)}` };
        return { url: match[0].replace(/[),.]+$/, ''), error: null, model };
    } catch (err) {
        return { url: '', error: err?.message || 'OpenAI request failed' };
    }
}

async function runCompetitorComparison({ companyName, category, countryHint }) {
    const suggestion = await suggestCompetitorUrl({ companyName, category, countryHint });
    if (!suggestion.url) return { error: suggestion.error || 'No competitor URL', url: '' };

    const target = normalizeUrl(suggestion.url);
    const lh = await runLighthouse(target, 'mobile');
    if (lh?.error) return { url: target, error: lh.error };

    return {
        url: target,
        scores: lh.scores,
        metrics: {
            lcp: lh.metrics?.lcp ?? null,
            lcpDisplay: lh.metrics?.lcpDisplay || '',
            fcp: lh.metrics?.fcp ?? null,
            fcpDisplay: lh.metrics?.fcpDisplay || '',
            cls: lh.metrics?.cls ?? null,
            clsDisplay: lh.metrics?.clsDisplay || '',
            tbt: lh.metrics?.tbt ?? null,
            tbtDisplay: lh.metrics?.tbtDisplay || '',
        },
        suggestionModel: suggestion.model || null,
        error: null,
    };
}

// ─── Lighthouse (local, no API) ─────────────────────────────────────────────

function parseLighthouseResult(lhr, strategy) {
    const cats = lhr.categories || {};
    const audits = lhr.audits || {};
    const toScore = (s) => (typeof s === 'number' ? Math.round(s * 100) : null);

    const scores = {
        performance: toScore(cats.performance?.score),
        accessibility: toScore(cats.accessibility?.score),
        bestPractices: toScore(cats['best-practices']?.score),
        seo: toScore(cats.seo?.score),
    };

    const metrics = {
        fcp: audits['first-contentful-paint']?.numericValue ?? null,
        fcpDisplay: audits['first-contentful-paint']?.displayValue || '',
        lcp: audits['largest-contentful-paint']?.numericValue ?? null,
        lcpDisplay: audits['largest-contentful-paint']?.displayValue || '',
        tbt: audits['total-blocking-time']?.numericValue ?? null,
        tbtDisplay: audits['total-blocking-time']?.displayValue || '',
        cls: audits['cumulative-layout-shift']?.numericValue ?? null,
        clsDisplay: audits['cumulative-layout-shift']?.displayValue || '',
        si: audits['speed-index']?.numericValue ?? null,
        siDisplay: audits['speed-index']?.displayValue || '',
        tti: audits['interactive']?.numericValue ?? null,
        ttiDisplay: audits['interactive']?.displayValue || '',
    };

    const opportunityIds = [
        'render-blocking-resources',
        'unused-css-rules',
        'unused-javascript',
        'uses-optimized-images',
        'modern-image-formats',
        'uses-responsive-images',
        'efficient-animated-content',
        'uses-text-compression',
        'uses-long-cache-ttl',
        'server-response-time',
        'font-display',
        'total-byte-weight',
        'dom-size',
        'mainthread-work-breakdown',
        'bootup-time',
        'duplicated-javascript',
        'legacy-javascript',
    ];

    const opportunities = [];
    for (const id of opportunityIds) {
        const a = audits[id];
        if (!a) continue;
        const score = a.score;
        if (score === null || score === undefined || score >= 0.9) continue;
        const savingsMs = a.details?.overallSavingsMs || a.numericValue || 0;
        const savingsBytes = a.details?.overallSavingsBytes || 0;
        opportunities.push({
            id,
            title: a.title || id,
            displayValue: a.displayValue || '',
            savingsMs: Math.round(savingsMs),
            savingsBytes: Math.round(savingsBytes),
            score,
        });
    }
    opportunities.sort((a, b) => (b.savingsMs + b.savingsBytes / 10) - (a.savingsMs + a.savingsBytes / 10));

    return {
        strategy,
        scores,
        metrics,
        opportunities,
        finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || '',
        fetchTime: lhr.fetchTime || null,
        error: null,
    };
}

async function launchChromeForLighthouse() {
    const chromeFlags = [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--ignore-certificate-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
    ];
    const launchOpts = { chromeFlags };
    if (process.env.LIGHTHOUSE_CHROME_PATH) {
        launchOpts.chromePath = process.env.LIGHTHOUSE_CHROME_PATH;
    } else if (process.env.CHROME_EXECUTABLE_PATH) {
        launchOpts.chromePath = process.env.CHROME_EXECUTABLE_PATH;
    }
    return chromeLauncher.launch(launchOpts);
}

async function runLighthouseOnce(url, strategy) {
    let chrome;
    try {
        chrome = await launchChromeForLighthouse();
        const options = {
            port: chrome.port,
            output: 'json',
            logLevel: 'error',
            onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
            formFactor: strategy === 'desktop' ? 'desktop' : 'mobile',
        };

        const runnerResult = await lighthouse(url, options);
        if (!runnerResult || !runnerResult.lhr) {
            return { error: 'Lighthouse returned no result' };
        }
        if (runnerResult.lhr.runtimeError?.code) {
            return { error: `Lighthouse: ${runnerResult.lhr.runtimeError.code} — ${runnerResult.lhr.runtimeError.message || ''}` };
        }
        return parseLighthouseResult(runnerResult.lhr, strategy);
    } catch (err) {
        return { error: err?.message || String(err) || 'Lighthouse failed' };
    } finally {
        if (chrome) {
            // chrome-launcher's kill() throws EPERM on Windows when cleaning up the temp
            // user-data-dir while chrome.exe is still releasing file locks. Harmless — swallow.
            try { await chrome.kill(); } catch { /* ignore */ }
        }
    }
}

async function runLighthouse(url, strategy = 'mobile') {
    const attempts = 2;
    let lastErr = '';
    for (let i = 0; i < attempts; i++) {
        const result = await runLighthouseOnce(url, strategy);
        if (!result.error) return result;
        lastErr = result.error;
        // Only retry for known transient failures (CDP hiccup, Chrome race on Windows).
        const transient = /performance mark has not been set|Target closed|disconnected|Navigation timeout|net::ERR|NO_FCP|NO_LCP|PROTOCOL_TIMEOUT/i;
        if (!transient.test(lastErr) || i === attempts - 1) break;
        console.warn(`[audit] Lighthouse attempt ${i + 1} failed (${lastErr}), retrying...`);
        await new Promise((r) => setTimeout(r, 1500));
    }
    console.error(`[audit] Lighthouse gave up for ${url}: ${lastErr}`);
    return { error: lastErr };
}

function opportunityToIssue(op) {
    const ms = op.savingsMs || 0;
    const kb = op.savingsBytes ? Math.round(op.savingsBytes / 1024) : 0;
    let severity = 'low';
    if (ms >= 1500 || kb >= 500) severity = 'high';
    else if (ms >= 500 || kb >= 100) severity = 'medium';

    const bits = [];
    if (ms) bits.push(`save ~${ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'}`);
    if (kb) bits.push(`~${kb} KiB`);
    const suffix = bits.length ? ` (${bits.join(', ')})` : '';
    return { severity, label: `${op.title}${suffix}` };
}

function urgencyFromIssues(issues) {
    const weight = { high: 3, medium: 2, low: 1 };
    let score = 0;
    for (const it of issues) score += weight[it.severity] || 1;
    return Math.min(10, score);
}

async function generatePitchMessage({ companyName, websiteUrl, builtYear, issues, contactInfo }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { text: '', error: 'OPENAI_API_KEY not configured' };
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const topIssues = issues.slice(0, 6).map((i) => `- [${i.severity}] ${i.label}`).join('\n') || '- No critical issues detected';
    const email = (contactInfo?.emails || [])[0] || '';

    const prompt = `You are a concise B2B outreach copywriter for Troika Services (web redesign, SEO, AI chat, WhatsApp automation, performance marketing).

Write a short, personalised cold outreach message (max 80 words, plain text, no emoji, no subject line) for the prospect below. Lead with ONE specific issue from their site, then the business benefit of fixing it, and end with a soft CTA. Tone: helpful peer, not salesy. Do not invent facts.

Prospect: ${companyName}
Website: ${websiteUrl}
${builtYear ? `Site appears built around: ${builtYear}` : ''}
${email ? `Contact: ${email}` : ''}

Audit findings:
${topIssues}`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.6,
                max_tokens: 220,
            }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return { text: '', error: `OpenAI ${res.status}: ${errText.slice(0, 200)}` };
        }
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim() || '';
        return { text, error: null, model };
    } catch (err) {
        return { text: '', error: err?.message || 'OpenAI request failed' };
    }
}

/**
 * Runs the full audit on a single website.
 * Returns a plain object ready to persist on LeadCaptureResult.audit.
 */
export async function auditWebsite({ websiteUrl, companyName, category = '', countryHint = '' }) {
    const startedAt = new Date();
    const url = normalizeUrl(websiteUrl);
    if (!url) {
        return {
            status: 'failed',
            error: 'No website URL',
            auditedAt: startedAt,
        };
    }

    let fetched;
    try {
        fetched = await fetchHomepage(url);
    } catch (err) {
        return {
            status: 'failed',
            websiteUrl: url,
            error: err?.message || 'Fetch failed',
            auditedAt: startedAt,
        };
    }

    const { httpCode, html, finalUrl, headers } = fetched;
    const contactInfo = extractContactInfo(html, headers);
    const builtYear = extractBuiltYear(html);
    const seo = analyzeSEO(html, finalUrl, headers);
    const techStack = detectTechStack(html, headers, finalUrl);

    // Run the fast independent checks in parallel (SSL + broken links).
    const [ssl, brokenLinks] = await Promise.all([
        checkSsl(finalUrl).catch((e) => ({ error: e?.message || 'SSL failed' })),
        checkBrokenLinks(html, finalUrl).catch((e) => ({ total: 0, checked: 0, broken: [], ok: [], error: e?.message || 'Link check failed' })),
    ]);

    // Lighthouse on our site — slow (~20-30s).
    const lighthouse = await runLighthouse(finalUrl, 'mobile');

    // Competitor comparison — runs another Lighthouse (~20-30s). Non-blocking failure.
    const competitor = await runCompetitorComparison({ companyName, category, countryHint }).catch((e) => ({ error: e?.message || 'Competitor check failed', url: '' }));

    // Merge all issue sources.
    const issues = [...seo.issues];

    // Lighthouse opportunities
    if (lighthouse && !lighthouse.error && Array.isArray(lighthouse.opportunities)) {
        for (const op of lighthouse.opportunities.slice(0, 8)) {
            issues.push(opportunityToIssue(op));
        }
    }

    // Poor Core Web Vitals → explicit issues
    if (lighthouse && !lighthouse.error && lighthouse.metrics) {
        const m = lighthouse.metrics;
        if (m.lcp != null && m.lcp > 4000) issues.push({ severity: 'high', label: `Slow LCP: ${(m.lcp / 1000).toFixed(1)}s (target < 2.5s)` });
        if (m.cls != null && m.cls > 0.25) issues.push({ severity: 'high', label: `Poor CLS: ${m.cls.toFixed(2)} (target < 0.1)` });
        if (m.tbt != null && m.tbt > 600) issues.push({ severity: 'medium', label: `High TBT: ${Math.round(m.tbt)}ms (target < 200ms)` });
        if (m.fcp != null && m.fcp > 3000) issues.push({ severity: 'medium', label: `Slow FCP: ${(m.fcp / 1000).toFixed(1)}s (target < 1.8s)` });
    }

    // SSL issues
    if (ssl && !ssl.error) {
        if (ssl.daysRemaining != null && ssl.daysRemaining < 0) {
            issues.push({ severity: 'high', label: `SSL certificate EXPIRED ${Math.abs(ssl.daysRemaining)} day(s) ago` });
        } else if (ssl.daysRemaining != null && ssl.daysRemaining < 15) {
            issues.push({ severity: 'high', label: `SSL certificate expires in ${ssl.daysRemaining} day(s)` });
        } else if (ssl.daysRemaining != null && ssl.daysRemaining < 30) {
            issues.push({ severity: 'medium', label: `SSL certificate expires in ${ssl.daysRemaining} day(s)` });
        }
        if (ssl.authorized === false) {
            issues.push({ severity: 'high', label: `SSL certificate not trusted${ssl.authError ? ` (${ssl.authError})` : ''}` });
        }
    }

    // Broken-link issues
    if (brokenLinks && Array.isArray(brokenLinks.broken) && brokenLinks.broken.length > 0) {
        const n = brokenLinks.broken.length;
        const severity = n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low';
        issues.push({ severity, label: `${n} broken internal link${n === 1 ? '' : 's'} (of ${brokenLinks.checked} checked)` });
    }

    // Outdated tech issues
    const jq = techStack.find((t) => t.name === 'jQuery' && t.version);
    if (jq && /^(1\.|2\.)/.test(jq.version)) {
        issues.push({ severity: 'medium', label: `Outdated jQuery ${jq.version} detected (security + performance risk)` });
    }
    const wp = techStack.find((t) => t.name === 'WordPress' && t.version);
    if (wp && /^([0-4]\.|5\.[0-8]\b)/.test(wp.version)) {
        issues.push({ severity: 'medium', label: `Outdated WordPress ${wp.version} (upgrade recommended)` });
    }

    // Competitor-based issues — only if we beat/lose meaningfully on performance.
    if (competitor && !competitor.error && competitor.scores && lighthouse && !lighthouse.error && lighthouse.scores) {
        const ours = lighthouse.scores.performance ?? 0;
        const theirs = competitor.scores.performance ?? 0;
        if (theirs - ours >= 20) {
            issues.push({ severity: 'medium', label: `Performance ${ours} vs competitor ${theirs} (${theirs - ours}-point gap)` });
        }
    }

    const urgencyScore = urgencyFromIssues(issues);

    const pitch = await generatePitchMessage({
        companyName,
        websiteUrl: finalUrl,
        builtYear,
        issues,
        contactInfo,
    });

    return {
        status: 'completed',
        websiteUrl: finalUrl,
        httpCode,
        builtYear,
        contactInfo,
        pageTitle: seo.title,
        metaDescription: seo.metaDescription,
        issues,
        urgencyScore,
        techStack,
        ssl: ssl || null,
        brokenLinks: brokenLinks || null,
        competitor: competitor || null,
        lighthouse: lighthouse?.error
            ? { error: lighthouse.error }
            : {
                scores: lighthouse.scores,
                metrics: lighthouse.metrics,
                opportunities: lighthouse.opportunities,
                strategy: lighthouse.strategy,
            },
        pitchMessage: pitch.text,
        pitchModel: pitch.model || null,
        pitchError: pitch.error || null,
        auditedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
    };
}
