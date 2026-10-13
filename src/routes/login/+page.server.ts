import { redirect } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.auth === 'setup') redirect(303, '/setup');
	if (locals.user && locals.org) redirect(303, '/');
	const error = url.searchParams.get('error') === 'removed' ? 'Your account isn’t part of an organisation any more. Ask an admin to invite you again.' : '';
	return { cloud: config.mode === 'cloud', error };
};
