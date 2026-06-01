import { createStealthPage, waitForHomepageReady } from './browserFlow.js';

const NAV_TIMEOUT = 25000;
const HEADLESS = process.env.LEAD_CAPTURE_HEADLESS === '1';

/**
 * Agent 1 — Google Maps Scraper
 *
 * Searches for a company/business name on Google Maps, selects the top listing,
 * and extracts: opening hours, closing hours, website URL, address, phone, rating.
 *
 * @param {string} companyName - The business name to search (e.g. "Springfield High School")
 * @returns {Promise<object>} Extracted business data
 */
export async function scrapeGoogleMaps(companyName) {
    let browser, context, page;
    const sharedSession = arguments[1] || null;
    const usingSharedContext = Boolean(sharedSession?.context);
    let ownsBrowser = true;
    let ownsContext = true;

    try {
        console.log(`[Agent1][GoogleMaps] Searching for: "${companyName}"`);

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
                viewport: { width: 1920, height: 1080 },
                timezoneId: 'Asia/Kolkata',
                blockMedia: false,
            }));
        }
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(NAV_TIMEOUT);

        // ── Navigate to Google Maps with the search query ──
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(companyName)}`;
        console.log(`[Agent1] Navigating: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

        // ── Accept cookies consent if it appears ──
        await dismissConsentDialog(page);

        // ── Wait for either results list or direct place panel ──
        await page.waitForSelector('[role="feed"], [role="main"] button[data-item-id], h1.DUwDvf', {
            timeout: 12000,
        }).catch(() => {
            console.log('[Agent1] No feed/place panel detected, continuing...');
        });

        // ── Click the first result if we landed on a search results list ──
        const feed = await page.$('[role="feed"]');
        if (feed) {
            console.log('[Agent1] Search results list detected — clicking first result...');
            const firstResult =
                (await page.$('[role="feed"] > div > div > a')) ||
                (await page.$('[role="feed"] a[href*="/maps/place/"]'));
            if (firstResult) {
                await Promise.all([
                    firstResult.click(),
                    page.waitForSelector('h1.DUwDvf, [role="main"] h1', { timeout: 10000 }).catch(() => {}),
                ]);
            }
        }

        // ── Wait for the place detail panel to be ready ──
        await page.waitForSelector('h1.DUwDvf, [role="main"] h1, [role="main"] button[data-item-id]', {
            timeout: 8000,
        }).catch(() => {});
        await page.waitForFunction(
            () => !!document.querySelector('[role="main"] button[data-item-id], a[data-item-id="authority"]'),
            { timeout: 4000, polling: 150 }
        ).catch(() => {});

        // ── Extract all business data from the place panel ──
        const data = await page.evaluate(() => {
            const result = {
                name: '',
                address: '',
                phone: '',
                website: '',
                rating: '',
                reviewCount: '',
                category: '',
                openingHours: [],
                currentStatus: '',
            };

            // Business name
            const nameEl =
                document.querySelector('h1.DUwDvf') ||
                document.querySelector('[role="main"] h1') ||
                document.querySelector('h1');
            result.name = nameEl?.textContent?.trim() || '';

            // Rating
            const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
            result.rating = ratingEl?.textContent?.trim() || '';

            // Review count
            const reviewEl = document.querySelector('div.F7nice span[aria-label*="review"]');
            result.reviewCount = reviewEl?.getAttribute('aria-label')?.match(/[\d,]+/)?.[0] || '';

            // Category
            const catEl = document.querySelector('button.DkEaL');
            result.category = catEl?.textContent?.trim() || '';

            // Current open/close status
            const statusEl =
                document.querySelector('[data-hide-tooltip-on-mouse-move] span.ZDu9vd') ||
                document.querySelector('[aria-label*="hours"] .ZDu9vd') ||
                document.querySelector('.o0Svhf span');
            result.currentStatus = statusEl?.textContent?.trim() || '';

            // Address
            const allButtons = Array.from(document.querySelectorAll('[role="main"] button[data-item-id]'));
            for (const btn of allButtons) {
                const ariaLabel = btn.getAttribute('aria-label') || '';
                const dataId = btn.getAttribute('data-item-id') || '';

                if (dataId.startsWith('address') || ariaLabel.toLowerCase().includes('address')) {
                    result.address = ariaLabel.replace(/^Address:\s*/i, '').trim();
                }
                if (dataId.startsWith('phone') || ariaLabel.toLowerCase().includes('phone')) {
                    result.phone = ariaLabel.replace(/^Phone:\s*/i, '').trim();
                }
            }

            // Website link
            const websiteLink =
                document.querySelector('a[data-item-id="authority"]') ||
                document.querySelector('a[aria-label*="website" i]') ||
                document.querySelector('a[data-item-id*="website"]');
            if (websiteLink) {
                result.website = websiteLink.getAttribute('href') || '';
            }

            // Opening hours table
            const hoursTable = document.querySelector('table.eK4R0e');
            if (hoursTable) {
                const rows = hoursTable.querySelectorAll('tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const day = cells[0]?.textContent?.trim() || '';
                        const hours = cells[1]?.textContent?.trim() || '';
                        if (day) {
                            result.openingHours.push({ day, hours });
                        }
                    }
                }
            }

            return result;
        });

        // If we didn't get hours from the table, try clicking the hours section to expand it
        if (data.openingHours.length === 0) {
            console.log('[Agent1] No hours table found — trying to expand hours section...');
            const hoursButton = await page.$('[data-hide-tooltip-on-mouse-move]');
            if (hoursButton) {
                await hoursButton.click().catch(() => {});
                await page.waitForSelector('table.eK4R0e, [role="main"] table', { timeout: 2500 }).catch(() => {});

                const expandedHours = await page.evaluate(() => {
                    const hours = [];
                    const table = document.querySelector('table.eK4R0e') || document.querySelector('[role="main"] table');
                    if (table) {
                        const rows = table.querySelectorAll('tr');
                        for (const row of rows) {
                            const cells = row.querySelectorAll('td');
                            if (cells.length >= 2) {
                                const day = cells[0]?.textContent?.trim() || '';
                                const time = cells[1]?.textContent?.trim() || '';
                                if (day) hours.push({ day, hours: time });
                            }
                        }
                    }
                    return hours;
                });

                if (expandedHours.length > 0) {
                    data.openingHours = expandedHours;
                }
            }
        }

        // Parse opening/closing from the hours or status
        const parsedTimes = parseOpenCloseFromHours(data.openingHours, data.currentStatus);

        const result = {
            companyName: data.name || companyName,
            address: data.address,
            phone: data.phone,
            website: data.website,
            rating: data.rating,
            reviewCount: data.reviewCount,
            category: data.category,
            openingTime: parsedTimes.openingTime,
            closingTime: parsedTimes.closingTime,
            currentStatus: data.currentStatus,
            openingHours: data.openingHours,
        };

        console.log(`[Agent1] Extraction complete:`, {
            name: result.companyName,
            website: result.website || '(none)',
            hours: result.openingHours.length + ' day entries',
            status: result.currentStatus,
        });

        return result;
    } catch (error) {
        console.error(`[Agent1] Google Maps scrape failed for "${companyName}":`, error.message);
        throw error;
    } finally {
        // Close persistent context cleanly after each run.
        if (page) await page.close().catch(() => {});
        if (!usingSharedContext && ownsContext && context) await context.close().catch(() => {});
        if (!usingSharedContext && ownsBrowser && browser) await browser.close().catch(() => {});
    }
}

/**
 * Parse opening/closing times from the hours array or current status text.
 */
function parseOpenCloseFromHours(hoursArr, currentStatus) {
    let openingTime = '';
    let closingTime = '';

    // Get today's day name
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = days[new Date().getDay()];

    // Try to find today's hours in the array
    const todayEntry = hoursArr.find(
        (h) => h.day.toLowerCase().includes(todayName.toLowerCase()) || h.day.toLowerCase().includes(todayName.slice(0, 3).toLowerCase())
    );

    if (todayEntry && todayEntry.hours) {
        const timeRange = todayEntry.hours;
        // Patterns: "9 AM–5 PM", "9:00 AM – 5:00 PM", "Open 24 hours", "Closed"
        if (/closed/i.test(timeRange)) {
            openingTime = 'Closed';
            closingTime = 'Closed';
        } else if (/24\s*hours?|open all day/i.test(timeRange)) {
            openingTime = '12:00 AM';
            closingTime = '11:59 PM';
        } else {
            const parts = timeRange.split(/[–\-\u2013\u2014]/);
            if (parts.length >= 2) {
                openingTime = parts[0].trim();
                closingTime = parts[1].trim();
            }
        }
    }

    // Fallback: parse from currentStatus (e.g. "Open ⋅ Closes 5 PM", "Closed ⋅ Opens 9 AM")
    if (!openingTime && currentStatus) {
        const closesMatch = currentStatus.match(/closes?\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
        const opensMatch = currentStatus.match(/opens?\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
        if (closesMatch) closingTime = closesMatch[1].trim();
        if (opensMatch) openingTime = opensMatch[1].trim();
    }

    return { openingTime, closingTime };
}

/**
 * Dismiss Google consent / cookie dialogs if they appear.
 */
async function dismissConsentDialog(page) {
    const selectors = [
        'button[aria-label="Accept all"]',
        'button[aria-label="Reject all"]',
        'form[action*="consent"] button',
        'button:has-text("Accept all")',
        'button:has-text("I agree")',
    ];

    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) {
                await btn.click();
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                console.log(`[Agent1] Dismissed consent dialog via: ${sel}`);
                return;
            }
        } catch {
            // continue
        }
    }
}
