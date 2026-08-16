import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { credentialsFor } from '$lib/server/auth/webauthn.ts';

export const load: PageServerLoad = async ({ locals, url }) => {
	const next = url.searchParams.get('next') ?? '/';
	if (locals.auth.verified) throw redirect(303, next);

	return {
		login: locals.auth.login,
		enrolled: credentialsFor(locals.auth.login ?? '').length > 0,
		next
	};
};
