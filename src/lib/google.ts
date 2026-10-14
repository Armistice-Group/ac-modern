/**
 * Google Workspace setup details shared by the server and the settings pages: the scopes
 * to authorise, reading a pasted key, and turning Google's errors into the step to fix.
 */

/** Read-only: directory sync. */
export const GOOGLE_DIRECTORY_SCOPES = [
	'https://www.googleapis.com/auth/admin.directory.user.readonly',
	'https://www.googleapis.com/auth/admin.directory.group.readonly',
	'https://www.googleapis.com/auth/admin.directory.group.member.readonly'
];
/** Read-write: provisioning (group membership, account suspension). */
export const GOOGLE_PROVISIONING_SCOPES = ['https://www.googleapis.com/auth/admin.directory.group.member', 'https://www.googleapis.com/auth/admin.directory.user'];

export const GOOGLE_LINKS = {
	adminSdk: 'https://console.cloud.google.com/apis/library/admin.googleapis.com',
	serviceAccounts: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
	delegation: 'https://admin.google.com/ac/owl/domainwidedelegation',
	docs: 'https://ac-modern.mintlify.app/integrations/google-workspace'
};

export interface ServiceAccountKey {
	clientId: string;
	clientEmail: string;
	projectId: string;
	privateKey: string;
}

/** Parses a pasted key file, or says what was pasted instead. */
export function parseServiceAccountKey(json: string): ServiceAccountKey | { error: string } {
	let k: Record<string, unknown>;
	try {
		k = JSON.parse(json);
	} catch {
		return { error: 'That isn’t a JSON key file. Paste the whole file you downloaded, from { to }.' };
	}
	if (k && typeof k === 'object' && ('web' in k || 'installed' in k))
		return { error: 'That’s an OAuth client, not a service account key. Create the key under IAM & Admin → Service accounts → your account → Keys.' };
	if (!k || k.type !== 'service_account' || typeof k.client_email !== 'string' || typeof k.private_key !== 'string')
		return { error: 'That isn’t a service account key. It should contain "type": "service_account", a client_email and a private_key.' };
	return { clientId: String(k.client_id ?? ''), clientEmail: k.client_email, projectId: String(k.project_id ?? ''), privateKey: k.private_key };
}

/** The setup step that fixes a Google error, or '' if we don't recognise it. */
export function googleHint(message: string, clientId = ''): string {
	const m = message.toLowerCase();
	if (m.includes('unauthorized_client') || m.includes('not authorized for any of the scopes'))
		return `Domain-wide delegation isn’t set up for this service account with every scope listed. In the Admin console, add client ID ${clientId || '(from the key)'} with the scopes shown, then try again. New entries can take a few minutes to work.`;
	if (m.includes('has not been used in project') || m.includes('accessnotconfigured') || m.includes('service_disabled') || m.includes('it is disabled'))
		return 'Turn on the Admin SDK API in the service account’s Google Cloud project, wait a minute, then try again.';
	if (m.includes('invalid email or user id'))
		return 'The admin to act as must be the email of a real user in your Workspace (not a group, alias or the service account).';
	if (m.includes('invalid jwt signature') || m.includes('invalid_grant: invalid signature') || m.includes('account not found'))
		return 'Google doesn’t recognise this key: it may have been deleted. Create a new JSON key for the service account and paste it.';
	if (m.includes('short-lived token') || m.includes('invalid jwt: token'))
		return 'This server’s clock is wrong; Google rejects tokens from clocks that are off by more than a few minutes. Turn on NTP.';
	if (m.includes('not authorized to access this resource'))
		return 'The admin to act as isn’t allowed to read the directory. Use a super admin, or an admin role with the Users and Groups read privileges.';
	return '';
}
