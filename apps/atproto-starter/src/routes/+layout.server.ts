import type { LayoutServerLoad } from './$types';
import { getServerClient } from '$lib/contrail';
import { extractProfile } from '$lib/contrail/client';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	if (!locals.did || !locals.client) {
		return { did: null, profile: null };
	}

	try {
		const client = getServerClient(platform!.env.DB);
		const res = await client.get('statusphere.app.getProfile', {
			params: { actor: locals.did }
		});

		if (!res.ok) return { did: locals.did, profile: null };
		const entry = res.data.profiles?.[0];

		return {
			did: locals.did,
			profile: entry ? extractProfile(entry) : null
		};
	} catch {
		return { did: locals.did, profile: null };
	}
};
