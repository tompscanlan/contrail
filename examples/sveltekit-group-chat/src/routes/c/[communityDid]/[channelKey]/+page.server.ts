import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { buildSpaceUri } from '$lib/rooms/uri';
import { mintWatchTicket } from '$lib/rooms/server';

const WATCH_RECORDS_NSID = 'tools.atmo.chat.message.watchRecords';

export const load: PageServerLoad = async ({ locals, params, platform }) => {
	if (!locals.did) error(401, 'Not authenticated');
	const communityDid = decodeURIComponent(params.communityDid);
	const spaceUri = buildSpaceUri(communityDid, params.channelKey);

	// Mint the first watch-scoped ticket alongside the page data so the browser
	// can open the stream on first paint without a second roundtrip. Reconnects
	// call the `mintWatchTicket` remote function.
	let initialTicket: string | null = null;
	try {
		const t = await mintWatchTicket(
			{ env: platform!.env, did: locals.did as string },
			{ watchRecordsNsid: WATCH_RECORDS_NSID, spaceUri, limit: 50 }
		);
		initialTicket = t.ticket;
	} catch {
		// Non-fatal: the browser will mint on demand via the remote function.
	}

	return {
		spaceUri,
		channelKey: params.channelKey,
		myDid: locals.did,
		initialTicket
	};
};
