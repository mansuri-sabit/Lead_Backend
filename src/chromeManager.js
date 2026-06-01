/**
 * Shared Chrome Manager
 * =====================
 * Auto-launches Chrome with --remote-debugging-port=9222 and keeps it alive
 * for all Lead Capture agents. Both Agent 1 (Google Maps) and Agent 2 (Website Analyzer)
 * connect to the same Chrome instance via CDP.
 *
 * Usage:
 *   import { getChromeEndpoint, shutdownChrome } from './chromeManager.js';
 *   const wsEndpoint = await getChromeEndpoint();
 *   const browser = await chromium.connectOverCDP(wsEndpoint);
 */

import { execFile } from 'child_process';
import fs from 'fs';
import { execFileSync } from 'child_process';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CHROME_CDP_PORT || '9222', 10);
const CDP_URL = process.env.CHROME_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || 'C:\\Users\\godwi\\AppData\\Local\\Google\\Chrome\\User Data';
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || 'Profile 68';
const CHROME_AUTOMATION_USER_DATA_DIR =
    process.env.CHROME_AUTOMATION_USER_DATA_DIR ||
    'C:\\Users\\godwi\\AppData\\Local\\Google\\Chrome\\User Data Automation';
const CHROME_AUTOMATION_PROFILE_DIR = process.env.CHROME_AUTOMATION_PROFILE_DIR || CHROME_PROFILE_DIR;
// Default to strict attach-only mode:
// if Chrome is already open but not debuggable, DO NOT launch a new instance.
const EXISTING_CHROME_ONLY = process.env.CHROME_ATTACH_ONLY !== '0';
// Optional: if Chrome is running without CDP, restart same profile with CDP.
const AUTO_RESTART_WITH_CDP = process.env.CHROME_AUTO_RESTART_WITH_CDP !== '0';
// Side-by-side mode: keep user's existing Chrome alive, open automation Chrome separately.
const CHROME_SIDE_BY_SIDE = process.env.CHROME_SIDE_BY_SIDE !== '0';

let chromeProcess = null;
let isLaunching = false;

function readLocalState(localStatePath) {
    try {
        if (!fs.existsSync(localStatePath)) return null;
        return JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    } catch {
        return null;
    }
}

function getProfileUserName(localStateObj, profileDir) {
    try {
        return localStateObj?.profile?.info_cache?.[profileDir]?.user_name || '';
    } catch {
        return '';
    }
}

function ensureAutomationProfileSeeded() {
    try {
        if (!fs.existsSync(CHROME_AUTOMATION_USER_DATA_DIR)) {
            fs.mkdirSync(CHROME_AUTOMATION_USER_DATA_DIR, { recursive: true });
        }

        const srcProfileDir = `${CHROME_USER_DATA_DIR}\\${CHROME_PROFILE_DIR}`;
        const dstProfileDir = `${CHROME_AUTOMATION_USER_DATA_DIR}\\${CHROME_AUTOMATION_PROFILE_DIR}`;
        const srcLocalState = `${CHROME_USER_DATA_DIR}\\Local State`;
        const dstLocalState = `${CHROME_AUTOMATION_USER_DATA_DIR}\\Local State`;

        if (!fs.existsSync(srcProfileDir)) {
            console.warn(`[ChromeManager] Source profile not found for clone: ${srcProfileDir}`);
            return;
        }

        const srcState = readLocalState(srcLocalState);
        const dstState = readLocalState(dstLocalState);
        const srcUser = getProfileUserName(srcState, CHROME_PROFILE_DIR);
        const dstUser = getProfileUserName(dstState, CHROME_AUTOMATION_PROFILE_DIR);
        const shouldReseedBecauseUnsigned = Boolean(srcUser) && !dstUser;

        if (shouldReseedBecauseUnsigned && fs.existsSync(dstProfileDir)) {
            fs.rmSync(dstProfileDir, { recursive: true, force: true });
        }
        if (shouldReseedBecauseUnsigned && fs.existsSync(dstLocalState)) {
            fs.rmSync(dstLocalState, { force: true });
        }

        // Seed once, or reseed if automation profile appears unsigned while source is signed in.
        if (!fs.existsSync(dstProfileDir)) {
            fs.cpSync(srcProfileDir, dstProfileDir, {
                recursive: true,
                force: true,
                errorOnExist: false,
            });
            if (shouldReseedBecauseUnsigned) {
                console.log(`[ChromeManager] Reseeded automation profile from ${CHROME_PROFILE_DIR} (sign-in repair)`);
            } else {
                console.log(`[ChromeManager] Seeded automation profile from ${CHROME_PROFILE_DIR}`);
            }
        }

        if (!fs.existsSync(dstLocalState) && fs.existsSync(srcLocalState)) {
            fs.copyFileSync(srcLocalState, dstLocalState);
        }
    } catch (err) {
        console.warn(`[ChromeManager] Automation profile clone warning: ${err?.message || err}`);
    }
}

function isChromeRunning() {
    try {
        const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], {
            windowsHide: true,
            encoding: 'utf8'
        });
        return /chrome\.exe/i.test(output || '');
    } catch {
        return false;
    }
}

function killAllChromeProcesses() {
    try {
        execFileSync('taskkill', ['/IM', 'chrome.exe', '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if Chrome CDP is already running and accessible.
 */
async function isCdpAlive() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${CDP_URL}/json/version`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
            const data = await res.json();
            console.log(`[ChromeManager] CDP alive — ${data.Browser}`);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Launch Chrome with remote debugging port.
 * Waits until CDP is ready before returning.
 */
async function launchChrome(opts = {}) {
    const { sideBySide = false } = opts;
    if (isLaunching) {
        // Another call is already launching — wait for it
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await isCdpAlive()) return;
        }
        throw new Error('Chrome launch timed out (another launch in progress)');
    }

    isLaunching = true;
    try {
        console.log(`[ChromeManager] Launching Chrome: ${CHROME_PATH}`);
        console.log(`[ChromeManager] CDP endpoint: ${CDP_URL}`);
        const userDataDir = sideBySide ? CHROME_AUTOMATION_USER_DATA_DIR : CHROME_USER_DATA_DIR;
        const profileDir = sideBySide ? CHROME_AUTOMATION_PROFILE_DIR : CHROME_PROFILE_DIR;
        console.log(`[ChromeManager] User data dir: ${userDataDir}`);
        console.log(`[ChromeManager] Profile dir: ${profileDir}`);

        if (!fs.existsSync(CHROME_PATH)) {
            throw new Error(`Chrome not found at: ${CHROME_PATH}`);
        }
        if (sideBySide) {
            ensureAutomationProfileSeeded();
        } else if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }

        const args = [
            `--user-data-dir=${userDataDir}`,
            `--profile-directory=${profileDir}`,
            `--remote-debugging-port=${CDP_PORT}`,
            '--remote-debugging-address=127.0.0.1',
            '--remote-allow-origins=*',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--excludeSwitches=enable-automation',
            '--flag-switches-begin',
            '--flag-switches-end',
        ];
        if (sideBySide) {
            args.push('--new-window');
        }

        chromeProcess = execFile(CHROME_PATH, args, { windowsHide: false });

        chromeProcess.on('error', (err) => {
            console.error(`[ChromeManager] Chrome process error: ${err.message}`);
            chromeProcess = null;
        });

        chromeProcess.on('exit', (code) => {
            console.log(`[ChromeManager] Chrome exited with code ${code}`);
            chromeProcess = null;
        });

        // Wait for CDP to become available (max 45 seconds for heavy profiles/extensions)
        for (let i = 0; i < 45; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await isCdpAlive()) {
                console.log(`[ChromeManager] Chrome ready after ${i + 1}s`);
                return;
            }
        }

        throw new Error('Chrome launched but CDP not accessible after 45s');
    } finally {
        isLaunching = false;
    }
}

/**
 * Get the Chrome CDP endpoint URL.
 * Auto-launches Chrome if not already running.
 * Returns the HTTP endpoint (e.g., "http://127.0.0.1:9222").
 */
export async function getChromeEndpoint() {
    if (await isCdpAlive()) {
        return CDP_URL;
    }

    if (EXISTING_CHROME_ONLY && isChromeRunning()) {
        if (AUTO_RESTART_WITH_CDP) {
            if (CHROME_SIDE_BY_SIDE) {
                console.warn('[ChromeManager] Chrome is running without CDP. Launching side-by-side automation Chrome with CDP...');
                await launchChrome({ sideBySide: true });
            } else {
                console.warn('[ChromeManager] Chrome is running without CDP. Restarting Chrome with CDP on same profile...');
                killAllChromeProcesses();
                await new Promise((r) => setTimeout(r, 1200));
                await launchChrome();
            }
            return CDP_URL;
        }
        throw new Error(
            'Chrome is already running without CDP. ' +
            'Close all Chrome windows and relaunch Chrome with --remote-debugging-port=' +
            `${CDP_PORT}, or set CHROME_CDP_URL to an active debuggable Chrome endpoint. ` +
            'Auto-launch is disabled to avoid creating a new browser instance.'
        );
    }

    if (EXISTING_CHROME_ONLY && !isChromeRunning()) {
        throw new Error(
            'No debuggable Chrome found. Start your existing Chrome with --remote-debugging-port=' +
            `${CDP_PORT}, or set CHROME_CDP_URL. Auto-launch is disabled by CHROME_ATTACH_ONLY mode.`
        );
    }

    console.log('[ChromeManager] Chrome CDP not running — auto-launching...');
    await launchChrome();
    return CDP_URL;
}

/**
 * Shutdown the Chrome process (call on server shutdown).
 */
export async function shutdownChrome() {
    if (chromeProcess) {
        console.log('[ChromeManager] Shutting down Chrome...');
        chromeProcess.kill();
        chromeProcess = null;
    }
}
