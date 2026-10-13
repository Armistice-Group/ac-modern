/**
 * The URL the browser actually used. adapter-node assumes `https` when neither
 * ORIGIN nor PROTOCOL_HEADER is set, but Node itself never terminates TLS here:
 * a request is https only when a proxy says so via X-Forwarded-Proto. Getting
 * this wrong marks cookies `Secure` on plain http (so logins silently fail on a
 * LAN IP) and builds the wrong SSO callback URL.
 */
export function publicUrl(url: URL, headers: Headers): URL {
	if (process.env.ORIGIN || process.env.PROTOCOL_HEADER) return url;
	const forwarded = headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
	const out = new URL(url);
	out.protocol = forwarded === 'https' ? 'https:' : forwarded === 'http' ? 'http:' : import.meta.env.DEV ? url.protocol : 'http:';
	return out;
}
