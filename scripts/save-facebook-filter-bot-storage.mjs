#!/usr/bin/env node
/**
 * Opens Facebook in a visible Chromium window. Log in (and complete any 2FA/checkpoint),
 * then press Enter in this terminal to save Playwright storageState.
 *
 * Usage (from Backend folder):
 *   npm run filter-bot:save-session
 *   npm run filter-bot:save-session -- ./fb-filter-bot-storage.json
 *
 * Then set in .env: FILTER_BOT_STORAGE_STATE=fb-filter-bot-storage.json (path relative to cwd when you start the server).
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { chromium } from 'playwright';

const outPath = path.resolve(
    process.argv[2] ||
        process.env.FILTER_BOT_STORAGE_STATE ||
        path.join(process.cwd(), 'fb-filter-bot-storage.json')
);

const dir = path.dirname(outPath);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
    return new Promise((resolve) => rl.question(prompt, resolve));
}

try {
    console.log('');
    console.log('Facebook Filter Bot — save Playwright session');
    console.log('─'.repeat(50));
    console.log(`Will write: ${outPath}`);
    console.log('Opening browser — log in to Facebook, then return here and press Enter.');
    console.log('');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US'
    });
    const page = await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    await question('Press Enter here after you are logged in and the feed (or home) loads… ');

    await context.storageState({ path: outPath });
    console.log(`Saved storage state: ${outPath}`);
    console.log('Add to Backend .env: FILTER_BOT_STORAGE_STATE=' + path.basename(outPath));
    console.log('(or use the full path above if the server cwd differs.)');

    await browser.close();
} catch (err) {
    console.error(err);
    process.exitCode = 1;
} finally {
    rl.close();
}
