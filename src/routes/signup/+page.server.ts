import { redirect } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (config.mode !== 'cloud') redirect(303, locals.auth === 'setup' ? '/setup' : '/login');
	return { signedIn: !!locals.user, email: locals.user?.email ?? '' };
};
