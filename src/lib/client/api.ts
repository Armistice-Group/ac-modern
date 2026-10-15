import type { ProblemInfo } from '#lib/types.ts';

/** A failed API call: the server's message, status, and any hint/confirm flag it sent. */
export class ApiError extends Error {
	status: number;
	detail?: ProblemInfo & { confirmRequired?: boolean; title?: string; confirmLabel?: string; preprint?: unknown };

	constructor(message: string, status: number, detail?: ProblemInfo & { confirmRequired?: boolean; title?: string; confirmLabel?: string; preprint?: unknown }) {
		super(message);
		this.status = status;
		this.detail = detail;
	}
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const res = await fetch(url, {
		method,
		// Always JSON for writes, even body-less DELETEs: SvelteKit's CSRF check treats a
		// missing content type like a form post and rejects it when the origin it assumes
		// (https, without ORIGIN/PROTOCOL_HEADER) differs from the browser's.
		headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal
	});
	if (res.status === 401 && !url.startsWith('/api/auth/')) {
		location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(data.message ?? res.statusText, res.status, data);
	return data as T;
}

export const api = {
	get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal),
	post: <T>(url: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', url, body ?? {}, signal),
	put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
	patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
	del: <T>(url: string) => request<T>('DELETE', url)
};

export function errorMessage(err: unknown): string {
	if (err instanceof ApiError && err.detail?.hint) return `${err.message}. ${err.detail.hint}`;
	return err instanceof Error ? err.message : String(err);
}

/** A write that went to a second admin instead of applying (HTTP 202 `{ pending: true }`). */
export function wentForApproval(r: unknown): boolean {
	return !!r && typeof r === 'object' && (r as { pending?: boolean }).pending === true;
}
