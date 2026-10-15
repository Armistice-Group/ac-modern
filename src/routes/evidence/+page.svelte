<script lang="ts">
	import LeaversCard from './LeaversCard.svelte';
	import ReviewsCard from './ReviewsCard.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Download, Printer, ShieldAlert, FileCheck2, UserPlus, ArrowLeftRight, TriangleAlert, Copy, Inbox, MinusCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import StatCard from '#lib/components/StatCard.svelte';
	import StatusBadge from '#lib/components/StatusBadge.svelte';
	import { toast } from '#lib/client/state.svelte.ts';
	import { CAPACITY, CATEGORY, date, dateTime, displayName, EXCEPTION_CAPACITIES } from '#lib/format.ts';
	import type { RequestCategory } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let from = $state('');
	let to = $state('');
	let selected = $state<number[]>([]);
	$effect(() => {
		from = data.period.from;
		to = data.period.to;
		selected = [];
	});

	const EXC = ['admin_override', 'admin_fallback', 'self_approved', 'manager_unavailable'];
	const FLAG_SHORT: Record<string, string> = {
		pre_approved: 'Pre-approved',
		auto_approved: 'Auto-approved',
		admin_override: 'Admin override',
		admin_fallback: 'Admin fallback',
		self_approved: 'Self-approved',
		manager_unavailable: 'No manager',
		approver_provisioned: 'Approver set up',
		auto_provisioned: 'Webhook'
	};

	function nav(patch: Record<string, string>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(patch)) v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
		goto(u, { reset: false, replace: true });
	}
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	function preset(kind: string) {
		const now = new Date();
		const q = Math.floor(now.getUTCMonth() / 3);
		const y = now.getUTCFullYear();
		const ranges: Record<string, [Date, Date]> = {
			'90d': [new Date(Date.now() - 90 * 86_400_000), now],
			quarter: [new Date(Date.UTC(y, q * 3, 1)), now],
			last: [new Date(Date.UTC(y, q * 3 - 3, 1)), new Date(Date.UTC(y, q * 3, 0))],
			ytd: [new Date(Date.UTC(y, 0, 1)), now],
			'12m': [new Date(Date.UTC(y - 1, now.getUTCMonth(), now.getUTCDate() + 1)), now]
		};
		const [a, b] = ranges[kind];
		nav({ from: iso(a), to: iso(b) });
	}

	function toggleType(t: RequestCategory) {
		const set = new Set(data.filters.types);
		set.has(t) ? set.delete(t) : set.add(t);
		nav({ types: [...set].join(',') });
	}

	const csvHref = $derived(`/api/evidence/population?${new URLSearchParams({ from: data.period.from, to: data.period.to, ...(data.filters.types.length ? { types: data.filters.types.join(',') } : {}), ...(data.filters.privileged ? { privileged: '1' } : {}), ...(data.filters.exceptions ? { exceptions: '1' } : {}) })}`);
	const printHref = (numbers: number[]) => `/evidence/print?numbers=${numbers.join(',')}`;
	const allShown = $derived(data.rows.map((r) => r.request.number));

	const narrative = $derived.by(() => {
		const c = data.control;
		return [
			`${c.orgName} requests and approves access to ${c.resources} systems in ac·modern. Every request records the person, the system and access level, a business justification, who asked, and when.`,
			`Each system has a named owner and an approval rule: the requester's manager, the system owner or designated approvers, or the manager followed by an approver. Approvals record the approver, their capacity (manager, system owner, designated approver) and a timestamp. People cannot approve their own access${c.allowAdminOverride ? '; admins may approve on an approver’s behalf, which is recorded as an override' : ', and admins cannot approve on an approver’s behalf'}.`,
			c.requirePrivilegedApproval
				? `Privileged access levels (${c.privilegedLevels.length ? c.privilegedLevels.join(', ') : 'none defined yet'}) always require approval by the system owner or a designated approver, in addition to any manager approval.`
				: 'Privileged access levels follow the same approval rule as their system.',
			c.preApproved.length ? `Standard access to ${c.preApproved.join(', ')} is pre-approved by policy; privileged levels on these systems still require approval.` : '',
			c.autoRules.length
				? `Admin-defined auto-approval rules approve some standard (never privileged) requests without a person: ${c.autoRules.join('; ')}. Each such request records the rule and why it matched, and every change to a rule is logged.`
				: '',
			'Access is set up only after approval, by a named administrator or an automated integration, and the request is closed with who did it and when. New hires’ starting access is requested as one onboarding batch; transfers request new access and remove old access together. Time-limited access is removed automatically when it expires.',
			`When someone leaves, they are offboarded (by an admin or automatically when deactivated in the identity provider): their sessions end, open requests are cancelled, and a removal is opened for every access they hold. Removals are expected within ${data.leavers.slaHours} hours of the end of their last day; removals still open after that are escalated to the fulfillers and admins daily, and the time taken is reported for each leaver.`,
			data.reviewPolicies.length
				? `Access is reviewed on a schedule: ${data.reviewPolicies.join('; ')}. Nobody reviews their own access. Reviewers are reminded before the due date and late reviews are escalated to admins; revoked access is removed through a removal request, and each review records who decided, when, and when the access was removed.`
				: 'Access is reviewed periodically by system owners; revoked access is removed through a removal request.',
			c.requireSecondAdmin ? 'Changes to approval controls (auto-approval rules, review policies, systems’ approval rules, owners, approvers and privileged levels, and approval settings) take effect only when a second admin approves them.' : '',
			'The request population and individual tickets (with approvals, timeline and a SHA-256 fingerprint of the record) can be exported for any period.'
		]
			.filter(Boolean)
			.join('\n\n');
	});
</script>

<svelte:head><title>Audit evidence · ac·modern</title></svelte:head>

<PageHeader title="Audit evidence" description="The request-and-approval record your auditor samples from: every access change in a period, and the ticket for each.">
	{#snippet actions()}
		<a class="btn btn-secondary" href={csvHref} download><Download />Population CSV</a>
		<a class="btn btn-primary {selected.length ? '' : 'pointer-events-none opacity-50'}" href={printHref(selected)} target="_blank"><Printer />Print {selected.length || ''} {selected.length === 1 ? 'ticket' : 'tickets'}</a>
	{/snippet}
</PageHeader>

<div class="space-y-6 px-8 pb-10">
	<div class="flex flex-wrap items-end gap-3">
		<form class="flex items-end gap-2" onsubmit={(e) => (e.preventDefault(), nav({ from, to }))}>
			<div>
				<label class="label" for="from">From</label>
				<input id="from" type="date" class="input h-8 text-xs" bind:value={from} />
			</div>
			<div>
				<label class="label" for="to">To</label>
				<input id="to" type="date" class="input h-8 text-xs" bind:value={to} />
			</div>
			<button class="btn btn-secondary btn-sm h-8">Apply</button>
		</form>
		<div class="flex flex-wrap gap-1">
			{#each [['90d', 'Last 90 days'], ['quarter', 'This quarter'], ['last', 'Last quarter'], ['ytd', 'Year to date'], ['12m', 'Last 12 months']] as [k, l] (k)}
				<button class="btn btn-ghost btn-sm" onclick={() => preset(k)}>{l}</button>
			{/each}
		</div>
	</div>

	<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
		<StatCard label="Requests" value={data.counts.all} icon={Inbox} />
		<StatCard label="New hire" value={data.counts.newHire} icon={UserPlus} tone="primary" />
		<StatCard label="Transfers & changes" value={data.counts.changes} icon={ArrowLeftRight} />
		<StatCard label="Privileged grants" value={data.counts.privileged} icon={ShieldAlert} tone="warning" />
		<StatCard label="Removals" value={data.counts.removals} icon={MinusCircle} />
		<StatCard label="Exceptions" value={data.counts.exceptions} icon={TriangleAlert} tone={data.counts.exceptions ? 'danger' : 'default'} />
	</div>

	<section class="card overflow-hidden">
		<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
			{#each Object.entries(CATEGORY) as [k, l] (k)}
				<button class="btn btn-sm {data.filters.types.includes(k as RequestCategory) ? 'btn-secondary text-foreground' : 'btn-ghost'}" onclick={() => toggleType(k as RequestCategory)}>{l}</button>
			{/each}
			<span class="mx-1 h-5 w-px bg-border"></span>
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" class="accent-[var(--primary)]" checked={data.filters.privileged} onchange={(e) => nav({ privileged: e.currentTarget.checked ? '1' : '' })} />Privileged only</label>
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" class="accent-[var(--primary)]" checked={data.filters.exceptions} onchange={(e) => nav({ exceptions: e.currentTarget.checked ? '1' : '' })} />Exceptions only</label>
			<span class="ml-auto font-mono text-xs text-muted-foreground">{data.total} shown</span>
		</div>
		{#if data.rows.length}
			<div class="overflow-x-auto">
				<table class="w-full text-[0.8125rem]">
					<thead>
						<tr class="border-b border-border text-left text-xs text-muted-foreground">
							<th class="w-8 px-4 py-2.5"><input type="checkbox" class="accent-[var(--primary)]" aria-label="Select all" checked={selected.length === allShown.length} onchange={(e) => (selected = e.currentTarget.checked ? [...allShown] : [])} /></th>
							<th class="px-2 py-2.5 font-medium">Request</th>
							<th class="px-3 py-2.5 font-medium">Person</th>
							<th class="px-3 py-2.5 font-medium">Access</th>
							<th class="px-3 py-2.5 font-medium">Approval</th>
							<th class="px-3 py-2.5 font-medium">Set up</th>
							<th class="px-3 py-2.5 font-medium">Status</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each data.rows as r (r.request.id)}
							{@const q = r.request}
							<tr class="align-top transition-colors hover:bg-accent/30">
								<td class="px-4 py-2.5"><input type="checkbox" class="accent-[var(--primary)]" aria-label="Select #{q.number}" value={q.number} bind:group={selected} /></td>
								<td class="px-2 py-2.5 whitespace-nowrap">
									<a href={printHref([q.number])} target="_blank" class="font-mono text-xs text-primary hover:underline">#{q.number}</a>
									<p class="text-[0.6875rem] text-muted-foreground">{date(q.createdAt)}</p>
									<span class="badge mt-1 {q.category === 'new_hire' ? 'badge-primary' : ''}">{CATEGORY[q.category]}</span>
								</td>
								<td class="px-3 py-2.5">
									<p class="font-medium">{r.snapshot.user?.name || displayName(q.user)}</p>
									<p class="text-xs text-muted-foreground">{r.snapshot.user?.title || q.user.email}</p>
								</td>
								<td class="px-3 py-2.5">
									<p class="flex items-center gap-1.5">{r.snapshot.resource?.name ?? q.resource.name}{#if q.privileged}<ShieldAlert class="size-3.5 text-warning" />{/if}</p>
									<p class="text-xs text-muted-foreground">{r.snapshot.role?.name ?? q.role.name}</p>
								</td>
								<td class="px-3 py-2.5 text-xs">
									{#if q.kind === 'revoke'}<span class="text-muted-foreground">Removal: no approval needed</span>
									{:else if !r.approvals.length && q.policy === 'none'}<span class="text-muted-foreground">Pre-approved by policy</span>
									{:else}
										{#each r.approvals as a (a.step + a.at)}
											<p>
												<span class={a.decision === 'denied' ? 'text-danger' : ''}>{a.decision === 'denied' ? 'Denied' : '✓'}</span>
												{a.approver.name || a.approver.email}
												<span class="{EXCEPTION_CAPACITIES.includes(a.capacity) ? 'text-danger' : 'text-muted-foreground'}">· {CAPACITY[a.capacity]}</span>
											</p>
										{:else}<span class="text-muted-foreground">Pending</span>{/each}
									{/if}
								</td>
								<td class="px-3 py-2.5 text-xs">
									{#if r.fulfilledAt}<p>{r.fulfilledBy ? r.fulfilledBy.name || r.fulfilledBy.email : 'Webhook'}</p><p class="text-muted-foreground">{dateTime(r.fulfilledAt)}</p>{:else}<span class="text-muted-foreground">—</span>{/if}
								</td>
								<td class="px-3 py-2.5">
									<StatusBadge status={q.status} kind={q.kind} />
									{#each r.flags.filter((f) => f !== 'auto_provisioned') as f (f)}
										<span class="badge mt-1 {EXC.includes(f) ? 'badge-danger' : ''}" title={f}>{FLAG_SHORT[f]}</span>
									{/each}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="px-4 py-12 text-center text-xs text-muted-foreground">No requests in this period{data.filters.types.length || data.filters.privileged || data.filters.exceptions ? ' match these filters' : ''}.</p>
		{/if}
	</section>

	<div class="grid gap-6 xl:grid-cols-3">
		{#each [{ title: 'Access outside requests', hint: 'Recorded by an admin (e.g. existing access at go-live), or detected in your IdP without a request.', items: data.outside.recorded }, { title: 'ac·modern admin changes', hint: 'Who was made (or stopped being) an admin or owner of ac·modern itself.', items: data.outside.adminChanges }, { title: 'Control changes', hint: 'Approval rules, system owners and settings changed in this period.', items: data.outside.controlChanges }] as box (box.title)}
			<section class="card overflow-hidden">
				<header class="border-b border-border px-4 py-3">
					<h2 class="text-[0.8125rem] font-semibold">{box.title} <span class="font-normal text-muted-foreground">· {box.items.length}</span></h2>
					<p class="text-[0.6875rem] text-muted-foreground">{box.hint}</p>
				</header>
				<ul class="max-h-72 divide-y divide-border overflow-y-auto">
					{#each box.items as e (e.id)}
						<li class="px-4 py-2.5 text-xs"><p>{e.summary}</p><p class="mt-0.5 text-[0.6875rem] text-muted-foreground">{e.actor} · {dateTime(e.at)}</p></li>
					{:else}
						<li class="px-4 py-6 text-center text-xs text-muted-foreground">None in this period.</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>

	<div class="grid gap-6 xl:grid-cols-2">
		<LeaversCard rows={data.leavers.rows} slaHours={data.leavers.slaHours} csvHref="/api/evidence/leavers?from={data.period.from}&to={data.period.to}" />
		<ReviewsCard reviews={data.reviews} />
	</div>

	<section class="card p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight"><FileCheck2 class="size-4 text-primary" />Control description</h2>
				<p class="text-xs text-muted-foreground">How your access process works, written from your current settings. Paste it into your control narrative or walkthrough notes.</p>
			</div>
			<button class="btn btn-secondary btn-sm" onclick={() => (navigator.clipboard.writeText(narrative), toast('success', 'Copied'))}><Copy />Copy</button>
		</div>
		<p class="mt-4 text-[0.8125rem] leading-relaxed whitespace-pre-line text-foreground/90">{narrative}</p>
	</section>
</div>
