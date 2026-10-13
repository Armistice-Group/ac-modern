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
			/** The URL origin the browser used (for links in notifications). */
			origin: string;
			secure: boolean;
			ip?: string;
		}
	}
}

export {};
