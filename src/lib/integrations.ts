import type { IntegrationKind, LevelMapping } from './types.ts';

/** What each built-in integration is, for the server and the UI alike. */
export const INTEGRATIONS: Record<IntegrationKind, { name: string; summary: string }> = {
	github: { name: 'GitHub', summary: 'Adds and removes org members and team members.' },
	google: { name: 'Google Workspace', summary: 'Adds and removes group members; suspends accounts.' },
	okta: { name: 'Okta', summary: 'Adds and removes group members or app assignments; Okta does the rest.' },
	authentik: { name: 'Authentik', summary: 'Adds and removes group members; app policies follow the groups.' },
	entra: { name: 'Microsoft Entra ID', summary: 'Adds and removes security group members through Microsoft Graph.' }
};

export const INTEGRATION_KINDS = Object.keys(INTEGRATIONS) as IntegrationKind[];

/** Integrations whose levels point at a group (or app) picked from a list the IdP returns. */
export const TARGET_KINDS: IntegrationKind[] = ['okta', 'authentik', 'entra'];

/** Is this mapping complete and right for the integration? */
export function mappingValid(kind: IntegrationKind, m: LevelMapping | undefined): boolean {
	if (!m) return false;
	switch (kind) {
		case 'github':
			return m.type === 'github_org' || (m.type === 'github_team' && !!m.team);
		case 'google':
			return m.type === 'google_account' || (m.type === 'google_group' && /@/.test(m.group));
		case 'okta':
			return (m.type === 'okta_group' || m.type === 'okta_app') && !!m.id;
		case 'authentik':
			return m.type === 'authentik_group' && !!m.id;
		case 'entra':
			return m.type === 'entra_group' && !!m.id;
	}
}

/** "group Engineering", "app Salesforce"… for messages and evidence. */
export function mappingLabel(m: LevelMapping): string {
	switch (m.type) {
		case 'github_org':
			return `org ${m.role === 'admin' ? 'owner' : 'member'}`;
		case 'github_team':
			return `team ${m.team} (${m.role})`;
		case 'google_group':
			return `group ${m.group} (${m.role.toLowerCase()})`;
		case 'google_account':
			return 'the account';
		case 'okta_app':
			return `app ${m.name || m.id}`;
		default:
			return `group ${m.name || m.id}`;
	}
}
