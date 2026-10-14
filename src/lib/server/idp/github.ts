import { type Fetch, jsonOrThrow, ProviderError } from './http.ts';

/**
 * GitHub organisation membership and teams, with a token that can administer the org
 * (classic PAT with admin:org, or a fine-grained token with Members read/write).
 */
export interface GitHubConfig {
	org: string;
	token: string;
	apiUrl?: string;
}

const api = (cfg: GitHubConfig) => (cfg.apiUrl || 'https://api.github.com').replace(/\/$/, '');

async function gh(cfg: GitHubConfig, f: Fetch, method: string, path: string, body?: unknown): Promise<Response> {
	return f(`${api(cfg)}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${cfg.token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'ac-modern',
			...(body ? { 'content-type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
}

async function ok(res: Response, what: string) {
	if (res.ok || res.status === 204) return;
	await jsonOrThrow(res, what);
}

export async function testGitHub(cfg: GitHubConfig, f: Fetch = fetch) {
	const org = await jsonOrThrow<{ login: string; name?: string }>(await gh(cfg, f, 'GET', `/orgs/${cfg.org}`), 'GitHub organisation');
	const me = await jsonOrThrow<{ login: string }>(await gh(cfg, f, 'GET', '/user'), 'GitHub token');
	const membership = await jsonOrThrow<{ role: string }>(await gh(cfg, f, 'GET', `/user/memberships/orgs/${cfg.org}`), 'Your membership');
	if (membership.role !== 'admin') throw new ProviderError(`@${me.login} isn’t an owner of ${org.login}, so it can’t add or remove members`);
	return { org: org.name || org.login, as: me.login };
}

export async function listTeams(cfg: GitHubConfig, f: Fetch = fetch) {
	const out: { slug: string; name: string }[] = [];
	for (let page = 1; page < 20; page++) {
		const teams = await jsonOrThrow<{ slug: string; name: string }[]>(await gh(cfg, f, 'GET', `/orgs/${cfg.org}/teams?per_page=100&page=${page}`), 'GitHub teams');
		out.push(...teams.map((t) => ({ slug: t.slug, name: t.name })));
		if (teams.length < 100) break;
	}
	return out;
}

export type GitHubLevel = { type: 'github_org'; role: 'member' | 'admin' } | { type: 'github_team'; team: string; role: 'member' | 'maintainer' };

async function teamId(cfg: GitHubConfig, f: Fetch, slug: string): Promise<number> {
	return (await jsonOrThrow<{ id: number }>(await gh(cfg, f, 'GET', `/orgs/${cfg.org}/teams/${encodeURIComponent(slug)}`), `GitHub team ${slug}`)).id;
}

/** Gives access. Returns what happened, for the request's note. */
export async function githubGrant(cfg: GitHubConfig, level: GitHubLevel, who: { email: string; login: string }, f: Fetch = fetch): Promise<string> {
	if (who.login) {
		if (level.type === 'github_org') {
			await ok(await gh(cfg, f, 'PUT', `/orgs/${cfg.org}/memberships/${encodeURIComponent(who.login)}`, { role: level.role }), 'GitHub membership');
			return `GitHub: @${who.login} is now an org ${level.role === 'admin' ? 'owner' : 'member'} (invitation sent if they weren’t one)`;
		}
		await ok(await gh(cfg, f, 'PUT', `/orgs/${cfg.org}/teams/${encodeURIComponent(level.team)}/memberships/${encodeURIComponent(who.login)}`, { role: level.role }), 'GitHub team membership');
		return `GitHub: @${who.login} added to team ${level.team} as ${level.role}`;
	}
	// No username on file: invite by email.
	const body = level.type === 'github_org' ? { email: who.email, role: level.role === 'admin' ? 'admin' : 'direct_member' } : { email: who.email, role: 'direct_member', team_ids: [await teamId(cfg, f, level.team)] };
	await ok(await gh(cfg, f, 'POST', `/orgs/${cfg.org}/invitations`, body), 'GitHub invitation');
	return `GitHub: invitation sent to ${who.email}${level.type === 'github_team' ? ` (team ${level.team})` : ''}. Add their GitHub username in ac·modern so removal can be automatic.`;
}

export async function githubRevoke(cfg: GitHubConfig, level: GitHubLevel, who: { email: string; login: string }, f: Fetch = fetch): Promise<string> {
	if (who.login) {
		if (level.type === 'github_team') {
			const res = await gh(cfg, f, 'DELETE', `/orgs/${cfg.org}/teams/${encodeURIComponent(level.team)}/memberships/${encodeURIComponent(who.login)}`);
			if (res.status !== 404) await ok(res, 'GitHub team membership');
			return `GitHub: @${who.login} removed from team ${level.team}`;
		}
		const res = await gh(cfg, f, 'DELETE', `/orgs/${cfg.org}/memberships/${encodeURIComponent(who.login)}`);
		if (res.status !== 404) await ok(res, 'GitHub membership');
		return `GitHub: @${who.login} removed from ${cfg.org}`;
	}
	// No username: cancel a pending invitation if there is one.
	const invites = await jsonOrThrow<{ id: number; email: string | null }[]>(await gh(cfg, f, 'GET', `/orgs/${cfg.org}/invitations?per_page=100`), 'GitHub invitations');
	const inv = invites.find((i) => i.email?.toLowerCase() === who.email.toLowerCase());
	if (!inv) throw new ProviderError(`no GitHub username on file for ${who.email} and no pending invitation, so it can’t be removed automatically`);
	await ok(await gh(cfg, f, 'DELETE', `/orgs/${cfg.org}/invitations/${inv.id}`), 'GitHub invitation');
	return `GitHub: cancelled the pending invitation for ${who.email}`;
}
