import { json } from '@sveltejs/kit';
import { createInvite } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest, body, forbidden, handler, oneOf } from '#lib/server/http.ts';
import { config } from '#lib/server/config.ts';

/** Invites one or more people by email. Returns the links so they can be shared by hand too. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const emails = String(b.emails ?? '')
		.split(/[\s,;]+/)
		.map((e) => e.trim())
		.filter(Boolean);
	if (!emails.length) throw badRequest('Enter at least one email address');
	if (emails.length > 100) throw badRequest('Invite at most 100 people at a time');
	const role = oneOf(b, 'role', ['member', 'admin'] as const, 'member');
	if (role === 'admin' && c.role !== 'owner' && c.role !== 'admin') throw forbidden();
	const d = await db();
	const links: { email: string; url: string }[] = [];
	for (const email of emails) {
		const { token } = await createInvite(d, c.org.id, email, role, c.user.id);
		const url = `${event.locals.origin}/invite/${token}`;
		links.push({ email: email.toLowerCase(), url });
		await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'member.invited', subject: email, summary: `Invited ${email} as ${role}` });
	}
	// Emails go out when SMTP is set up; the links are always returned for copying.
	if (config.smtp) {
		const { default: nodemailer } = await import('nodemailer');
		const t = nodemailer.createTransport(config.smtp.url);
		for (const l of links) {
			await t
				.sendMail({
					from: config.smtp.from,
					to: l.email,
					subject: `Join ${c.org.name} on ac·modern`,
					text: `${c.user.name || c.user.email} invited you to ${c.org.name} on ac·modern, where your team requests and approves access to tools.\n\n${l.url}\n\nThe link works once and expires in 14 days.`
				})
				.catch((err: Error) => console.warn(`[ac-modern] Invite email to ${l.email} failed: ${err.message}`));
		}
	}
	return json({ links, emailed: !!config.smtp });
});
