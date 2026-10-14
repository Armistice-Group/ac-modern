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

/**
 * Each shot: a page, optionally something to do there first (open a dialog…). `light`
 * shots are taken in the light theme as well. Paths are resolved after sign-in.
 */
const SHOTS = [
	{ name: 'overview', path: '/', light: true },
	{ name: 'catalog', path: '/catalog', light: true },
	{ name: 'request-dialog', path: '/catalog', act: (p) => p.locator('article', { hasText: 'Production database' }).locator('button:has-text("Request")').click() },
	{ name: 'requests', path: '/requests?view=approve' },
	{ name: 'request', path: '/requests/3', light: true },
	{ name: 'access', path: '/access' },
	{ name: 'reviews', path: '/reviews' },
	{ name: 'review', path: async (p) => (await p.goto(`${APP}/reviews`), p.locator('a[href^="/reviews/"]').first().getAttribute('href')) },
	{ name: 'resources', path: '/resources' },
	{ name: 'resource', path: async (p) => (await p.goto(`${APP}/resources`), p.locator('a[href^="/resources/"]:has-text("AWS")').first().getAttribute('href')) },
	{ name: 'resource-editor', path: async (p) => (await p.goto(`${APP}/resources`), p.locator('a[href^="/resources/"]:has-text("Production database")').first().getAttribute('href')), act: (p) => p.click('button:has-text("Settings")'), full: true },
	{ name: 'people', path: '/people' },
	{ name: 'person', path: async (p) => (await p.goto(`${APP}/people`), p.locator('a[href^="/people/"]:has-text("Jamie Ortiz")').first().getAttribute('href')) },
	{ name: 'transfer', path: async (p) => (await p.goto(`${APP}/people`), p.locator('a[href^="/people/"]:has-text("Quinn Adams")').first().getAttribute('href')), act: async (p) => {
		await p.click('button:has-text("Transfer")');
		await p.fill('#reason', 'Moving from support to the platform team');
		await p.locator('dialog input[placeholder="Copy a teammate’s access…"]').fill('Sam');
		await p.locator('dialog button:has-text("Sam Rivera")').click();
		await p.locator('dialog label:has-text("Stripe")').click();
	} },
	{ name: 'evidence', path: '/evidence?from=2026-01-01', light: true },
	{ name: 'evidence-ticket', path: '/evidence/print?numbers=11', full: true },
	{ name: 'audit', path: '/audit' },
	{ name: 'settings-sso', path: '/settings/sso' },
	{ name: 'settings-directory', path: '/settings/directory' },
	{ name: 'settings-integrations', path: '/settings/integrations' },
	{ name: 'settings-api', path: '/settings/api' }
];

async function main() {
	if (!APP) await start();
	mkdirSync(OUT, { recursive: true });
	const browser = await chromium.launch();
	for (const theme of ['dark', 'light']) {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
		await ctx.addInitScript((t) => localStorage.setItem('acm-theme', t), theme);
		const page = await ctx.newPage();
		if (theme === 'dark') {
			// The sign-in page, before signing in.
			await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
			await page.screenshot({ path: join(OUT, 'login.png') });
			console.log('  ✓ docs/screenshots/login.png');
		}
		await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
		await page.fill('#email', 'avery@northwind.example');
		await page.fill('#pw', 'demo-password');
		await page.click('button:has-text("Sign in")');
		await page.waitForURL(`${APP}/`);
		for (const shot of SHOTS) {
			if (theme === 'light' && !shot.light) continue;
			const target = typeof shot.path === 'function' ? await shot.path(page) : shot.path;
			await page.goto(`${APP}${target}`, { waitUntil: 'networkidle' });
			if (shot.act) {
				await shot.act(page);
				await page.waitForLoadState('networkidle');
			}
			await sleep(350);
			const file = join(OUT, theme === 'dark' ? `${shot.name}.png` : `${shot.name}-light.png`);
			await page.screenshot({ path: file, fullPage: !!shot.full });
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
