import { orgSettings } from './accounts.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { sweepExpiry } from './grants.ts';
import { effects, flush } from './requests.ts';

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** One pass over every organisation: expire grants, send reminders. */
export async function runJobs() {
	if (running) return;
	running = true;
	try {
		const d = await db();
		const orgs = await d.all<{ id: string }>('SELECT id FROM orgs');
		for (const o of orgs) {
			try {
				const fx = effects();
				const settings = await orgSettings(d, o.id);
				await sweepExpiry(d, o.id, settings.expiryReminderDays ?? 3, fx);
				await flush(d, o.id, fx, config.publicUrl);
			} catch (err) {
				console.error(`[ac-modern] Jobs failed for org ${o.id}:`, err);
			}
		}
		await d.run('DELETE FROM sessions WHERE expires_at < ?', [new Date().toISOString()]);
	} finally {
		running = false;
	}
}

export function startJobs() {
	if (timer || process.env.ACM_JOBS === 'off') return;
	setTimeout(() => runJobs().catch((e) => console.error('[ac-modern]', e)), 5_000);
	timer = setInterval(() => runJobs().catch((e) => console.error('[ac-modern]', e)), config.jobIntervalMs);
	timer.unref?.();
}
