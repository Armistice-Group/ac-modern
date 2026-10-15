import { userByEmail } from './accounts.ts';
import type { Db } from './db.ts';
import { listEvents, requestTimeline } from './events.ts';
import { ticket } from './evidence.ts';
import { listGrants } from './grants.ts';
import { HttpError } from './http.ts';
import { abilities, cancel, CAPACITY_LABEL, createRequest, decide, effects, flush, getRequest, listRequests, waitingOn, type Actor } from './requests.ts';
import { getResource, listResources } from './resources.ts';
import type { AccessRequest, Resource } from '#lib/types.ts';

/**
 * The MCP server: lets an AI assistant (Claude, Cursor…) request access, check on requests
 * and, when the token allows it, approve or deny, all as the member who made the token.
 * Streamable HTTP, stateless, JSON responses. Everything goes through the same workflow
 * as the web, and the audit log records it as done "via MCP".
 */

export interface McpAuth {
	orgId: string;
	userId: string;
	admin: boolean;
	canApprove: boolean;
}

interface JsonRpc {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Tool = {
	name: string;
	title: string;
	description: string;
	inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
	annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	approve?: boolean;
	admin?: boolean;
};

const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'integer', description });

export const TOOLS: Tool[] = [
	{
		name: 'list_systems',
		title: 'List systems',
		description: 'Systems (apps, infrastructure, data) you can request access to, with their access levels, whether a level is privileged, its approval rule, and what you already hold.',
		inputSchema: { type: 'object', properties: { query: s('Filter by name, e.g. "github"') } },
		annotations: { readOnlyHint: true }
	},
	{
		name: 'request_access',
		title: 'Request access',
		description:
			'Ask for access to a system at an access level. It then goes to the approvers (or is auto-approved by a rule), and is set up once approved. Confirm the system, level, duration and reason with the user before calling.',
		inputSchema: {
			type: 'object',
			properties: {
				system: s('System name or id, as list_systems shows it'),
				level: s('Access level name or id; optional when the system has only one'),
				justification: s('Why the access is needed, in the user’s words. Approvers and auditors read this.'),
				duration_days: n('How long, in days. Omit for the system’s default.'),
				for_email: s('Request for someone else (managers and admins). Omit for yourself.')
			},
			required: ['system', 'justification']
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},
	{
		name: 'my_access',
		title: 'My access',
		description: 'Access you hold now, with when each ends.',
		inputSchema: { type: 'object', properties: {} },
		annotations: { readOnlyHint: true }
	},
	{
		name: 'my_requests',
		title: 'My requests',
		description: 'Requests you made or that are for you, newest first.',
		inputSchema: { type: 'object', properties: { open_only: { type: 'boolean', description: 'Only requests still waiting for approval or setup' } } },
		annotations: { readOnlyHint: true }
	},
	{
		name: 'get_request',
		title: 'Get a request',
		description: 'One request: who it’s for, the reason, each approval with the approver’s capacity, and its timeline.',
		inputSchema: { type: 'object', properties: { number: n('The request number, e.g. 42') }, required: ['number'] },
		annotations: { readOnlyHint: true }
	},
	{
		name: 'pending_approvals',
		title: 'Waiting on me',
		description: 'Requests waiting for your approval, and setup tasks assigned to you.',
		inputSchema: { type: 'object', properties: {} },
		annotations: { readOnlyHint: true }
	},
	{
		name: 'approve_request',
		title: 'Approve a request',
		description: 'Approve a request waiting on you. Only call this when the user has explicitly said to approve this specific request number.',
		inputSchema: { type: 'object', properties: { number: n('The request number'), comment: s('Optional note for the record') }, required: ['number'] },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		approve: true
	},
	{
		name: 'deny_request',
		title: 'Deny a request',
		description: 'Deny a request waiting on you. The reason is shown to the requester. Only call this when the user has explicitly said to deny it.',
		inputSchema: { type: 'object', properties: { number: n('The request number'), reason: s('Why, in the user’s words') }, required: ['number', 'reason'] },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		approve: true
	},
	{
		name: 'cancel_request',
		title: 'Cancel a request',
		description: 'Withdraw your own request while it’s waiting for approval.',
		inputSchema: { type: 'object', properties: { number: n('The request number'), reason: s('Optional') }, required: ['number'] },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
	},
	{
		name: 'audit_log',
		title: 'Audit log',
		description: 'Search the organisation’s audit log (admins only): requests, approvals, grants, removals, setting and rule changes.',
		inputSchema: {
			type: 'object',
			properties: { query: s('Text to match, e.g. a person, system or "approved"'), from: s('ISO date, inclusive'), to: s('ISO date, exclusive'), limit: n('At most this many (default 50, max 200)') }
		},
		annotations: { readOnlyHint: true },
		admin: true
	}
];

/** What the server tells the client about itself. */
const INSTRUCTIONS =
	'ac·modern manages access requests and approvals for an organisation. Use list_systems to find the exact system and level before request_access. ' +
	'Never approve or deny unless the user explicitly asks for that specific request number; summarise the request first. ' +
	'Everything you do is recorded in the audit log as done by the user via MCP.';

const who = (u: { name: string; email: string }) => u.name || u.email;
const dayCount = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

function requestLine(r: AccessRequest) {
	const status = { pending_approval: 'waiting for approval', pending_fulfillment: 'approved, being set up', completed: 'done', denied: 'denied', cancelled: 'cancelled' }[r.status];
	return `#${r.number} ${r.kind === 'revoke' ? 'Removal of' : ''} ${r.resource.name} (${r.role.name}) for ${who(r.user)}: ${status}${r.durationDays ? `, ${dayCount(r.durationDays)}` : ''}${r.autoRule ? ` (auto-approved by “${r.autoRule.name}”)` : ''}`.replace('  ', ' ');
}

const norm = (v: string) => v.trim().toLowerCase();

/** Finds a system and level by id or name; a level can be left out when there's only one. */
export async function findLevel(db: Db, orgId: string, system: string, level?: string): Promise<{ resource: Resource; roleId: string }> {
	const all = (await listResources(db, orgId)).filter((r) => !r.archived);
	const q = norm(system);
	const matches = all.filter((r) => r.id === system || norm(r.name) === q);
	const loose = matches.length ? matches : all.filter((r) => norm(r.name).includes(q));
	if (!loose.length) throw new HttpError(404, `No system called “${system}”. Use list_systems to see them.`);
	if (loose.length > 1) throw new HttpError(400, `“${system}” matches ${loose.map((r) => r.name).join(', ')}. Say which.`);
	const resource = loose[0];
	if (!level) {
		if (resource.roles.length === 1) return { resource, roleId: resource.roles[0].id };
		throw new HttpError(400, `${resource.name} has levels ${resource.roles.map((x) => x.name).join(', ')}. Say which.`);
	}
	const l = norm(level);
	const partial = resource.roles.filter((x) => norm(x.name).includes(l));
	const role = resource.roles.find((x) => x.id === level || norm(x.name) === l) ?? (partial.length === 1 ? partial[0] : undefined);
	if (!role) throw new HttpError(404, `${resource.name} has no level “${level}”. Its levels: ${resource.roles.map((x) => x.name).join(', ')}.`);
	return { resource, roleId: role.id };
}

async function callTool(db: Db, auth: McpAuth, name: string, args: Record<string, unknown>, origin: string): Promise<string> {
	const actor: Actor & { userId: string } = { orgId: auth.orgId, userId: auth.userId, admin: auth.admin };
	const tool = TOOLS.find((t) => t.name === name);
	if (!tool) throw new HttpError(404, `Unknown tool ${name}`);
	if (tool.approve && !auth.canApprove) throw new HttpError(403, 'This token can’t approve or deny. Make a token with “Can approve and deny” ticked under Account → AI assistants, or approve on the web.');
	if (tool.admin && !auth.admin) throw new HttpError(403, 'Only admins can read the audit log');
	const text = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
	const num = (k: string) => {
		const v = Number(args[k]);
		if (!Number.isInteger(v) || v < 1) throw new HttpError(400, `${k} must be a request number`);
		return v;
	};
	const link = (r: { number: number }) => `${origin}/requests/${r.number}`;

	switch (name) {
		case 'list_systems': {
			const q = norm(text('query'));
			const held = new Set((await listGrants(db, auth.orgId, { userId: auth.userId })).map((g) => g.role.id));
			const list = (await listResources(db, auth.orgId)).filter((r) => !r.archived && (r.requestable || auth.admin) && (!q || norm(r.name).includes(q) || norm(r.category).includes(q)));
			if (!list.length) return q ? `No systems match “${q}”.` : 'No systems yet.';
			return list
				.map(
					(r) =>
						`${r.name}${r.description ? ` — ${r.description}` : ''}\n  approval: ${r.approval}${r.maxDays ? `, at most ${dayCount(r.maxDays)}` : ''}${r.defaultDays ? `, default ${dayCount(r.defaultDays)}` : ''}\n` +
						r.roles.map((x) => `  - ${x.name}${x.privileged ? ' [privileged]' : ''}${held.has(x.id) ? ' (you have this)' : ''}${x.description ? `: ${x.description}` : ''}`).join('\n')
				)
				.join('\n');
		}
		case 'request_access': {
			const { resource, roleId } = await findLevel(db, auth.orgId, text('system'), text('level') || undefined);
			let userId = auth.userId;
			const forEmail = text('for_email');
			if (forEmail) {
				const u = await userByEmail(db, forEmail.toLowerCase());
				if (!u) throw new HttpError(404, `Nobody with the email ${forEmail} is in ac·modern`);
				userId = u.id;
			}
			const days = args.duration_days === undefined || args.duration_days === null ? null : Number(args.duration_days);
			if (days !== null && !Number.isInteger(days)) throw new HttpError(400, 'duration_days must be a whole number');
			const fx = effects();
			const req = await createRequest(db, actor, { userId, resourceId: resource.id, roleId, justification: text('justification'), durationDays: days, via: 'mcp' }, fx);
			await flush(db, auth.orgId, fx, origin);
			const now = await getRequest(db, auth.orgId, { id: req.id });
			const next =
				now.status === 'pending_approval'
					? `It’s waiting for approval (${(await abilities(db, actor, now, resource)).approverIds.length} approver(s) notified).`
					: now.status === 'completed'
						? 'It was set up straight away.'
						: now.autoRule
							? `It was auto-approved by the rule “${now.autoRule.name}” and is being set up.`
							: 'No approval needed; it’s being set up.';
			return `Created request #${now.number}: ${now.resource.name} (${now.role.name}) for ${who(now.user)}${now.durationDays ? `, ${dayCount(now.durationDays)}` : ''}. ${next}\n${link(now)}`;
		}
		case 'my_access': {
			const grants = await listGrants(db, auth.orgId, { userId: auth.userId });
			if (!grants.length) return 'You don’t hold any access recorded in ac·modern.';
			return grants.map((g) => `${g.resource.name} (${g.role.name})${g.expiresAt ? ` until ${g.expiresAt.slice(0, 10)}` : ''}${g.status === 'pending_revoke' ? ' — being removed' : ''}`).join('\n');
		}
		case 'my_requests': {
			const reqs = await listRequests(db, auth.orgId, { involving: auth.userId, statuses: args.open_only ? ['pending_approval', 'pending_fulfillment'] : undefined, limit: 25 });
			return reqs.length ? reqs.map(requestLine).join('\n') : 'No requests.';
		}
		case 'get_request': {
			const req = await getRequest(db, auth.orgId, { number: num('number') });
			const resource = await getResource(db, auth.orgId, req.resource.id);
			const can = await abilities(db, actor, req, resource);
			if (!can.view) throw new HttpError(403, 'You can’t see that request');
			const t = await ticket(db, auth.orgId, req.number);
			const approvals = t.approvals.map((a) => `  step ${a.step}: ${a.decision} by ${who(a.approver)} as ${CAPACITY_LABEL[a.capacity].toLowerCase()} at ${a.at}${a.comment ? ` (“${a.comment}”)` : ''}`);
			const events = (await requestTimeline(db, auth.orgId, req.id)).map((e) => `  ${e.at} ${e.actor ? who(e.actor) : 'ac·modern'}: ${e.summary}`);
			return [
				requestLine(req),
				`Requested by ${req.requester ? who(req.requester) : 'ac·modern'} on ${req.createdAt}`,
				req.justification ? `Reason: “${req.justification}”` : '',
				req.privileged ? 'Privileged access level.' : '',
				req.autoRule ? `Auto-approved by rule “${req.autoRule.name}”: ${req.autoRule.reason}` : '',
				approvals.length ? `Approvals:\n${approvals.join('\n')}` : '',
				can.approve ? 'It’s waiting on you.' : '',
				`Timeline:\n${events.join('\n')}`,
				link(req)
			]
				.filter(Boolean)
				.join('\n');
		}
		case 'pending_approvals': {
			const { toApprove, toFulfill } = await waitingOn(db, auth.orgId, auth.userId);
			const parts = [];
			if (toApprove.length) parts.push(`To approve:\n${toApprove.map((r) => `${requestLine(r)}\n  reason: “${r.justification}”${r.privileged ? ' [privileged]' : ''}`).join('\n')}`);
			if (toFulfill.length) parts.push(`To set up:\n${toFulfill.map(requestLine).join('\n')}`);
			return parts.join('\n\n') || 'Nothing is waiting on you.';
		}
		case 'approve_request':
		case 'deny_request': {
			const req = await getRequest(db, auth.orgId, { number: num('number') });
			const fx = effects();
			const approve = name === 'approve_request';
			await decide(db, actor, req.id, approve ? 'approved' : 'denied', approve ? text('comment') : text('reason'), fx, 'mcp');
			await flush(db, auth.orgId, fx, origin);
			const now = await getRequest(db, auth.orgId, { id: req.id });
			return approve
				? `Approved #${now.number}. ${now.status === 'pending_approval' ? 'It now goes to the next approver.' : now.status === 'completed' ? 'Access is set up.' : 'It’s being set up.'}\n${link(now)}`
				: `Denied #${now.number}; ${who(now.user)} will see your reason.\n${link(now)}`;
		}
		case 'cancel_request': {
			const req = await getRequest(db, auth.orgId, { number: num('number') });
			await cancel(db, actor, req.id, text('reason'));
			return `Cancelled #${req.number}.`;
		}
		case 'audit_log': {
			const day = (v: string) => (v ? (v.length === 10 ? `${v}T00:00:00.000Z` : new Date(v).toISOString()) : undefined);
			const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
			const events = await listEvents(db, auth.orgId, { q: text('query') || undefined, from: day(text('from')), to: day(text('to')), limit });
			return events.length ? events.map((e) => `${e.at} ${e.actor ? who(e.actor) : 'ac·modern'} [${e.action}]${e.requestNumber ? ` #${e.requestNumber}` : ''}: ${e.summary}`).join('\n') : 'No events match.';
		}
	}
	throw new HttpError(404, `Unknown tool ${name}`);
}

const result = (id: JsonRpc['id'], r: unknown) => ({ jsonrpc: '2.0' as const, id: id ?? null, result: r });
const error = (id: JsonRpc['id'], code: number, message: string) => ({ jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } });

async function one(db: Db, auth: McpAuth, msg: JsonRpc, origin: string, version: string) {
	if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(msg?.id, -32600, 'Invalid request');
	const isNotification = msg.id === undefined;
	switch (msg.method) {
		case 'initialize': {
			const asked = String(msg.params?.protocolVersion ?? '');
			return result(msg.id, {
				protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'ac-modern', title: 'ac·modern', version },
				instructions: INSTRUCTIONS
			});
		}
		case 'ping':
			return result(msg.id, {});
		case 'tools/list':
			return result(msg.id, {
				tools: TOOLS.filter((t) => (!t.approve || auth.canApprove) && (!t.admin || auth.admin)).map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }))
			});
		case 'tools/call': {
			const name = String(msg.params?.name ?? '');
			const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
			try {
				const text = await callTool(db, auth, name, args, origin);
				return result(msg.id, { content: [{ type: 'text', text }], isError: false });
			} catch (err) {
				if (err instanceof HttpError) return result(msg.id, { content: [{ type: 'text', text: err.message }], isError: true });
				console.error('[ac-modern] MCP tool', name, err);
				return result(msg.id, { content: [{ type: 'text', text: 'Something went wrong on the server' }], isError: true });
			}
		}
		default:
			if (isNotification) return null;
			return error(msg.id, -32601, `Method not found: ${msg.method}`);
	}
}

/** Handles one POST body: a message or a batch. Returns null when there's nothing to answer (notifications only). */
export async function handleMcp(db: Db, auth: McpAuth, body: unknown, origin: string, version = 'dev'): Promise<unknown> {
	if (Array.isArray(body)) {
		const out = [];
		for (const m of body) {
			const r = await one(db, auth, m as JsonRpc, origin, version);
			if (r && (m as JsonRpc).id !== undefined) out.push(r);
		}
		return out.length ? out : null;
	}
	const msg = body as JsonRpc;
	const r = await one(db, auth, msg, origin, version);
	return msg?.id === undefined ? null : r;
}
