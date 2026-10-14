/**
 * Server-side break-glass commands. In the Docker image:
 *   docker exec ac-modern ac-modern reset-password you@example.com
 *   docker exec ac-modern ac-modern make-owner you@example.com
 * From a checkout: pnpm cli reset-password you@example.com
 * Uses the same database settings as the server (ACM_DATA_DIR / ACM_DATABASE_URL).
 */
import { membershipsOf, userByEmail } from '../src/lib/server/accounts.ts';
import { db } from '../src/lib/server/db.ts';
import { record } from '../src/lib/server/events.ts';
import { cliReset } from '../src/lib/server/passwords.ts';

const HELP = `ac·modern command line

  reset-password <email> [--password <new password>]
      Sets a new password (a random one is generated and printed if you don't give one)
      and signs the account out everywhere. For when email isn't set up, or the only
      owner is locked out.

  make-owner <email> [--org <slug>]
      Makes an existing member an owner of the organisation (the only one, on a
      self-hosted install). For when the last owner has left.

Every change is written to the organisation's audit log.`;

function arg(name: string) {
	const i = process.argv.indexOf(name);
	return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
	const [cmd, email] = process.argv.slice(2);
	if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return void console.log(HELP);
	if (!email || email.startsWith('--')) throw new Error(`Usage: ${cmd} <email>`);
	const d = await db();

	if (cmd === 'reset-password') {
		const given = arg('--password');
		const r = await cliReset(d, email, given);
		console.log(`Password reset for ${r.email}. Their other sessions are signed out.`);
		if (!given) console.log(`New password: ${r.password}\n(Ask them to change it under Your account.)`);
		return;
	}

	if (cmd === 'make-owner') {
		const user = await userByEmail(d, email);
		if (!user) throw new Error(`No account for ${email}`);
		const orgs = await membershipsOf(d, user.id);
		const slug = arg('--org');
		let orgId: string | undefined;
		if (slug) orgId = (await d.get<{ id: string }>('SELECT id FROM orgs WHERE slug = ?', [slug]))?.id;
		else if (orgs.length === 1) orgId = orgs[0].orgId;
		else if (!orgs.length) throw new Error(`${email} isn't an active member of any organisation`);
		else throw new Error(`${email} is in several organisations; pass --org <slug>. Theirs: ${(await Promise.all(orgs.map((o) => d.get<{ slug: string }>('SELECT slug FROM orgs WHERE id = ?', [o.orgId])))).map((o) => o?.slug).join(', ')}`);
		if (!orgId || !orgs.some((o) => o.orgId === orgId)) throw new Error(`${email} isn't an active member of that organisation`);
		await d.run("UPDATE members SET role = 'owner', role_source = 'manual' WHERE org_id = ? AND user_id = ?", [orgId, user.id]);
		await record(d, { orgId, actorId: null, action: 'member.updated', subject: user.email, summary: `${user.email} made an owner from the server command line`, data: { role: { to: 'owner' } } });
		console.log(`${user.email} is now an owner.`);
		return;
	}
	throw new Error(`Unknown command "${cmd}". Run with --help.`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(`Error: ${(err as Error).message}`);
		process.exit(1);
	});
