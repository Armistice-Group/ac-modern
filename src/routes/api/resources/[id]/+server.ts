import { changeOrPropose, changeResponse, RESOURCE_CONTROL_KEYS, resourceControlChanges } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { getResource, parseResourceInput, validateResource } from '#lib/server/resources.ts';
import { APPROVAL_LABEL } from '#lib/format.ts';

/** Changes to who approves (approval rule, owner, approvers, privileged levels) are control changes. */
export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parseResourceInput(await body(event));
	validateResource(input);
	const d = await db();
	const before = await getResource(d, c.org.id, event.params.id!);
	const changed = resourceControlChanges(before, input);
	const controls = Object.keys(changed).filter((k) => RESOURCE_CONTROL_KEYS.includes(k));
	const words: Record<string, string> = {
		approval: `approval rule to “${APPROVAL_LABEL[input.approval]}”`,
		ownerId: 'owner',
		approverIds: 'approvers',
		privileged: `privileged levels to ${input.roles.filter((r) => r.privileged).map((r) => r.name).join(', ') || 'none'}`
	};
	const fx = effects();
	const r = await changeOrPropose(
		d,
		c.org.id,
		c.user.id,
		{ kind: 'resource', action: 'update', targetId: before.id, payload: input, summary: `Change ${before.name}’s ${controls.map((k) => words[k]).join(', ') || 'details'}` },
		fx,
		controls.length > 0
	);
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});
