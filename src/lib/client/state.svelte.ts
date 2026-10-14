/**
 * Shared client UI state: toasts, theme toggle and the
 * promise-based confirm dialog. Mount <Toaster /> and <ConfirmHost /> once in the root layout.
 * Import path in components: '#lib/client/state.svelte.ts' (copy this file there, or merge).
 */

export interface Toast {
	id: number;
	kind: 'success' | 'error' | 'info';
	title: string;
	body?: string;
}

let nextId = 1;
export const toasts = $state<Toast[]>([]);

export function toast(kind: Toast['kind'], title: string, body?: string) {
	const id = nextId++;
	toasts.push({ id, kind, title, body });
	setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
}

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}

export const theme = $state<{ value: 'dark' | 'light' }>({ value: 'dark' });

/** Persists the choice; app.html's inline script applies it before first paint. */
export function setTheme(value: 'dark' | 'light') {
	theme.value = value;
	document.documentElement.dataset.theme = value;
	try {
		localStorage.setItem('acm-theme', value);
	} catch {}
}

export interface ConfirmRequest {
	title: string;
	body?: string;
	/** Monospace detail, e.g. the exact command or SQL about to run. */
	detail?: string;
	confirmLabel?: string;
	danger?: boolean;
	resolve: (ok: boolean) => void;
}

/** The open confirmation dialog, rendered once by the root layout. */
export const confirmation = $state<{ request: ConfirmRequest | null }>({ request: null });

/** Asks the user to confirm; resolves false if they cancel or dismiss. */
export function confirmAction(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
	confirmation.request?.resolve(false);
	return new Promise((resolve) => (confirmation.request = { ...opts, resolve }));
}
