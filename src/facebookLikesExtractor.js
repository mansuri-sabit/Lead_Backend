import { chromium } from 'playwright';

/**
 * Extracts users who liked a Facebook post
 * @param {string} postUrl - The Facebook post URL
 * @returns {Promise<{users: Array, total: number}>} - Extracted users data
 */
export async function extractFacebookPostLikes(postUrl) {
    let browser;
    let page;
    
    try {
        console.log('🌐 Launching browser for Facebook post likes extraction...');
        
        // Launch browser with improved settings
        browser = await chromium.launch({
            headless: true, // Use headless for better stability
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-blink-features=AutomationControlled',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            ignoreHTTPSErrors: true,
            acceptDownloads: false
        });

        page = await context.newPage();

        // Set up error handling for page
        page.on('error', (error) => {
            console.error('🚨 Page error:', error);
        });

        page.on('pageerror', (error) => {
            console.error('🚨 Page error:', error);
        });

        // Set up request interception to avoid unnecessary resources
        await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());

        // Handle different types of Facebook URLs
        let targetUrl = postUrl;
        
        // Convert share URLs to regular post URLs
        if (postUrl.includes('facebook.com/share/p/')) {
            console.log('🔄 Detected share URL, will redirect to actual post...');
            // We'll navigate to share URL and let it redirect
        }
        
        console.log(`📍 Navigating to: ${targetUrl}`);
        
        // Navigate to Facebook post with better error handling
        try {
            const response = await page.goto(targetUrl, { 
                waitUntil: 'domcontentloaded', // Changed from networkidle
                timeout: 30000 
            });

            if (!response) {
                throw new Error('Failed to load page. No response received.');
            }

            console.log(`📄 Page response status: ${response.status()}`);
            
            if (response.status() === 404) {
                throw new Error('Post not found or has been deleted.');
            }

            if (response.status() !== 200) {
                throw new Error(`Failed to load Facebook post. Status: ${response.status()}`);
            }

        } catch (navError) {
            console.error('❌ Navigation error:', navError.message);
            throw new Error(`Failed to navigate to Facebook post: ${navError.message}`);
        }

        console.log('📄 Page loaded successfully, waiting for content...');

        // Wait for page to fully load
        await page.waitForTimeout(3000);

        // Try to get page content to verify it's loaded
        try {
            const pageContent = await page.content();
            if (!pageContent || pageContent.length < 1000) {
                throw new Error('Page content appears to be empty or incomplete.');
            }
            console.log(`📝 Page content length: ${pageContent.length} characters`);
        } catch (contentError) {
            console.error('❌ Error getting page content:', contentError.message);
        }

        // Check if we need to login
        const loginSelectors = [
            '[data-testid="royal_login_form"]',
            '#email',
            'input[name="email"]',
            '[aria-label="Email address or phone number"]'
        ];

        let loginRequired = false;
        for (const selector of loginSelectors) {
            try {
                if (await page.locator(selector).isVisible({ timeout: 3000 })) {
                    loginRequired = true;
                    break;
                }
            } catch (e) {
                // Continue checking
            }
        }

        if (loginRequired) {
            throw new Error('Authentication required. This post may require login to access or extract likes.');
        }

        // Handle share URL redirect
        if (postUrl.includes('facebook.com/share/p/')) {
            console.log('⏳ Waiting for share URL redirect...');
            await page.waitForTimeout(3000);
            
            // Check if we were redirected
            const currentUrl = page.url();
            if (currentUrl !== targetUrl && !currentUrl.includes('share/p/')) {
                console.log(`✅ Redirected to: ${currentUrl}`);
                targetUrl = currentUrl;
            }
        }

        // Look for the likes button/count with more comprehensive selectors
        let likesButton = null;
        
        const likesSelectors = [
            'aria-label/Like',
            'aria-label/likes',
            'aria-label/Likes',
            '[role="button"]:has-text("Like")',
            '[role="button"]:has-text("Likes")',
            'span:has-text("likes")',
            'span:has-text("Like")',
            '[aria-label*="like"] i',
            '[data-testid*="like"]',
            '.x1i10hfl:has-text("Like")',
            '.x1i10hfl:has-text("Likes")',
            'div[role="button"] span:has-text("Like")',
            'div[role="button"] span:has-text("Likes")'
        ];

        console.log('🔍 Searching for likes button...');
        
        for (const selector of likesSelectors) {
            try {
                const elements = await page.locator(selector).all();
                for (const element of elements) {
                    if (await element.isVisible({ timeout: 2000 })) {
                        likesButton = element;
                        console.log(`✅ Found likes button with selector: ${selector}`);
                        break;
                    }
                }
                if (likesButton) break;
            } catch (e) {
                // Continue to next selector
            }
        }

        if (!likesButton) {
            // Try to find any element that mentions likes or reactions
            console.log('🔍 Searching for any reaction/like related elements...');
            const pageContent = await page.content();
            if (pageContent.includes('like') || pageContent.includes('reaction')) {
                console.log('📝 Found like/reaction content in page, but button not accessible');
                throw new Error('Found like/reaction content but the likes button is not accessible. The post may have restricted access.');
            } else {
                throw new Error('Could not find likes button on this post. This post might not have any likes yet or be inaccessible.');
            }
        }

        console.log('👆 Clicking on likes button...');
        await likesButton.click();
        
        // Wait for the likes modal/popup to appear
        await page.waitForTimeout(3000);

        // Look for the likes modal with more comprehensive selectors
        const modalSelectors = [
            '[role="dialog"]',
            '[aria-label*="People who liked"]',
            '[aria-label*="people who liked"]',
            '[data-testid="likes-modal"]',
            '[data-testid="reaction-modal"]',
            '.x1n2onr6', // Facebook's modal class
            '.x6s0dn4',  // Another Facebook modal class
            '.x9f619',   // Another modal class
            '.x78zum5'   // Another modal class
        ];

        let likesModal = null;
        for (const selector of modalSelectors) {
            try {
                const modals = await page.locator(selector).all();
                for (const modal of modals) {
                    if (await modal.isVisible({ timeout: 3000 })) {
                        likesModal = modal;
                        console.log(`✅ Found likes modal with selector: ${selector}`);
                        break;
                    }
                }
                if (likesModal) break;
            } catch (e) {
                // Continue to next selector
            }
        }

        if (!likesModal) {
            throw new Error('Could not find likes modal after clicking likes button. The likes list might not be accessible or requires login.');
        }

        console.log('📜 Extracting user data from likes modal...');

        const users = [];
        let previousHeight = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 50;
        let noNewUsersCount = 0;

        // Scroll through the modal to load all users
        while (scrollAttempts < maxScrollAttempts && noNewUsersCount < 3) {
            // Extract current visible users
            const currentUsers = await extractVisibleUsers(page, likesModal);
            
            // Count new users
            let newUsersCount = 0;
            for (const user of currentUsers) {
                if (!users.find(u => u.id === user.id)) {
                    users.push(user);
                    newUsersCount++;
                }
            }

            if (newUsersCount === 0) {
                noNewUsersCount++;
            } else {
                noNewUsersCount = 0;
            }

            // Get current scroll height of the modal
            const currentHeight = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"]');
                return modal ? modal.scrollHeight : document.body.scrollHeight;
            });
            
            if (currentHeight === previousHeight || noNewUsersCount >= 3) {
                // No more content to load
                break;
            }

            previousHeight = currentHeight;
            
            // Scroll down within the modal
            await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"]');
                if (modal) {
                    modal.scrollTop = modal.scrollHeight;
                } else {
                    window.scrollTo(0, document.body.scrollHeight);
                }
            });
            await page.waitForTimeout(2000);
            
            scrollAttempts++;
            
            console.log(`📊 Scroll ${scrollAttempts}: Found ${users.length} users so far (new: ${newUsersCount})...`);
        }

        console.log(`✅ Extraction complete! Found ${users.length} users who liked this post.`);

        // If no users found, provide helpful information
        if (users.length === 0) {
            console.log('ℹ️ No users extracted. This could mean:');
            console.log('   • The post has no likes yet');
            console.log('   • All likes are from private profiles');
            console.log('   • The likes are restricted due to privacy settings');
        }

        return {
            users: users.map((user, index) => ({
                id: user.id || `user_${index + 1}`,
                name: user.name || 'Unknown User',
                username: user.username || null,
                profileUrl: user.profileUrl || null,
                followers: user.followers || null,
                profileImageUrl: user.profileImageUrl || null,
                extractedAt: new Date().toISOString()
            })),
            total: users.length
        };

    } catch (error) {
        console.error('❌ Error during Facebook likes extraction:', error.message);
        throw error;
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

/**
 * Extracts visible users from the likes modal
 * @param {Page} page - Playwright page object
 * @param {Locator} modal - The likes modal locator
 * @returns {Promise<Array>} - Array of user objects
 */
async function extractVisibleUsers(page, modal) {
    try {
        // Try different selectors for user elements in the modal
        const userSelectors = [
            'a[href*="facebook.com/"]',
            '[role="link"]',
            '.x1i10hfl', // Facebook link class
            '.x1q0g3np'  // Another Facebook link class
        ];

        let userElements = [];
        
        for (const selector of userSelectors) {
            try {
                const elements = await modal.locator(selector).all();
                if (elements.length > 0) {
                    userElements = elements;
                    console.log(`📝 Found ${elements.length} user elements with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                // Continue to next selector
            }
        }

        const users = [];

        for (const element of userElements) {
            try {
                const userData = await page.evaluate((el) => {
                    // Extract user information from the element
                    const link = el.href || '';
                    const text = el.innerText || el.textContent || '';
                    
                    // Try to extract username from link
                    const usernameMatch = link.match(/facebook\.com\/([^?\/]+)/);
                    const username = usernameMatch ? usernameMatch[1] : null;
                    
                    // Try to extract name from text
                    const name = text.trim() || username || 'Unknown User';
                    
                    return {
                        name,
                        username,
                        profileUrl: link,
                        profileImageUrl: null // Would need additional logic to extract profile images
                    };
                }, element);

                if (userData.name && userData.name !== 'Unknown User') {
                    users.push(userData);
                }
            } catch (e) {
                // Skip this element if extraction fails
            }
        }

        return users;
    } catch (error) {
        console.error('❌ Error extracting visible users:', error.message);
        return [];
    }
}

/**
 * Validates if a URL is a valid Facebook post URL
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if valid Facebook post URL
 */
export function validateFacebookPostUrl(url) {
    const facebookUrlRegex = /^https:\/\/(www\.)?facebook\.com\/(share\/p\/|posts\/|permalink\.php|[^\/]+\/posts\/[^\/]+|[^\/]+\/videos\/[^\/]+).*/;
    return facebookUrlRegex.test(url);
}

/**
 * Extracts post ID from Facebook URL
 * @param {string} url - The Facebook URL
 * @returns {string|null} - The post ID or null if not found
 */
export function extractPostId(url) {
    const patterns = [
        /\/posts\/(\d+)/,
        /\/permalink\.php\?story_fbid=(\d+)/,
        /\/videos\/(\d+)/,
        /\/story_fbid=(\d+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}
