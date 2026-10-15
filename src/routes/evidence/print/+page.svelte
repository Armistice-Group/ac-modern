<script lang="ts">
	import { Printer, ShieldAlert } from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import { APPROVAL_LABEL, CATEGORY, dateTime, duration, REASON, REVOKE_STATUS, STATUS } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const FLAG_LABEL: Record<string, string> = {
		pre_approved: 'Pre-approved by the resource’s policy (standard access; privileged levels always need approval)',
		auto_approved: 'Auto-approved by an approval rule set by an admin (standard access; privileged levels always need approval)',
		admin_override: 'Approved by an admin on the designated approver’s behalf',
		admin_fallback: 'No designated approver was available, so an admin approved',
		self_approved: 'Self-approved: nobody else could approve',
		manager_unavailable: 'Manager step approved by someone other than the manager (no manager on file)',
		approver_provisioned: 'The same person approved and set up the access',
		auto_provisioned: 'Set up automatically by the provisioning webhook'
	};
	const EXC = ['admin_override', 'admin_fallback', 'self_approved', 'manager_unavailable'];
	const stepCount = (policy: string) => (policy === 'manager_then_approvers' ? [1, 2] : policy === 'none' ? [] : [1]);
	const stepName = (policy: string, step: number) => {
		const steps = policy === 'manager' ? ['Manager'] : policy === 'approvers' ? ['System owner / approver'] : policy === 'manager_then_approvers' ? ['Manager', 'System owner / approver'] : [];
		return steps[step - 1] ?? `Step ${step}`;
	};
</script>

<svelte:head><title>Access request evidence · {data.org}</title></svelte:head>

<div class="paper min-h-dvh">
	<div class="no-print sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-8 py-3">
		<p class="text-xs text-muted-foreground">{data.tickets.length} {data.tickets.length === 1 ? 'ticket' : 'tickets'}. Use your browser’s print dialog to save as PDF.</p>
		<button class="btn btn-primary btn-sm" onclick={() => window.print()}><Printer />Print / save PDF</button>
	</div>

	{#each data.tickets as t (t.request.id)}
		{@const q = t.request}
		{@const s = t.snapshot}
		<article class="ticket mx-auto max-w-3xl px-8 py-10 text-[0.8125rem]">
			<header class="flex items-start justify-between gap-6 border-b-2 border-foreground/80 pb-4">
				<div>
					<p class="text-xs text-muted-foreground">{data.org} · Access {q.kind === 'grant' ? 'request' : 'removal'}</p>
					<h1 class="mt-0.5 text-xl font-semibold tracking-tight">#{q.number} · {s.resource?.name ?? q.resource.name} — {s.role?.name ?? q.role.name}</h1>
					<p class="mt-1 flex flex-wrap gap-1.5">
						<span class="badge">{CATEGORY[q.category]}</span>
						{#if q.privileged}<span class="badge badge-warning"><ShieldAlert />Privileged</span>{/if}
						<span class="badge">{q.status === 'completed' ? (q.kind === 'grant' ? 'Granted' : 'Removed') : q.kind === 'revoke' ? (REVOKE_STATUS[q.status] ?? STATUS[q.status].label) : STATUS[q.status].label}</span>
					</p>
				</div>
				<div class="flex items-center gap-2 text-right"><Logo size={22} /><span class="text-xs font-semibold">ac·modern</span></div>
			</header>

			<section class="mt-6">
				<h2 class="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Request</h2>
				<dl class="grid grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
					<dt class="text-muted-foreground">Person</dt>
					<dd>{s.user?.name || q.user.name} &lt;{s.user?.email || q.user.email}&gt;{s.user?.title ? ` · ${s.user.title}` : ''}</dd>
					<dt class="text-muted-foreground">Manager at the time</dt>
					<dd>{s.manager ? `${s.manager.name} <${s.manager.email}>` : 'None on file'}</dd>
					<dt class="text-muted-foreground">System</dt>
					<dd>{s.resource?.name ?? q.resource.name}</dd>
					<dt class="text-muted-foreground">System owner</dt>
					<dd>{s.resource?.owner ? `${s.resource.owner.name} <${s.resource.owner.email}>` : 'None set'}</dd>
					<dt class="text-muted-foreground">Access level</dt>
					<dd>{s.role?.name ?? q.role.name}{q.privileged ? ' (privileged)' : ''}</dd>
					{#if q.kind === 'grant'}
						<dt class="text-muted-foreground">Duration</dt>
						<dd>{duration(q.durationDays)}</dd>
					{:else}
						<dt class="text-muted-foreground">Reason for removal</dt>
						<dd>{REASON[q.reason]}</dd>
					{/if}
					<dt class="text-muted-foreground">Requested by</dt>
					<dd>{s.requester ? `${s.requester.name} <${s.requester.email}>` : 'ac·modern (automatic)'}</dd>
					<dt class="text-muted-foreground">Requested at</dt>
					<dd class="font-mono text-xs">{q.createdAt}</dd>
					<dt class="text-muted-foreground">{q.kind === 'grant' ? 'Business justification' : 'Note'}</dt>
					<dd class="whitespace-pre-wrap">{q.justification || '—'}</dd>
				</dl>
			</section>

			<section class="mt-6">
				<h2 class="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Approval</h2>
				<p class="mb-2 text-xs text-muted-foreground">
					Rule in force: <span class="text-foreground">{APPROVAL_LABEL[q.policy]}</span>{#if q.privileged && s.resource?.policy && s.resource.policy !== q.policy} (raised from “{APPROVAL_LABEL[s.resource.policy as keyof typeof APPROVAL_LABEL]}” because the level is privileged){/if}.
				</p>
				{#if q.kind === 'revoke'}
					<p>Removals don’t need approval.</p>
				{:else if q.autoRule}
					<p>
						Auto-approved by the rule <strong>“{q.autoRule.name}”</strong>: {q.autoRule.reason}. The system’s own rule was “{APPROVAL_LABEL[(s.resource?.policy ?? 'approvers') as keyof typeof APPROVAL_LABEL]}”. Rules are set by admins, and every change to them is in the audit log; privileged levels always need approval.
					</p>
				{:else if q.policy === 'none'}
					<p>No approval step: standard access pre-approved by the resource’s policy.</p>
				{:else}
					<table class="w-full border border-border text-left text-xs">
						<thead class="bg-surface text-muted-foreground">
							<tr><th class="px-2 py-1.5 font-medium">Step</th><th class="px-2 py-1.5 font-medium">Approver</th><th class="px-2 py-1.5 font-medium">Capacity</th><th class="px-2 py-1.5 font-medium">Decision</th><th class="px-2 py-1.5 font-medium">At (UTC)</th></tr>
						</thead>
						<tbody class="divide-y divide-border">
							{#each t.approvals as a (a.step + a.at)}
								<tr class="align-top">
									<td class="px-2 py-1.5">{a.step}. {stepName(q.policy, a.step)}</td>
									<td class="px-2 py-1.5">{a.approver.name}<br /><span class="text-muted-foreground">{a.approver.email}</span></td>
									<td class="px-2 py-1.5">{data.capacityLabel[a.capacity]}</td>
									<td class="px-2 py-1.5 {a.decision === 'denied' ? 'text-danger' : ''}">{a.decision === 'approved' ? 'Approved' : 'Denied'}{#if a.comment}<br /><span class="text-muted-foreground">“{a.comment}”</span>{/if}</td>
									<td class="px-2 py-1.5 font-mono">{a.at.replace('T', ' ').slice(0, 19)}</td>
								</tr>
							{/each}
							{#each stepCount(q.policy) as step (step)}
								{#if !t.approvals.some((a) => a.step === step) && !t.approvals.some((a) => a.decision === 'denied')}
									<tr><td class="px-2 py-1.5">{step}. {stepName(q.policy, step)}</td><td colspan="4" class="px-2 py-1.5 text-muted-foreground">{q.status === 'pending_approval' ? 'Waiting for approval' : q.status === 'cancelled' ? 'Not reached (cancelled)' : '—'}</td></tr>
								{/if}
							{/each}
						</tbody>
					</table>
				{/if}
			</section>

			<section class="mt-6">
				<h2 class="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{q.kind === 'grant' ? 'Provisioning' : 'Removal'}</h2>
				<dl class="grid grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
					<dt class="text-muted-foreground">Done by</dt>
					<dd>{t.fulfilledAt ? (t.fulfilledBy ? `${t.fulfilledBy.name} <${t.fulfilledBy.email}>` : 'Provisioning webhook (automatic)') : 'Not done yet'}</dd>
					<dt class="text-muted-foreground">Done at</dt>
					<dd class="font-mono text-xs">{t.fulfilledAt ?? '—'}</dd>
					{#if q.kind === 'grant' && t.approvedAt && t.fulfilledAt}
						<dt class="text-muted-foreground">After approval</dt>
						<dd>{t.fulfilledAt >= t.approvedAt ? 'Yes' : 'No'} (approved {t.approvedAt.replace('T', ' ').slice(0, 19)} UTC)</dd>
					{/if}
					{#if t.grant}
						<dt class="text-muted-foreground">Access {t.grant.status === 'revoked' ? 'removed' : 'status today'}</dt>
						<dd>{t.grant.status === 'revoked' ? t.grant.revokedAt : t.grant.status === 'pending_revoke' ? 'Being removed' : t.grant.expiresAt ? `Active until ${t.grant.expiresAt.slice(0, 10)}` : 'Active, no end date'}</dd>
					{/if}
				</dl>
			</section>

			{#if t.flags.length}
				<section class="mt-6">
					<h2 class="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Notes for the reviewer</h2>
					<ul class="list-disc space-y-0.5 pl-5">
						{#each t.flags as f (f)}<li class={EXC.includes(f) ? 'text-danger' : ''}>{f === 'auto_approved' && q.autoRule ? `Auto-approved by rule “${q.autoRule.name}” (${q.autoRule.reason}), set by an admin; privileged levels always need approval` : FLAG_LABEL[f]}</li>{/each}
					</ul>
				</section>
			{/if}

			<section class="mt-6">
				<h2 class="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Full history</h2>
				<table class="w-full text-left text-xs">
					<tbody class="divide-y divide-border">
						{#each t.timeline as e (e.id)}
							<tr class="align-top">
								<td class="w-40 py-1 pr-3 font-mono whitespace-nowrap text-muted-foreground">{e.at.replace('T', ' ').slice(0, 19)}</td>
								<td class="w-40 py-1 pr-3">{e.actor ? e.actor.name || e.actor.email : 'ac·modern'}</td>
								<td class="py-1">{e.summary}{#if e.data.comment || e.data.note}<span class="text-muted-foreground">&nbsp;— “{e.data.comment || e.data.note}”</span>{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>

			<footer class="mt-8 border-t border-border pt-3 text-[0.6875rem] text-muted-foreground">
				<p>Generated {dateTime(data.generatedAt)} ({data.generatedAt}) by {data.generatedBy}. Times are UTC.</p>
				<p class="mt-0.5 break-all">Record fingerprint (SHA-256 of the stored request, approvals and history): <span class="font-mono text-foreground">{t.fingerprint}</span></p>
			</footer>
		</article>
	{/each}
</div>
