import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'playwright-browsers') };

const r = spawnSync(process.execPath, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], {
  stdio: 'inherit',
  env,
  cwd: root
});
process.exit(r.status ?? 1);
