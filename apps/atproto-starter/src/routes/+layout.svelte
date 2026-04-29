<script lang="ts">
	import '../app.css';
	import { AtprotoLoginModal } from '@foxui/social';
	import { login, signup } from '$lib/atproto';
	import { Head, ThemeToggle } from '@foxui/core';
	import LoginModal from '$lib/atproto/ui/LoginModal.svelte';

	let { children } = $props();
</script>

{@render children()}

<LoginModal />

<ThemeToggle class="absolute top-2 left-2" />

<Head
	title="atproto-starter"
	emojiFavicon="🌱"
	description="atproto app"
/>
