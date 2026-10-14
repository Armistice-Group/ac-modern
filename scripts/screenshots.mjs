// Regenerates docs/screenshots/*.png from fictional demo data.
//
//   pnpm screenshots                  # seeds a throwaway data folder and starts its own dev server
//   ACM_URL=http://localhost:5311 pnpm screenshots   # or shoot an already-running, seeded server
//
// Needs a Playwright Chromium (`pnpm exec playwright install chromium`).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs/screenshots');
const PORT = 5317;
let APP = process.env.ACM_URL;
let server;
let tmp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
	tmp = mkdtempSync(join(tmpdir(), 'acm-shots-'));
	const env = { ...process.env, ACM_DATA_DIR: tmp, ACM_SECRET_KEY: 'screenshots', ACM_JOBS: 'off' };
	console.log('• seeding demo data');
	execFileSync('node', ['--no-warnings', '--experimental-strip-types', 'scripts/seed.ts'], { cwd: ROOT, env, stdio: 'inherit' });
	console.log('• starting ac·modern');
	server = spawn('pnpm', ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, env, stdio: 'ignore' });
	APP = `http://127.0.0.1:${PORT}`;
	for (let i = 0; i < 60; i++) {
		try {
			if ((await fetch(`${APP}/api/health`)).ok) return;
		} catch {}
		await sleep(500);
	}
	throw new Error('ac·modern did not start');
}

const SHOTS = [
	['overview', '/'],
	['catalog', '/catalog'],
	['requests', '/requests?view=approve'],
	['request', '/requests/3'],
	['access', '/access'],
	['review', null],
	['resource', null],
	['people', '/people'],
	['evidence', '/evidence?from=2026-01-01'],
	['settings-directory', '/settings/directory']
];

async function main() {
	if (!APP) await start();
	mkdirSync(OUT, { recursive: true });
	const browser = await chromium.launch();
	for (const theme of ['dark', 'light']) {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
		await ctx.addInitScript((t) => localStorage.setItem('acm-theme', t), theme);
		const page = await ctx.newPage();
		await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
		await page.fill('#email', 'avery@northwind.example');
		await page.fill('#pw', 'demo-password');
		await page.click('button:has-text("Sign in")');
		await page.waitForURL(`${APP}/`);
		for (const [name, path] of SHOTS) {
			if (theme === 'light' && !['overview', 'request', 'catalog'].includes(name)) continue;
			let target = path;
			if (name === 'review') {
				await page.goto(`${APP}/reviews`);
				target = await page.locator('a[href^="/reviews/"]').first().getAttribute('href');
			}
			if (name === 'resource') {
				await page.goto(`${APP}/resources`);
				target = await page.locator('a[href^="/resources/"]:has-text("AWS")').first().getAttribute('href');
			}
			await page.goto(`${APP}${target}`);
			await page.waitForLoadState('networkidle');
			await sleep(250);
			const file = join(OUT, theme === 'dark' ? `${name}.png` : `${name}-light.png`);
			await page.screenshot({ path: file });
			console.log(`  ✓ ${file.replace(ROOT + '/', '')}`);
		}
		await ctx.close();
	}
	await browser.close();
}

try {
	await main();
} finally {
	server?.kill();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
}
