<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, ui } from '$lib/stores.svelte';
	import PaperChat from '$lib/components/PaperChat.svelte';

	const id = $derived(page.params.id!);
	const paper = $derived(papers.get(id));

	$effect(() => {
		if (id) untrack(() => ui.openPaperChat(id));
	});
</script>

{#if !paper}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Paper not found.
	</div>
{:else}
	<div class="h-full">
		<PaperChat {paper} />
	</div>
{/if}
