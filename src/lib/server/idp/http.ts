/** Small fetch helpers shared by the directory and provisioning clients. Tests inject `fetch`. */
export type Fetch = typeof fetch;

export class ProviderError extends Error {}

export async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		let detail = text.slice(0, 300);
		try {
			const j = JSON.parse(text);
			detail = j.error_description ?? j.error?.message ?? j.errorSummary ?? j.message ?? (typeof j.error === 'string' ? j.error : detail);
		} catch {}
		throw new ProviderError(`${what}: ${res.status} ${detail}`.trim());
	}
	return (await res.json()) as T;
}

/** An account found in a connected system, for reconciliation: an email, a login, or both. */
export interface MemberAccount {
	email?: string;
	login?: string;
	name?: string;
}
