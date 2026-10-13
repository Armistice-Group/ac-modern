/** A random signing secret for webhooks (browser or Node). */
export function generateSecret(bytes = 24): string {
	const buf = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buf);
	return 'whsec_' + Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
