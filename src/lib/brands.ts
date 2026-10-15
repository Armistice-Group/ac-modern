import type { Brand } from '#lib/components/BrandLogo.svelte';

/** Which identity provider an OIDC issuer (or the name given to it) belongs to, for its logo. */
export function brandForIssuer(issuer: string, name = ''): Brand | null {
	const s = `${issuer} ${name}`.toLowerCase();
	if (/\/application\/o\/|authentik/.test(s)) return 'authentik';
	if (/okta(preview)?\.com|okta/.test(s)) return 'okta';
	if (/login\.microsoftonline\.com|sts\.windows\.net|entra|azure|microsoft/.test(s)) return 'entra';
	if (/accounts\.google\.com|google/.test(s)) return 'google';
	if (/github/.test(s)) return 'github';
	return null;
}
