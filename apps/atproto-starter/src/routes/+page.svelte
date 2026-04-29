<script lang="ts">
	import { user, logout } from '$lib/atproto';
	import { Button } from '@foxui/core';
	import { atProtoLoginModalState } from '$lib/atproto/ui/LoginModal.svelte';
</script>

<div class="mx-auto max-w-xl px-4 my-16">
	<h1 class="mb-4 text-3xl font-bold">atproto-starter</h1>

	{#if !user.isLoggedIn}
		<Button class="my-4" size="lg" onclick={() => (atProtoLoginModalState.open = true)}>
			Sign In
		</Button>
	{:else}
		<div class="my-4 flex items-center gap-2">
			<span class="text-base-700 dark:text-base-300 text-sm">
				Signed in as {user.profile?.handle ?? user.did}
			</span>
			<Button variant="ghost" onclick={() => logout()}>Sign Out</Button>
		</div>
	{/if}

	<!-- TODO: build your app here -->
</div>
