<script lang="ts">
	import { CircleAlert, CircleCheck, Copy, LoaderCircle, Send } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { ago } from '#lib/format.ts';

	type Status = { url: string; lastDeliveredAt: string | null; lastError: string; behind: number } | null;
	let status = $state<Status>(null);
	let url = $state('');
	let secret = $state('');
	let busy = $state<string | null>(null);

	async function load() {
		status = await api.get<Status>('/api/settings/audit-stream');
		url = status?.url ?? '';
	}
	$effect(() => {
		load().catch(() => {});
	});

	async function save(e?: SubmitEvent, rotate = false) {
		e?.preventDefault();
		if (rotate && !(await confirmAction({ title: 'Rotate the signing secret?', body: 'Your receiver must be updated with the new secret, or it will reject the events.', confirmLabel: 'Rotate' }))) return;
		busy = rotate ? 'rotate' : 'save';
		try {
			const r = await api.put<{ secret: string | null }>('/api/settings/audit-stream', { url, rotate });
			secret = r.secret ?? '';
			toast('success', r.secret ? 'Streaming started' : 'Saved', r.secret ? 'Copy the signing secret now; it isn’t shown again.' : undefined);
			await load();
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	async function test() {
		busy = 'test';
		try {
			await api.post('/api/settings/audit-stream/test', {});
			toast('success', 'Your receiver accepted a signed test');
		} catch (err) {
			toast('error', 'The receiver didn’t accept it', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	async function stop() {
		if (!(await confirmAction({ title: 'Stop streaming the audit log?', body: 'Events stay in ac·modern; they just stop being sent.', confirmLabel: 'Stop', danger: true }))) return;
		await api.del('/api/settings/audit-stream');
		secret = '';
		await load();
	}
</script>

<section class="card p-5" id="audit">
	<h2 class="text-[0.9375rem] font-semibold tracking-tight">Audit log</h2>
	<p class="text-xs text-muted-foreground">
		Each day’s events are sealed with a chained digest you can verify on the <a class="text-primary hover:underline" href="/audit">Audit log</a> page. Streaming every event to a store you control (a SIEM, a log bucket, n8n) keeps a copy outside ac·modern, so a changed record can’t go unnoticed.
	</p>
	<form class="mt-4" onsubmit={(e) => save(e)}>
		<label class="label" for="audit-url">Stream to <span class="font-normal">(HTTPS endpoint; signed POSTs of up to 100 events)</span></label>
		<div class="flex gap-2">
			<input id="audit-url" class="input font-mono text-xs" type="url" placeholder="https://logs.example.com/ac-modern" bind:value={url} required />
			<button class="btn btn-secondary" disabled={!url || url === status?.url || busy === 'save'}>{status ? 'Save' : 'Start'}</button>
		</div>
	</form>
	{#if secret}
		<div class="mt-3">
			<span class="label">Signing secret</span>
			<div class="flex gap-2">
				<input class="input font-mono text-xs" readonly value={secret} />
				<button class="btn btn-secondary" onclick={() => (navigator.clipboard.writeText(secret), toast('success', 'Copied'))}><Copy />Copy</button>
			</div>
			<p class="mt-1 text-[0.6875rem] text-warning">Copy it now; it won’t be shown again. Check <span class="font-mono">x-acm-signature</span> with it.</p>
		</div>
	{/if}
	{#if status}
		<p class="mt-3 flex items-start gap-1.5 text-xs {status.lastError ? 'text-danger' : 'text-muted-foreground'}">
			{#if status.lastError}<CircleAlert class="mt-px size-3.5 shrink-0" />Failing: {status.lastError}. It retries every few minutes from where it stopped.
			{:else}<CircleCheck class="mt-px size-3.5 shrink-0 text-success" />{status.lastDeliveredAt ? `Last delivered ${ago(status.lastDeliveredAt)}` : 'Nothing delivered yet'}{status.behind ? `; ${status.behind} events to send` : '; up to date'}.{/if}
		</p>
		<div class="mt-3 flex flex-wrap gap-2">
			<button type="button" class="btn btn-secondary btn-sm" disabled={busy === 'test'} onclick={test}>{#if busy === 'test'}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test</button>
			<button type="button" class="btn btn-ghost btn-sm" disabled={busy === 'rotate'} onclick={() => save(undefined, true)}>Rotate secret</button>
			<button type="button" class="btn btn-ghost btn-sm ml-auto" onclick={stop}>Stop streaming</button>
		</div>
	{/if}
</section>
