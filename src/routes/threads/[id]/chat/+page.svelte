<script lang="ts">
	import { page } from '$app/state';
	import { threads } from '$lib/stores.svelte';
	import ThreadChat from '$lib/components/ThreadChat.svelte';

	const id = $derived(page.params.id!);
	const thread = $derived(threads.get(id));
</script>

{#if !thread}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Thread not found.
	</div>
{:else}
	<div class="h-full">
		<ThreadChat {thread} />
	</div>
{/if}
