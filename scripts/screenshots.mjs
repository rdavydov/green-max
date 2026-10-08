import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/screenshots.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_SCREENSHOTS: '1' },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
