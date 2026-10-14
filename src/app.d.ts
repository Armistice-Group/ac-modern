import type { Membership, Org, Role, SessionUser } from '#lib/types.ts';

declare global {
	const __APP_VERSION__: string;
	namespace App {
		interface Locals {
			auth: 'setup' | 'anonymous' | 'authenticated';
			user: SessionUser | null;
			org: Org | null;
			role: Role | null;
			orgs: Membership[];
			sessionId: string | null;
			/** Signed in with a password to an org that requires SSO: send them through SSO first. */
			ssoRequired: boolean;
			/** The URL origin the browser used (for links in notifications). */
			origin: string;
			secure: boolean;
			ip?: string;
		}
	}
}

export {};
