import fs from 'fs';
import path from 'path';
import { createStealthPage } from './browserFlow.js';

const USE_SAMPLE_FALLBACK = process.env.FILTER_BOT_USE_SAMPLE_FALLBACK === '1';
const HEADLESS = process.env.FILTER_BOT_HEADLESS !== '0';

function resolveStorageStatePath() {
    const raw = process.env.FILTER_BOT_STORAGE_STATE;
    if (!raw || typeof raw !== 'string') return null;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    if (fs.existsSync(abs)) return abs;
    console.log(`⚠️ FILTER_BOT_STORAGE_STATE not found: ${abs}`);
    return null;
}

/**
 * Facebook Filter Bot - Extracts users who commented on a post
 * @param {string} postUrl - The Facebook post URL
 * @param {string} action - The action type (Like, Comment, Goal)
 * @param {{ maxUsers?: number, onProgress?: (payload: { users: Array, round: number }) => Promise<void> | void }} [options]
 * Stop after this many unique commenters; optionally emit progressive users per round.
 * @returns {Promise<{users: Array, total: number, action: string}>} - Extracted users data
 */
export async function extractFacebookPostComments(postUrl, action = 'Comment', options = {}) {
    const maxUsers =
        typeof options.maxUsers === 'number' && Number.isFinite(options.maxUsers) && options.maxUsers > 0
            ? Math.min(Math.floor(options.maxUsers), 100000)
            : null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    let browser;
    let context;
    let page;
    let ownsBrowser = true;
    let ownsContext = true;

    try {
        console.log(`🤖 Starting Facebook Filter Bot for ${action} extraction... (headless=${HEADLESS})`);

        const storageStatePath = resolveStorageStatePath();
        if (storageStatePath) {
            console.log(`📎 Playwright storageState (logged-in FB session): ${storageStatePath}`);
        } else if (HEADLESS) {
            console.log(
                'ℹ️ No FILTER_BOT_STORAGE_STATE — Facebook may show login wall in headless. ' +
                    'Record once: npx playwright codegen facebook.com → log in → save storage to fb.json, ' +
                    'then set FILTER_BOT_STORAGE_STATE=fb.json (or run FILTER_BOT_HEADLESS=0 and complete login in the opened window).'
            );
        }

        ({ browser, context, page, ownsBrowser, ownsContext } = await createStealthPage({
            headless: HEADLESS,
            viewport: { width: 1920, height: 1080 },
            locale: 'en-US',
            timezoneId: 'Asia/Kolkata',
            storageState: storageStatePath || undefined,
        }));

        console.log(`📍 Navigating to: ${postUrl}`);

        const response = await page.goto(postUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 25000
        }).catch(err => {
            throw new Error(`Failed to navigate to Facebook URL: ${err.message}`);
        });

        if (!response || response.status() >= 400) {
            throw new Error(`Failed to load Facebook post. Status: ${response?.status || 'unknown'}`);
        }

        console.log('📄 Page loaded successfully, waiting for content...');
        await page.waitForTimeout(4000);
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

        const title = await page.title().catch(() => 'Unknown');
        console.log(`📄 Page title: ${title}`);

        if (!title.toLowerCase().includes('facebook')) {
            throw new Error('This does not appear to be a valid Facebook page');
        }

        // share/r links often land on an intermediate surface first; hop to the reel/video permalink when available.
        await resolveShareTargetIfNeeded(page, postUrl);
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        const loginGate = await detectFacebookLoginWall(page);
        if (loginGate) {
            console.log(
                `❌ Facebook login / checkpoint detected (${loginGate}). ` +
                    'Reel comment UI will not render without a session. ' +
                    'Set FILTER_BOT_STORAGE_STATE to a Playwright storage JSON after logging in, or FILTER_BOT_HEADLESS=0.'
            );
            if (process.env.FILTER_BOT_DEBUG === '1') {
                await page.screenshot({ path: path.join(process.cwd(), 'filter-bot-login-gate.png'), fullPage: true }).catch(() => {});
                console.log('🖼️ Saved filter-bot-login-gate.png (FILTER_BOT_DEBUG=1)');
            }
        }

        // Wait for either feed/dialog or any comment-related UI (Facebook is slow in headless)
        await page.waitForSelector(
            '[role="dialog"], [role="feed"], [role="article"], a[href*="comment_id"]',
            { timeout: 20000 }
        ).catch(() => console.log('⚠️ Timeout waiting for dialog/feed — continuing anyway'));

        console.log('🔍 Opening comments if needed...');
        if (isVideoCommentToolbarSurface(page.url())) {
            await page.waitForTimeout(3000);
            // Do not block on Comment button: without login it never attaches; strategies still run
            await page
                .waitForSelector('[role="button"][aria-label="Comment"]', { state: 'attached', timeout: 8000 })
                .catch(() =>
                    console.log(
                        '⚠️ Comment toolbar not in DOM yet (login wall or slow load). Trying open strategies anyway…'
                    )
                );
        }
        await tryOpenCommentsSection(page);
        await page.waitForTimeout(2500);
        // Reel: right-side comment column ("Write a comment…" or comment rows)
        await page
            .waitForSelector(
                '[role="article"][aria-label*="Comment by"], [role="article"][aria-label*="comment by"], [placeholder*="Write a comment"], [aria-label*="Write a comment"]',
                { state: 'attached', timeout: 15000 }
            )
            .catch(() => console.log('⚠️ Comment panel markers not found after open (may still extract)'));

        if (maxUsers != null) {
            console.log(`📜 Starting comment extraction (stop at ${maxUsers} unique users)...`);
        } else {
            console.log('📜 Starting comment extraction with smooth auto-scroll...');
        }

        const users = [];
        const seenIds = new Set();
        let noNewUsersCount = 0;
        const wantsLargePull = maxUsers != null && maxUsers >= 300;
        const maxNoNewRounds = wantsLargePull ? 20 : 10;
        const maxScrollRounds = wantsLargePull ? 180 : 80;

        for (let round = 0; round < maxScrollRounds && noNewUsersCount < maxNoNewRounds; round++) {
            await expandMoreComments(page);
            const before = users.length;
            const batch = await extractCommentArticles(page);
            for (const user of batch) {
                if (maxUsers != null && users.length >= maxUsers) {
                    break;
                }
                if (!seenIds.has(user.id)) {
                    seenIds.add(user.id);
                    users.push(user);
                }
            }
            const added = users.length - before;
            if (added === 0) {
                noNewUsersCount++;
            } else {
                noNewUsersCount = 0;
            }

            await scrollCommentsPane(page);
            await page.waitForTimeout(2200);

            console.log(`📊 Round ${round + 1}: total ${users.length} users (+${added} new)`);

            if (onProgress && users.length > 0) {
                try {
                    await onProgress({ users: [...users], round: round + 1 });
                } catch (progressErr) {
                    console.log(`⚠️ onProgress callback failed: ${progressErr?.message || progressErr}`);
                }
            }

            if (maxUsers != null && users.length >= maxUsers) {
                console.log(`✅ Reached maxUsers limit (${maxUsers}), stopping early.`);
                break;
            }
        }

        let capped = maxUsers != null ? users.slice(0, maxUsers) : users;

        console.log(`✅ Comment extraction complete! Found ${capped.length} users who commented on this post.`);

        if (capped.length === 0 && USE_SAMPLE_FALLBACK) {
            console.log('🔄 No comments found; FILTER_BOT_USE_SAMPLE_FALLBACK=1 — returning sample data.');
            const samples = generateSampleUsers(action);
            capped = maxUsers != null ? samples.slice(0, maxUsers) : samples;
        } else if (capped.length === 0) {
            console.log('ℹ️ No comments extracted. Set FILTER_BOT_USE_SAMPLE_FALLBACK=1 to get sample rows for UI testing.');
        }

        // Helpful debugging: confirm we actually have commenter names before sending to frontend.
        const sample = capped.slice(0, 5).map(u => ({
            id: u.id,
            name: u.name,
            username: u.username
        }));
        console.log(`🧪 Debug sample users (max 5):`, sample);

        return {
            users: capped.map((user, index) => ({
                id: user.id || `user_${index + 1}`,
                name: (user.name || 'Unknown User').trim() || 'Unknown User',
                username: user.username ? String(user.username).trim() : null,
                profileUrl: user.profileUrl ? String(user.profileUrl).trim() : null,
                anchorHref: user.anchorHref ? String(user.anchorHref).trim() : null,
                comment: user.comment ? String(user.comment).trim() : '',
                commentTime: user.commentTime || new Date().toISOString(),
                followers: user.followers || null,
                profileImageUrl: user.profileImageUrl || null,
                extractedAt: new Date().toISOString()
            })),
            total: capped.length,
            action: action
        };
    } catch (error) {
        console.error('❌ Facebook Filter Bot error:', error.message);
        throw error;
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
        if (ownsContext && context) {
            await context.close().catch(() => {});
        }
        if (ownsBrowser && browser) {
            await browser.close().catch(() => {});
        }
    }
}

async function resolveShareTargetIfNeeded(page, inputUrl) {
    const shouldResolve = /facebook\.com\/share\/r\//i.test(String(inputUrl || '')) || /\/share\/r\//i.test(page.url());
    if (!shouldResolve) return;
    try {
        const target = await page.evaluate(() => {
            const og = document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '';
            if (/facebook\.com\/(reel|watch|[^/]+\/videos)\//i.test(og)) {
                return og;
            }
            const cand =
                document.querySelector('a[href*="/reel/"]') ||
                document.querySelector('a[href*="/videos/"]') ||
                document.querySelector('a[href*="/watch/?v="]');
            return cand ? cand.href : '';
        });
        if (target && typeof target === 'string' && /^https:\/\/(www\.)?facebook\.com\//i.test(target) && target !== page.url()) {
            console.log(`🔁 Resolved share/r to target URL: ${target}`);
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            await page.waitForTimeout(2500);
        }
    } catch (e) {
        console.log(`⚠️ share/r target resolve skipped: ${e?.message || e}`);
    }
}

/**
 * Detect login wall / checkpoint so we fail fast with a clear message instead of timing out on Comment UI.
 */
async function detectFacebookLoginWall(page) {
    try {
        return await page.evaluate(() => {
            const href = String(location.href || '');
            if (/login\.php|checkpoint|\/recover\//i.test(href)) return 'url-login-or-checkpoint';
            const email = document.querySelector('input[name="email"], input#email, input[type="email"]');
            const pass = document.querySelector('input[name="pass"], input#pass, input[type="password"]');
            if (email && pass && email.offsetParent !== null && pass.offsetParent !== null) return 'login-form';
            const t = (document.body?.innerText || '').slice(0, 8000);
            if (/log in to facebook|log in to continue|sign up for facebook|create new account/i.test(t)) return 'body-copy';
            return null;
        });
    } catch {
        return null;
    }
}

/** Reel, Watch, or Page Video — same vertical action bar with Comment speech-bubble + count */
function isVideoCommentToolbarSurface(url) {
    try {
        const u = new URL(url);
        const p = u.pathname;
        return (
            /\/reel\//i.test(p) ||
            /\/videos\//i.test(p) ||
            /\/watch\/?$/i.test(p) ||
            /\bv=\d+/.test(u.search)
        );
    } catch {
        return false;
    }
}

/**
 * Reel vertical toolbar: Comment = speech-bubble SVG (path contains "18.351"), not Like thumb or Share arrow.
 * Headless often reports :visible=false — use DOM click, not Playwright visibility.
 */
async function clickReelCommentToolbarBySvgPath(page) {
    const tag = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[role="button"][aria-label="Comment"]'));
        for (const b of buttons) {
            const paths = b.querySelectorAll('svg path');
            for (const p of paths) {
                const d = p.getAttribute('d') || '';
                if (d.includes('18.351') && d.includes('23.5')) {
                    try {
                        b.scrollIntoView({ block: 'center', inline: 'center' });
                    } catch {
                        /* ignore */
                    }
                    b.click();
                    return 'speech-bubble-svg';
                }
            }
        }
        if (buttons.length) {
            try {
                buttons[buttons.length - 1].scrollIntoView({ block: 'center', inline: 'center' });
            } catch {
                /* ignore */
            }
            buttons[buttons.length - 1].click();
            return 'aria-comment-last';
        }
        return '';
    });
    if (tag) {
        console.log(`✅ Reel Comment toolbar via ${tag}`);
        return true;
    }
    return false;
}

async function tryOpenCommentsSection(page) {
    const toolbarSurface = isVideoCommentToolbarSurface(page.url());
    // Exact match: <div role="button" aria-label="Comment"> + SVG (speech bubble) + count — works for reel AND /videos/ share targets
    const strategies = [
        async () => {
            if (!toolbarSurface) return false;
            return clickReelCommentToolbarBySvgPath(page);
        },
        async () => {
            if (!toolbarSurface) return false;
            const loc = page
                .locator('[role="button"][aria-label="Comment"]')
                .filter({ has: page.locator('svg') });
            const n = await loc.count().catch(() => 0);
            if (!n) return false;
            for (let i = n - 1; i >= 0; i--) {
                const btn = loc.nth(i);
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ timeout: 5000, force: true }).catch(() => {});
                console.log('✅ force-click [aria-label="Comment"]+svg (no visibility check)');
                return true;
            }
            return false;
        },
        async () => {
            const isReelLike = toolbarSurface;
            if (!isReelLike) return false;
            const loc = page.getByRole('button', { name: /^Comment$/i }).first();
            if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) {
                await loc.click({ timeout: 4000 }).catch(() => {});
                console.log('✅ Clicked getByRole Comment (reel)');
                return true;
            }
            return false;
        },
        async () => {
            const isReelLike = toolbarSurface;
            if (!isReelLike) return false;
            const loc = page.locator('[role="button"][aria-label="Comment"]').first();
            if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
                await loc.scrollIntoViewIfNeeded().catch(() => {});
                await loc.click({ timeout: 4000, force: true }).catch(() => {});
                console.log('✅ Clicked [aria-label="Comment"] (reel)');
                return true;
            }
            return false;
        },
        async () => {
            const isReelLike = toolbarSurface;
            if (!isReelLike) return false;
            const loc = page
                .locator('[role="button"]')
                .filter({ hasText: /^\s*\d[\d.,]*[KkMm]?\s*$/ })
                .nth(1);
            if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
                await loc.click({ timeout: 4000 }).catch(() => {});
                console.log('✅ Clicked reel toolbar middle stat (likely Comment count)');
                return true;
            }
            return false;
        },
        // Prefer "N comments" / "1.1K comments" stat (opens modal) over generic "Comment" button
        async () => {
            const loc = page.locator('[role="button"]').filter({ hasText: /\d[\d.,]*\s*[KkMm]?\s*comments/i }).first();
            if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) {
                await loc.click({ timeout: 4000 }).catch(() => {});
                console.log('✅ Clicked comments count button');
                return true;
            }
            return false;
        },
        async () => {
            const loc = page.getByRole('button', { name: /comments/i }).first();
            if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
                await loc.click({ timeout: 4000 }).catch(() => {});
                console.log('✅ Clicked button named comments');
                return true;
            }
            return false;
        },
        async () => {
            const loc = page.locator('span').filter({ hasText: /^\s*\d[\d.,]*[KkMm]?\s+comments\s*$/i }).first();
            if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
                await loc.click({ timeout: 4000 }).catch(() => {});
                console.log('✅ Clicked span with N comments');
                return true;
            }
            return false;
        },
        async () => {
            const loc = page.locator('[aria-label*="comment"][role="button"]').first();
            if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
                await loc.click({ timeout: 3000 }).catch(() => {});
                console.log('✅ Clicked aria-label comment button');
                return true;
            }
            return false;
        },
        async () => {
            const loc = page.locator('[role="button"]').filter({ hasText: /view all\s+\d*\s*comments?/i }).first();
            if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
                await loc.click({ timeout: 4000 }).catch(() => {});
                console.log('✅ Clicked "View all comments" button');
                return true;
            }
            return false;
        },
        async () => {
            const loc = page.locator('[role="button"][aria-label*="comments"]').first();
            if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
                await loc.click({ timeout: 3000 }).catch(() => {});
                console.log('✅ Clicked comments aria-label button (reel fallback)');
                return true;
            }
            return false;
        }
    ];

    for (const run of strategies) {
        try {
            if (await run()) {
                await page.waitForTimeout(2000);
                return;
            }
        } catch {
            /* next */
        }
    }
}

async function expandMoreComments(page) {
    const candidates = [
        page.locator('[role="button"]').filter({ hasText: /see more comments|view more comments|more comments/i }),
        page.locator('[role="button"]').filter({ hasText: /previous comments|older comments/i }),
        page.locator('[role="button"]').filter({ hasText: /see more/i }),
        page.locator('[role="button"]').filter({ hasText: /view all\s+\d+\s+replies|view all replies/i }),
        page.locator('[role="button"]').filter({ hasText: /more replies|see more replies/i }),
        page.locator('div[role="button"]').filter({ hasText: /see more comments|view more comments/i }),
        page.locator('span').filter({ hasText: /see more comments|view more comments|view all replies/i })
    ];

    for (const loc of candidates) {
        const count = await loc.count().catch(() => 0);
        const take = Math.min(count, 8);
        for (let i = 0; i < take; i++) {
            const item = loc.nth(i);
            const visible = await item.isVisible({ timeout: 500 }).catch(() => false);
            if (!visible) continue;
            await item.scrollIntoViewIfNeeded().catch(() => {});
            await item.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(350);
        }
    }
}

/**
 * Scroll the comments pane. Uses instant scroll — `behavior: 'smooth'` often does nothing in headless Chromium.
 */
async function scrollCommentsPane(page) {
    await page.evaluate(() => {
        const findScrollableAncestor = (start) => {
            let el = start;
            for (let i = 0; i < 35 && el; i++) {
                const s = window.getComputedStyle(el);
                const oy = s.overflowY;
                const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 20;
                if (canY) return el;
                el = el.parentElement;
            }
            return null;
        };

        const findBestScrollable = (root) => {
            let best = null;
            let bestScrollable = 0;
            const visit = (el) => {
                if (!el || el.nodeType !== 1) {
                    return;
                }
                const s = window.getComputedStyle(el);
                const oy = s.overflowY;
                const canY =
                    (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                    el.scrollHeight > el.clientHeight + 30;
                if (canY) {
                    const room = el.scrollHeight - el.clientHeight;
                    if (room > bestScrollable) {
                        bestScrollable = room;
                        best = el;
                    }
                }
                for (const c of el.children) {
                    visit(c);
                }
            };
            visit(root);
            return best;
        };

        const dialog = document.querySelector('[role="dialog"]');
        const firstCommentArticle =
            document.querySelector('[role="article"][aria-label*="Comment by"]') ||
            document.querySelector('[role="article"][aria-label*="comment by"]') ||
            document.querySelector('[role="article"] a[href*="comment_id"]')?.closest('[role="article"]');
        // Reel/video layout: prefer scrolling the sidebar container that owns comment rows.
        let target = firstCommentArticle ? findScrollableAncestor(firstCommentArticle) : null;
        const root = dialog || document.body;
        if (!target) {
            target = findBestScrollable(root);
        }

        if (!target && dialog) {
            target = dialog;
        }
        if (!target) {
            const article =
                document.querySelector('[role="article"][aria-label*="Comment"]') ||
                document.querySelector('[role="article"][aria-label*="comment"]');
            if (article) {
                let el = article.parentElement;
                for (let i = 0; i < 30 && el; i++) {
                    const s = window.getComputedStyle(el);
                    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 30) {
                        target = el;
                        break;
                    }
                    el = el.parentElement;
                }
            }
        }
        if (!target) {
            target = document.scrollingElement || document.documentElement;
        }

        const step = Math.max(350, Math.min(900, Math.floor((target.clientHeight || window.innerHeight) * 0.9)));
        const prev = target.scrollTop;
        target.scrollTop = Math.min(target.scrollTop + step, target.scrollHeight);
        // Second nudge if first didn't move (some FB layers need focus)
        if (target.scrollTop === prev && target.scrollHeight > target.clientHeight) {
            target.scrollTop += step;
        }
        // Wheel events help some virtualized lists load more rows than scrollTop alone
        try {
            target.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true }));
        } catch {
            /* ignore */
        }
        window.scrollBy(0, Math.min(400, window.innerHeight * 0.5));
    });
}

/**
 * Extract commenters: primary path uses `a[href*="comment_id"]` (matches FB DOM even when aria-label differs).
 * Fallback: role=article rows with comment_id links + relaxed aria-label parsing.
 */
function isGarbageDisplayName(name) {
    const t = (name || '').trim();
    if (t.length < 2) return true;
    if (/^facebook$/i.test(t)) return true;
    if (/^[\d\s]+$/u.test(t)) return true;
    // Relative time / noise (e.g. "16m", Devanagari digit fragments Facebook shows on anchors)
    if (/^[\d\u0966-\u096F]{1,5}\s*[mhdw\u092e\u093f\u0938]?$/iu.test(t)) return true;
    // e.g. "१६मि" style timestamp fragments (digits + short Devanagari, no space)
    if (
        t.length <= 10 &&
        !/\s/.test(t) &&
        /^[\d\u0966-\u096F]+[\u0900-\u097F]*$/u.test(t) &&
        !/[a-zA-Z]{2,}/.test(t)
    ) {
        return true;
    }
    if (/^(just now|now)$/i.test(t)) return true;
    return false;
}

async function extractCommentArticles(page) {
    const byCommentId = new Map();

    const mergeRow = (row) => {
        if (!row || !row.id) {
            return;
        }
        const rawName = (row.name || '').trim();
        if (!rawName || rawName.length < 2 || /^facebook$/i.test(rawName)) {
            return;
        }
        if (/^[\d\s]+$/u.test(rawName) && !/[a-zA-Z\u0900-\u097F]{2,}/.test(rawName)) {
            return;
        }

        const prev = byCommentId.get(row.id);
        if (!prev) {
            byCommentId.set(row.id, { ...row });
            return;
        }

        const next = { ...prev };

        if (
            !isGarbageDisplayName(row.name) &&
            (isGarbageDisplayName(prev.name) || (row.name || '').trim().length > (prev.name || '').trim().length)
        ) {
            next.name = row.name;
            if (row.username) next.username = row.username;
            if (row.anchorHref) next.anchorHref = row.anchorHref;
        }

        const pc = (prev.comment || '').trim();
        const nc = (row.comment || '').trim();
        if (nc.length > pc.length) {
            next.comment = row.comment;
        } else if (!pc && nc) {
            next.comment = row.comment;
        }

        if ((row.profileUrl || '').length > (prev.profileUrl || '').length) {
            next.profileUrl = row.profileUrl;
        }

        byCommentId.set(row.id, next);
    };

    const linkRows = await page.evaluate(() => {
        function isNoiseName(raw) {
            const s = (raw || '').trim();
            if (!s || s.length > 200) return true;
            if (/^facebook$/i.test(s)) return true;
            if (/^[\d\s]+$/u.test(s)) return true;
            if (/^[\d\u0966-\u096F]{1,5}\s*[mhdw\u092e\u093f\u0938]?$/iu.test(s)) return true;
            if (
                s.length <= 10 &&
                !/\s/.test(s) &&
                /^[\d\u0966-\u096F]+[\u0900-\u097F]*$/u.test(s) &&
                !/[a-zA-Z]{2,}/.test(s)
            ) {
                return true;
            }
            if (/^(just now|now)$/i.test(s)) return true;
            return false;
        }

        function pickScore(name, hidden) {
            let score = (name || '').length;
            if (isNoiseName(name)) score -= 500;
            if (hidden) score -= 50;
            return score;
        }

        function nameFromArticleLabel(art) {
            if (!art) return '';
            const label = (art.getAttribute('aria-label') || '').trim();
            const m =
                /^Comment by\s+(.+?)\s+(\d+\s*(?:h|m|d|s|w)|about|an hour|a day|hours|minutes|days|ago|\d+\s+hours)/i.exec(
                    label
                ) ||
                /^comment by\s+(.+?)\s+(\d+\s*(?:h|m|d|s|w)|about|an hour|a day|hours|minutes|days|ago|\d+\s+hours)/i.exec(
                    label
                );
            if (m) return m[1].trim();
            if (/comment\s+by\s+/i.test(label)) {
                return label.replace(/^comment\s+by\s+/i, '').replace(/\s+\d+.*$/, '').trim();
            }
            return '';
        }

        function findCommentStoryNode(article, authorLink) {
            if (!article) return null;
            const stories = article.querySelectorAll('[data-ad-rendering-role="story_message"]');
            for (const s of stories) {
                if (authorLink && authorLink.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    return s;
                }
            }
            if (stories.length) return stories[stories.length - 1];
            if (!authorLink) {
                return article.querySelector('[dir="auto"]');
            }
            const autos = article.querySelectorAll('span[dir="auto"], div[dir="auto"]');
            for (const s of autos) {
                if (authorLink.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    return s;
                }
            }
            return article.querySelector('[data-ad-rendering-role="story_message"]') || article.querySelector('[dir="auto"]');
        }

        function usernameFromProfileUrl(profileUrl) {
            try {
                const u = new URL(profileUrl, 'https://www.facebook.com');
                const path = u.pathname.replace(/^\//, '');
                if (path.startsWith('profile.php')) {
                    const q = u.searchParams.get('id');
                    return q ? `id_${q}` : null;
                }
                if (path.startsWith('people/')) {
                    const segs = path.split('/').filter(Boolean);
                    if (segs.length >= 2) return segs.slice(1, -1).join('_') || segs[1];
                    return 'people';
                }
                const first = path.split('/')[0];
                return first || null;
            } catch {
                return null;
            }
        }

        function buildCommentText(storyText, name) {
            const lines = (storyText || '')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean);
            if (!lines.length) return '';
            const nm = (name || '').trim().toLowerCase();
            const filtered = lines.filter(l => l && l.toLowerCase() !== nm);
            if (!filtered.length) return '';
            return filtered.join('\n').trim();
        }

        const scope =
            document.querySelector('[role="dialog"]') ||
            document.querySelector('[role="feed"]') ||
            document.querySelector('[data-virtualized="false"]') ||
            document.body;
        const links = Array.from(scope.querySelectorAll('a[href*="comment_id"]'));
        const byCid = new Map();

        for (const a of links) {
            const href = a.href || '';
            const m = href.match(/[?&]comment_id=([^&]+)/);
            if (!m) {
                continue;
            }
            let cidKey = m[1];
            try {
                cidKey = decodeURIComponent(cidKey);
            } catch {
                /* keep raw */
            }
            cidKey = cidKey.slice(0, 200);

            let name = (a.innerText || a.textContent || '').trim().split('\n')[0];
            if (!name || name.length > 200) {
                continue;
            }

            const hidden = a.getAttribute('aria-hidden') === 'true';
            const prev = byCid.get(cidKey);
            const cand = { a, name, href, hidden };
            if (!prev) {
                byCid.set(cidKey, cand);
            } else if (pickScore(cand.name, cand.hidden) > pickScore(prev.name, prev.hidden)) {
                byCid.set(cidKey, cand);
            }
        }

        const out = [];
        for (const { a, name: anchorName, href } of byCid.values()) {
            let name = anchorName;
            if (/^facebook$/i.test(name) || /^[\d\s]+$/u.test(name)) {
                continue;
            }

            let profileUrl = href;
            try {
                const u = new URL(href);
                u.searchParams.delete('comment_id');
                u.searchParams.delete('reply_comment_id');
                profileUrl = u.toString();
            } catch {
                /* keep href */
            }

            const username = usernameFromProfileUrl(profileUrl);
            let id = profileUrl || (username || null) || name || '';

            const art = a.closest('[role="article"]');
            if (isNoiseName(name)) {
                const fromLabel = nameFromArticleLabel(art);
                if (!isNoiseName(fromLabel)) name = fromLabel;
                else if (username && username.length > 2 && !String(username).startsWith('id_')) {
                    name = String(username).replace(/\./g, ' ');
                }
            }

            if (isNoiseName(name) || /^facebook$/i.test(name)) {
                continue;
            }

            let commentText = '';
            if (art) {
                const story = findCommentStoryNode(art, a);
                if (story) {
                    const storyText = (story.innerText || story.textContent || '').trim();
                    commentText = buildCommentText(storyText, name);
                }
            }

            out.push({
                id,
                name,
                username,
                profileUrl,
                anchorHref: href,
                comment: commentText || ''
            });
        }

        // Reel fallback: extract from article labels even when anchor/comment_id is missing or hidden.
        if (!out.length) {
            const arts = Array.from(scope.querySelectorAll('[role="article"][aria-label*="Comment by"], [role="article"][aria-label*="comment by"]'));
            for (const art of arts) {
                const label = (art.getAttribute('aria-label') || '').trim();
                let name = '';
                const m = /^comment by\s+(.+?)\s+/i.exec(label);
                if (m) name = m[1].trim();
                if (!name || isNoiseName(name)) continue;

                const link =
                    art.querySelector('a[href*="comment_id"][aria-hidden="false"]') ||
                    art.querySelector('a[href*="comment_id"]') ||
                    art.querySelector('a[role="link"][href*="facebook.com/"]');
                const href = link?.href || '';

                let profileUrl = href;
                try {
                    const u = new URL(href);
                    u.searchParams.delete('comment_id');
                    u.searchParams.delete('reply_comment_id');
                    profileUrl = u.toString();
                } catch {
                    /* keep raw */
                }
                const username = usernameFromProfileUrl(profileUrl);
                const id = profileUrl || username || name;

                const msg =
                    art.querySelector('[data-ad-rendering-role="story_message"]') ||
                    art.querySelector('span[dir="auto"][lang]') ||
                    art.querySelector('[dir="auto"]');
                const commentText = msg ? buildCommentText((msg.innerText || msg.textContent || '').trim(), name) : '';

                out.push({
                    id,
                    name,
                    username,
                    profileUrl,
                    anchorHref: href || null,
                    comment: commentText || ''
                });
            }
        }
        return out;
    });

    for (const row of linkRows) {
        mergeRow(row);
    }

    const commentLocator = page
        .locator('[role="article"]')
        .filter({
            has: page.locator('a[href*="comment_id"], a[href*="/reel/"][href*="comment_id"]')
        });
    const count = await commentLocator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
        const row = commentLocator.nth(i);
        try {
            const data = await row.evaluate((el) => {
                function isNoiseName(raw) {
                    const s = (raw || '').trim();
                    if (!s || s.length > 200) return true;
                    if (/^facebook$/i.test(s)) return true;
                    if (/^[\d\s]+$/u.test(s)) return true;
                    if (/^[\d\u0966-\u096F]{1,5}\s*[mhdw\u092e\u093f\u0938]?$/iu.test(s)) return true;
                    if (
                        s.length <= 10 &&
                        !/\s/.test(s) &&
                        /^[\d\u0966-\u096F]+[\u0900-\u097F]*$/u.test(s) &&
                        !/[a-zA-Z]{2,}/.test(s)
                    ) {
                        return true;
                    }
                    if (/^(just now|now)$/i.test(s)) return true;
                    return false;
                }

                function findCommentStoryNode(article, authorLink) {
                    if (!article) return null;
                    const stories = article.querySelectorAll('[data-ad-rendering-role="story_message"]');
                    for (const s of stories) {
                        if (authorLink && authorLink.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) {
                            return s;
                        }
                    }
                    if (stories.length) return stories[stories.length - 1];
                    if (!authorLink) {
                        return article.querySelector('[dir="auto"]');
                    }
                    const autos = article.querySelectorAll('span[dir="auto"], div[dir="auto"]');
                    for (const s of autos) {
                        if (authorLink.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) {
                            return s;
                        }
                    }
                    return article.querySelector('[data-ad-rendering-role="story_message"], [dir="auto"]');
                }

                function usernameFromProfileUrl(profileUrl) {
                    try {
                        const u = new URL(profileUrl, 'https://www.facebook.com');
                        const path = u.pathname.replace(/^\//, '');
                        if (path.startsWith('profile.php')) {
                            const q = u.searchParams.get('id');
                            return q ? `id_${q}` : '';
                        }
                        if (path.startsWith('people/')) {
                            const segs = path.split('/').filter(Boolean);
                            if (segs.length >= 2) return segs.slice(1, -1).join('_') || segs[1];
                            return 'people';
                        }
                        return path.split('/')[0] || '';
                    } catch {
                        return '';
                    }
                }

                function buildCommentText(storyText, name) {
                    const lines = (storyText || '')
                        .split('\n')
                        .map(l => l.trim())
                        .filter(Boolean);
                    if (!lines.length) return '';
                    const nm = (name || '').trim().toLowerCase();
                    const filtered = lines.filter(l => l && l.toLowerCase() !== nm);
                    if (!filtered.length) return '';
                    return filtered.join('\n').trim();
                }

                const label = (el.getAttribute('aria-label') || '').trim();
                let nameFromLabel = '';
                const m =
                    /^Comment by\s+(.+?)\s+(\d+\s*(?:h|m|d|s|w)|about|an hour|a day|hours|minutes|days|ago|\d+\s+hours)/i.exec(
                        label
                    ) ||
                    /^comment by\s+(.+?)\s+(\d+\s*(?:h|m|d|s|w)|about|an hour|a day|hours|minutes|days|ago|\d+\s+hours)/i.exec(
                        label
                    );
                if (m) {
                    nameFromLabel = m[1].trim();
                } else if (/comment\s+by\s+/i.test(label)) {
                    nameFromLabel = label.replace(/^comment\s+by\s+/i, '').replace(/\s+\d+.*$/, '').trim();
                }

                const authorLink =
                    el.querySelector('a[href*="comment_id"][role="link"]') ||
                    el.querySelector('a[href*="comment_id"]');

                let profileUrl = '';
                const anchorHref = authorLink ? (authorLink.href || '') : null;
                let name = nameFromLabel;

                if (authorLink) {
                    profileUrl = authorLink.href || '';
                    try {
                        const u = new URL(profileUrl);
                        u.searchParams.delete('comment_id');
                        u.searchParams.delete('reply_comment_id');
                        profileUrl = u.toString();
                    } catch {
                        /* ignore */
                    }
                    const t = (authorLink.innerText || authorLink.textContent || '').trim();
                    const line = t.split('\n')[0].trim();
                    if (line && line.length < 200 && !isNoiseName(line)) {
                        name = line;
                    }
                }

                if (isNoiseName(name) && nameFromLabel && !isNoiseName(nameFromLabel)) {
                    name = nameFromLabel;
                }

                const username = profileUrl ? usernameFromProfileUrl(profileUrl) : '';
                if (isNoiseName(name) && username && username.length > 2 && !username.startsWith('id_')) {
                    name = username.replace(/\./g, ' ');
                }

                if (!name || name.length < 2 || /^facebook$/i.test(name) || isNoiseName(name)) {
                    return null;
                }

                const id = profileUrl || (username || null) || name || '';

                const story = findCommentStoryNode(el, authorLink);
                let commentText = '';
                if (story) {
                    const storyText = (story.innerText || story.textContent || '').trim();
                    commentText = buildCommentText(storyText, name);
                }

                return {
                    id,
                    name,
                    username: username || null,
                    profileUrl: profileUrl || null,
                    anchorHref,
                    comment: commentText || ''
                };
            });

            mergeRow(data);
        } catch {
            /* skip row */
        }
    }

    return Array.from(byCommentId.values());
}

function generateSampleUsers(action) {
    const firstNames = ['Sarah', 'Michael', 'Emily', 'Alex', 'Jessica', 'David', 'Maria', 'James', 'Lisa', 'Robert', 'Anna', 'John', 'Sophie', 'William', 'Olivia', 'Daniel', 'Emma', 'Christopher', 'Isabella', 'Matthew', 'Charlotte', 'Anthony', 'Amelia', 'Mark', 'Mia', 'Steven', 'Chloe', 'Kevin', 'Grace', 'Brian', 'Zoe', 'Jason', 'Lily', 'Ryan', 'Natalie', 'Eric', 'Hannah', 'Adam', 'Ava', 'Peter', 'Sophia', 'Paul', 'Ella', 'Andrew', 'Victoria', 'Joshua', 'Scarlett', 'Nathan', 'Zoe', 'Justin', 'Penelope'];
    const lastNames = ['Johnson', 'Smith', 'Davis', 'Thompson', 'Martinez', 'Garcia', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia', 'Martinez', 'Robinson', 'Clark', 'Rodriguez', 'Lewis', 'Lee', 'Walker', 'Hall', 'Allen', 'Young', 'Hernandez', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green', 'Adams', 'Baker', 'Gonzalez', 'Nelson', 'Carter', 'Mitchell', 'Perez', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins'];

    const comments = [
        `Great post! I really ${action.toLowerCase()} this content.`,
        `Thanks for sharing! This ${action.toLowerCase()} is amazing.`,
        `I totally ${action.toLowerCase()} this perspective!`
    ];

    const sampleUsers = [];
    const userCount = 20;

    for (let i = 0; i < userCount; i++) {
        const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
        const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
        const name = `${firstName} ${lastName}`;
        const username = `${firstName.toLowerCase()}${lastName.toLowerCase()}${Math.floor(Math.random() * 999)}`;
        const comment = comments[Math.floor(Math.random() * comments.length)];

        sampleUsers.push({
            id: `user_${i + 1}`,
            name,
            username,
            profileUrl: `https://www.facebook.com/${username}`,
            comment,
            commentTime: new Date(Date.now() - (Math.random() * 86400000 * 30)).toISOString(),
            followers: Math.floor(Math.random() * 10000) + 100,
            profileImageUrl: null
        });
    }

    return sampleUsers;
}
