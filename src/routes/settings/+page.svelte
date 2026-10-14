<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Send, CircleCheck, CircleAlert } from '@lucide/svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { APPROVAL_LABEL } from '#lib/format.ts';
	import type { ApprovalPolicy } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let name = $state('');
	let slack = $state('');
	let allowOnBehalf = $state(false);
	let reminder = $state(3);
	let defaultApproval = $state<ApprovalPolicy>('approvers');
	let requirePrivileged = $state(true);
	let allowOverride = $state(false);
	let busy = $state<string | null>(null);
	$effect(() => {
		name = data.name;
		allowOnBehalf = data.allowOnBehalf;
		reminder = data.expiryReminderDays;
		defaultApproval = data.defaultApproval;
		requirePrivileged = data.requirePrivilegedApproval;
		allowOverride = data.allowAdminOverride;
	});

	async function save(section: string, body: Record<string, unknown>) {
		busy = section;
		try {
			await api.patch('/api/settings', body);
			toast('success', 'Saved');
			if (section === 'slack') slack = '';
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		} finally {
			busy = null;
		}
	}

	async function testSlack() {
		busy = 'test';
		try {
			await api.post('/api/settings/slack-test', {});
			toast('success', 'Sent a test message to Slack');
		} catch (err) {
			toast('error', 'Slack didn’t accept it', errorMessage(err));
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Settings · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Organisation</h2>
		<form class="mt-4 flex items-end gap-3" onsubmit={(e) => (e.preventDefault(), save('name', { name }))}>
			<div class="flex-1">
				<label class="label" for="name">Name</label>
				<input id="name" class="input" bind:value={name} required maxlength="80" />
			</div>
			<button class="btn btn-secondary" disabled={name === data.name || busy === 'name'}>Save</button>
		</form>
	</section>

	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Requests</h2>
		<div class="mt-4 space-y-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-[0.8125rem] font-medium">Anyone can request for someone else</p>
					<p class="text-xs text-muted-foreground">Off: only admins and managers (for their reports) can. Handy on for team leads setting up new hires.</p>
				</div>
				<Switch bind:checked={allowOnBehalf} label="Requests on behalf" onchange={(v) => save('behalf', { allowOnBehalf: v })} />
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label class="label" for="appr">Default approval for new resources</label>
					<select id="appr" class="input" bind:value={defaultApproval} onchange={() => save('appr', { defaultApproval })}>
						{#each Object.entries(APPROVAL_LABEL) as [v, l] (v)}<option value={v}>{l}</option>{/each}
					</select>
				</div>
				<div>
					<label class="label" for="rem">Remind people before access expires</label>
					<select id="rem" class="input" bind:value={reminder} onchange={() => save('rem', { expiryReminderDays: reminder })}>
						<option value={0}>Don’t remind</option>
						{#each [1, 3, 7, 14] as d (d)}<option value={d}>{d} {d === 1 ? 'day' : 'days'} before</option>{/each}
					</select>
				</div>
			</div>
		</div>
	</section>

	<section class="card p-5" id="controls">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Approval controls</h2>
		<p class="text-xs text-muted-foreground">What auditors look for: documented approval by the system owner or manager, and no way around it.</p>
		<div class="mt-4 space-y-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-[0.8125rem] font-medium">Privileged levels always need the system owner</p>
					<p class="text-xs text-muted-foreground">Levels marked privileged (admin, owner, write to production…) get a system owner / approver step even when the resource is pre-approved or manager-only.</p>
				</div>
				<Switch bind:checked={requirePrivileged} label="Require approval for privileged levels" onchange={(v) => save('priv', { requirePrivilegedApproval: v })} />
			</div>
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-[0.8125rem] font-medium">Admins can approve on an approver’s behalf</p>
					<p class="text-xs text-muted-foreground">Off: only the manager, system owner or designated approvers can approve. On: admins can too, and it’s flagged as an override in the evidence.</p>
				</div>
				<Switch bind:checked={allowOverride} label="Allow admin override" onchange={(v) => save('override', { allowAdminOverride: v })} />
			</div>
		</div>
	</section>

	<section class="card p-5" id="notifications">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Notifications</h2>
		<div class="mt-4 space-y-5">
			<div class="flex items-start gap-3">
				{#if data.smtp}<CircleCheck class="mt-0.5 size-4 text-success" />{:else}<CircleAlert class="mt-0.5 size-4 text-warning" />{/if}
				<div>
					<p class="text-[0.8125rem] font-medium">Email {data.smtp ? 'is on' : 'is off'}</p>
					<p class="text-xs text-muted-foreground">
						{#if data.smtp}Approvers, fulfillers and requesters get email at each step.{:else}Set <code class="font-mono">ACM_SMTP_URL</code> (e.g. <code class="font-mono">smtps://user:pass@smtp.example.com</code>) and <code class="font-mono">ACM_SMTP_FROM</code> to send email.{/if}
					</p>
				</div>
			</div>
			<form onsubmit={(e) => (e.preventDefault(), save('slack', { slackWebhook: slack }))}>
				<label class="label" for="slack">Slack channel <span class="font-normal">({data.slackConfigured ? 'connected' : 'incoming webhook URL'})</span></label>
				<div class="flex gap-2">
					<input id="slack" class="input font-mono text-xs" type="url" placeholder={data.slackConfigured ? '•••••••• saved. Paste a new URL to replace it' : 'https://hooks.slack.com/services/…'} bind:value={slack} />
					<button class="btn btn-secondary" disabled={!slack || busy === 'slack'}>Save</button>
				</div>
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">New requests and granted access are posted there. Stored encrypted.</p>
				{#if data.slackConfigured}
					<div class="mt-3 flex gap-2">
						<button type="button" class="btn btn-secondary btn-sm" disabled={busy === 'test'} onclick={testSlack}>{#if busy === 'test'}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test</button>
						<button type="button" class="btn btn-ghost btn-sm" onclick={() => save('slack', { slackWebhook: '' })}>Disconnect</button>
					</div>
				{/if}
			</form>
		</div>
	</section>

	<p class="font-mono text-[0.6875rem] text-muted-foreground/70">{data.mode} · {data.database}</p>
</div>
