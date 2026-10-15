<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Copy, Download, LoaderCircle, ShieldCheck, ShieldAlert } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { date } from '#lib/format.ts';

	let {
		mfa,
		requiredBy,
		setupRequired,
		hasPassword
	}: {
		mfa: { enabled: boolean; enabledAt: string | null; recoveryLeft: number; pending: boolean };
		requiredBy: string[];
		setupRequired: boolean;
		hasPassword: boolean;
	} = $props();

	let setup = $state<{ secret: string; uri: string; svg: string } | null>(null);
	let codes = $state<string[]>([]);
	let code = $state('');
	let busy = $state(false);
	let mode = $state<'' | 'regenerate' | 'disable'>('');

	async function begin() {
		busy = true;
		try {
			setup = await api.post('/api/account/mfa', {});
			code = '';
		} catch (err) {
			toast('error', 'Couldn’t start setup', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function confirm(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			codes = (await api.post<{ codes: string[] }>('/api/account/mfa/confirm', { code })).codes;
			setup = null;
			code = '';
			toast('success', 'Two-step verification is on', 'Other devices have been signed out.');
		} catch (err) {
			toast('error', 'Didn’t work', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function act(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			if (mode === 'regenerate') codes = (await api.post<{ codes: string[] }>('/api/account/mfa/recovery', { code })).codes;
			else {
				await api.post('/api/account/mfa/disable', { code });
				toast('success', 'Two-step verification is off');
				await invalidateAll();
			}
			mode = '';
			code = '';
		} catch (err) {
			toast('error', 'Didn’t work', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function done() {
		codes = [];
		await invalidateAll();
	}

	const copyCodes = () => (navigator.clipboard.writeText(codes.join('\n')), toast('success', 'Copied'));
	const downloadCodes = () => {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([`ac·modern recovery codes\nEach works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain' }));
		a.download = 'ac-modern-recovery-codes.txt';
		a.click();
	};
</script>

<section class="card p-5" id="two-step">
	<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">
		{#if mfa.enabled}<ShieldCheck class="size-4 text-success" />{:else}<ShieldAlert class="size-4 text-muted-foreground" />{/if}Two-step verification
		{#if mfa.enabled}<span class="badge badge-success">On</span>{/if}
	</h2>

	{#if setupRequired}
		<p class="mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">{requiredBy.join(', ')} requires two-step verification. Set it up to continue.</p>
	{/if}

	{#if codes.length}
		<p class="mt-2 text-xs text-muted-foreground">Save these recovery codes somewhere safe, like your password manager. Each one signs you in once if you lose your phone. They won’t be shown again.</p>
		<ul class="mt-3 grid grid-cols-2 gap-1.5 rounded-xl bg-surface p-3 font-mono text-[0.8125rem]">
			{#each codes as c (c)}<li>{c}</li>{/each}
		</ul>
		<div class="mt-3 flex gap-2">
			<button class="btn btn-secondary btn-sm" onclick={copyCodes}><Copy />Copy</button>
			<button class="btn btn-secondary btn-sm" onclick={downloadCodes}><Download />Download</button>
			<button class="btn btn-primary btn-sm ml-auto" onclick={done}>I’ve saved them</button>
		</div>
	{:else if mfa.enabled}
		<p class="mt-1 text-xs text-muted-foreground">
			Signing in with your password also asks for a code from your authenticator app. On since {date(mfa.enabledAt)} · {mfa.recoveryLeft} recovery {mfa.recoveryLeft === 1 ? 'code' : 'codes'} left.
		</p>
		{#if mode}
			<form class="mt-3 flex gap-2" onsubmit={act}>
				<input class="input w-44 text-center font-mono" inputmode="numeric" autocomplete="one-time-code" placeholder="Current code" bind:value={code} required />
				<button class="btn {mode === 'disable' ? 'btn-danger' : 'btn-primary'}" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{mode === 'disable' ? 'Turn off' : 'Make new codes'}</button>
				<button type="button" class="btn btn-ghost" onclick={() => (mode = '')}>Cancel</button>
			</form>
		{:else}
			<div class="mt-3 flex gap-2">
				<button class="btn btn-secondary btn-sm" onclick={() => ((mode = 'regenerate'), (code = ''))}>New recovery codes</button>
				{#if !requiredBy.length}<button class="btn btn-ghost btn-sm" onclick={() => ((mode = 'disable'), (code = ''))}>Turn off</button>{/if}
			</div>
		{/if}
	{:else if setup}
		<div class="mt-3 grid gap-4 sm:grid-cols-[10rem_1fr]">
			<div class="qr overflow-hidden rounded-xl bg-white p-1.5">{@html setup.svg}</div>
			<div class="space-y-3 text-xs">
				<p class="text-muted-foreground">Scan this with an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator), or enter the key by hand:</p>
				<div class="flex gap-2"><input class="input font-mono text-[0.6875rem]" readonly value={setup.secret} /><button class="btn btn-secondary btn-icon" title="Copy" onclick={() => (navigator.clipboard.writeText(setup!.secret), toast('success', 'Copied'))}><Copy /></button></div>
				<form class="flex gap-2" onsubmit={confirm}>
					<!-- svelte-ignore a11y_autofocus -->
					<input class="input w-36 text-center font-mono tracking-[0.2em]" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6" bind:value={code} required autofocus />
					<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Turn on</button>
				</form>
			</div>
		</div>
	{:else}
		<p class="mt-1 text-xs text-muted-foreground">
			{hasPassword
				? 'Ask for a code from your authenticator app as well as your password when you sign in.'
				: 'You sign in with single sign-on, where your identity provider handles this. You can still add it for password sign-in.'}
		</p>
		<button class="btn btn-primary btn-sm mt-3" disabled={busy} onclick={begin}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Set up</button>
	{/if}
</section>

<style>
	.qr :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}
</style>
