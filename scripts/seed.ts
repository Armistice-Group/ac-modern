/**
 * Demo data for screenshots and trying things out:
 *   ACM_DATA_DIR=./demo-data pnpm seed
 * Signs in as avery@northwind.example / demo-password.
 */
import { addMember, createUser, updateMember } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { hashPassword } from '../src/lib/server/crypto.ts';
import { db } from '../src/lib/server/db.ts';
import { recordGrant } from '../src/lib/server/grants.ts';
import { complete, createRequest, decide, effects } from '../src/lib/server/requests.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { createReview, decideItem, reviewItems } from '../src/lib/server/reviews.ts';

const d = await db();
if ((await d.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orgs'))!.n > 0) {
	console.log('Already has data; point ACM_DATA_DIR at an empty folder.');
	process.exit(0);
}
const PASSWORD = 'demo-password';
const { user: avery, org } = await setupOrg({ orgName: 'Northwind Labs', email: 'avery@northwind.example', name: 'Avery Chen', password: PASSWORD });
const hash = hashPassword(PASSWORD);
const person = async (name: string, title: string, role: 'admin' | 'member' = 'member') => {
	const u = await createUser(d, { email: `${name.split(' ')[0].toLowerCase()}@northwind.example`, name, passwordHash: hash });
	await addMember(d, org.id, u.id, role);
	await updateMember(d, org.id, u.id, { title });
	return u;
};
await updateMember(d, org.id, avery.id, { title: 'CTO' });
const jordan = await person('Jordan Patel', 'Engineering manager');
const morgan = await person('Morgan Lee', 'IT & security', 'admin');
const sam = await person('Sam Rivera', 'Backend engineer');
const casey = await person('Casey Nguyen', 'Frontend engineer');
const riley = await person('Riley Kim', 'Product designer');
const taylor = await person('Taylor Brooks', 'Finance lead');
const quinn = await person('Quinn Adams', 'Support engineer');
for (const u of [sam, casey, quinn]) await updateMember(d, org.id, u.id, { managerId: jordan.id });
await updateMember(d, org.id, riley.id, { managerId: avery.id });
await updateMember(d, org.id, taylor.id, { managerId: avery.id });
await updateMember(d, org.id, jordan.id, { managerId: avery.id });

const base = (o: Partial<ResourceInput> & Pick<ResourceInput, 'name' | 'roles'>): ResourceInput => ({
	description: '',
	category: 'app',
	url: '',
	color: 'violet',
	ownerId: morgan.id,
	approval: 'approvers',
	fulfillment: 'manual',
	webhookUrl: '',
	maxDays: null,
	defaultDays: null,
	requestable: true,
	approverIds: [],
	fulfillerIds: [morgan.id],
	...o
});
const res = async (o: Parameters<typeof base>[0]) => {
	const id = await saveResource(d, org.id, null, base(o));
	const roles = await d.all<{ id: string; name: string }>('SELECT id, name FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);
	return { id, role: (n: string) => roles.find((r) => r.name === n)!.id };
};
const github = await res({ name: 'GitHub', category: 'engineering', color: 'slate', url: 'https://github.com/northwind', description: 'Source code, pull requests and CI for every Northwind service.', ownerId: jordan.id, approval: 'manager', fulfillment: 'webhook', webhookUrl: 'https://automation.northwind.example/hooks/github', roles: [{ name: 'Member', description: 'Read and write to team repositories' }, { name: 'Maintainer', description: 'Manage settings of team repositories' }, { name: 'Owner', description: 'Full admin of the organisation' }] });
const aws = await res({ name: 'AWS', category: 'infrastructure', color: 'orange', url: 'https://northwind.awsapps.com/start', description: 'Production and staging accounts through IAM Identity Center.', ownerId: avery.id, approval: 'manager_then_approvers', approverIds: [avery.id, morgan.id], maxDays: 90, defaultDays: 30, roles: [{ name: 'ReadOnly', description: 'View resources and logs' }, { name: 'Developer', description: 'Deploy to staging' }, { name: 'Admin', description: 'Production break-glass' }] });
const figma = await res({ name: 'Figma', category: 'design', color: 'pink', url: 'https://figma.com', description: 'Design files, prototypes and the component library.', ownerId: riley.id, approval: 'none', roles: [{ name: 'Viewer', description: 'View and comment' }, { name: 'Editor', description: 'Paid editor seat' }] });
const gws = await res({ name: 'Google Workspace', category: 'productivity', color: 'blue', description: 'Email, Drive and Calendar.', approval: 'none', roles: [{ name: 'User', description: 'Standard account' }, { name: 'Admin', description: 'Workspace admin console' }] });
const pg = await res({ name: 'Production database', category: 'data', color: 'green', description: 'Postgres primary and read replicas.', ownerId: jordan.id, approval: 'approvers', approverIds: [jordan.id, avery.id], maxDays: 7, defaultDays: 1, roles: [{ name: 'Read-only', description: 'SELECT on the replica' }, { name: 'Read-write', description: 'Primary, time-boxed' }] });
const stripe = await res({ name: 'Stripe', category: 'finance', color: 'violet', url: 'https://dashboard.stripe.com', description: 'Payments, refunds and payouts.', ownerId: taylor.id, approval: 'approvers', approverIds: [taylor.id], roles: [{ name: 'Analyst', description: 'View payments and reports' }, { name: 'Support', description: 'Issue refunds' }, { name: 'Administrator', description: 'Everything, including payouts' }] });
const linear = await res({ name: 'Linear', category: 'engineering', color: 'cyan', description: 'Issues and roadmaps.', approval: 'none', roles: [{ name: 'Member', description: '' }, { name: 'Admin', description: '' }] });
const onepw = await res({ name: '1Password', category: 'security', color: 'amber', description: 'Shared vaults for team credentials.', approval: 'approvers', approverIds: [morgan.id], roles: [{ name: 'Engineering vault', description: '' }, { name: 'Finance vault', description: '' }] });

const A = (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin });
const rec = (u: { id: string }, r: { id: string; role: (n: string) => string }, role: string, expiresAt: string | null = null) =>
	recordGrant(d, A(avery, true), { userId: u.id, resourceId: r.id, roleId: r.role(role), expiresAt, note: 'From the onboarding spreadsheet', source: 'import' });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
for (const u of [avery, jordan, morgan, sam, casey, riley, taylor, quinn]) await rec(u, gws, u === morgan ? 'Admin' : 'User');
for (const u of [jordan, sam, casey, quinn]) await rec(u, github, 'Member');
await rec(avery, github, 'Owner');
await rec(morgan, github, 'Owner');
for (const u of [avery, jordan, sam, casey, riley, quinn]) await rec(u, linear, 'Member');
await rec(riley, figma, 'Editor');
await rec(casey, figma, 'Viewer');
await rec(jordan, aws, 'Developer', inDays(40));
await rec(sam, aws, 'Developer', inDays(5));
await rec(avery, aws, 'Admin');
await rec(taylor, stripe, 'Administrator');
await rec(quinn, stripe, 'Support', inDays(3));
await rec(morgan, onepw, 'Engineering vault');
await rec(taylor, onepw, 'Finance vault');

const fx = effects();
const ask = (u: { id: string }, r: { id: string; role: (n: string) => string }, role: string, why: string, days: number | null = null) =>
	createRequest(d, A(u), { userId: u.id, resourceId: r.id, roleId: r.role(role), justification: why, durationDays: days }, fx);

// Done: full path.
const r1 = await ask(casey, aws, 'ReadOnly', 'Debugging the image-resize Lambda timeouts (NW-311)', 30);
await decide(d, A(jordan), r1.id, 'approved', '', fx);
await decide(d, A(morgan, true), r1.id, 'approved', 'Read-only is fine', fx);
await complete(d, A(morgan, true), r1.id, 'Added to the ReadOnly permission set', fx);
// Denied.
const r2 = await ask(quinn, stripe, 'Administrator', 'Need to check a payout for a customer', 7);
await decide(d, A(taylor), r2.id, 'denied', 'Support role covers refunds; ask me for payout questions', fx);
// Waiting on Avery (step 2 of AWS).
const r3 = await ask(sam, aws, 'Admin', 'Rotating the RDS master password during tonight’s maintenance window', 1);
await decide(d, A(jordan), r3.id, 'approved', 'Planned maintenance, approved', fx);
// Waiting on Avery as approver.
const r4 = await ask(sam, pg, 'Read-write', 'Backfilling invoice_totals after the migration (NW-298)', 1);
// Waiting for setup by Morgan (no approval needed).
const r5 = await ask(riley, gws, 'Admin', 'Setting up the shared design calendar and room resources');
void r5;
// Waiting on Jordan (manager).
await ask(quinn, aws, 'ReadOnly', 'Looking at CloudWatch logs for support tickets', 30);
await ask(casey, onepw, 'Engineering vault', 'Need the Sentry and Vercel tokens for the new frontend app');
void r4;

// A review, partly done.
const reviewId = await createReview(d, A(avery, true), { name: 'Q3 2026 access review', dueAt: inDays(6), resourceIds: [github.id, stripe.id, aws.id] }, fx);
const items = await reviewItems(d, org.id, reviewId);
for (const i of items.slice(0, 5)) await decideItem(d, A(avery, true), i.id, 'keep', '', fx);

// Spread timestamps over the past week so the timeline reads naturally.
const reqs = await d.all<{ id: string; number: number }>('SELECT id, number FROM requests WHERE org_id = ? ORDER BY number', [org.id]);
for (const r of reqs) {
	const shift = (reqs.length - r.number + 1) * 7 * 3_600_000;
	const at = (iso: string) => new Date(Date.parse(iso) - shift).toISOString();
	const row = (await d.get<{ created_at: string; updated_at: string; closed_at: string | null }>('SELECT created_at, updated_at, closed_at FROM requests WHERE id = ?', [r.id]))!;
	await d.run('UPDATE requests SET created_at = ?, updated_at = ?, closed_at = ? WHERE id = ?', [at(row.created_at), at(row.updated_at), row.closed_at ? at(row.closed_at) : null, r.id]);
	const evs = await d.all<{ id: string; at: string }>('SELECT id, at FROM events WHERE request_id = ? ORDER BY at', [r.id]);
	for (const [i, e] of evs.entries()) await d.run('UPDATE events SET at = ? WHERE id = ?', [new Date(Date.parse(at(row.created_at)) + i * 47 * 60_000).toISOString(), e.id]);
}
const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
await d.run("UPDATE grants SET granted_at = ? WHERE org_id = ? AND source = 'import'", [old, org.id]);
await d.run("UPDATE events SET at = ? WHERE org_id = ? AND request_id IS NULL AND action IN ('org.created', 'grant.recorded', 'resource.created')", [old, org.id]);
console.log(`Seeded ${org.name}. Sign in as avery@northwind.example / ${PASSWORD} (or jordan@, sam@, morgan@ …).`);
process.exit(0);
