<script lang="ts">
	import { REVOKE_STATUS, STATUS } from '#lib/format.ts';
	import type { RequestKind, RequestStatus } from '#lib/types.ts';
	let { status, kind = 'grant' }: { status: RequestStatus; kind?: RequestKind } = $props();
	const s = $derived(STATUS[status]);
	const label = $derived(kind === 'revoke' ? (REVOKE_STATUS[status] ?? s.label) : s.label);
</script>

<span class="badge {s.badge}"><span class="size-1.5 rounded-full {s.dot}"></span>{label}</span>
