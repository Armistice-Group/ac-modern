import { orgSettings } from './accounts.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { sweepExpiry } from './grants.ts';
import { syncDirectory } from './directory.ts';
import { syncSeats } from './billing.ts';
import { effects, flush } from './requests.ts';
import { runReviewSchedule } from './reviews.ts';

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
				await runReviewSchedule(d, o.id, fx);
				// Pulled directories (Google, Okta, Microsoft) sync on a schedule; SCIM pushes.
				const dir = await d.get<{ kind: string; last_sync_at: string | null }>('SELECT kind, last_sync_at FROM directory_sources WHERE org_id = ?', [o.id]);
				if (dir && dir.kind !== 'scim' && (!dir.last_sync_at || Date.now() - Date.parse(dir.last_sync_at) > config.directorySyncMinutes * 60_000)) {
					await syncDirectory(d, o.id, fx).catch((err) => console.warn(`[ac-modern] Directory sync for ${o.id} failed: ${(err as Error).message}`));
				}
				await flush(d, o.id, fx, config.publicUrl);
				await syncSeats(d, o.id).catch((err) => console.warn(`[ac-modern] Seat sync for ${o.id} failed: ${(err as Error).message}`));
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
