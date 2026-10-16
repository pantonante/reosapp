<script lang="ts">
	import { page } from '$app/state';
	import { threads } from '$lib/stores.svelte';
	import NotePage from '$lib/components/NotePage.svelte';

	const id = $derived(page.params.id!);
	const noteId = $derived(page.params.noteId!);
	const thread = $derived(threads.get(id));
	// `?edit` opens straight into the editor (new notes, the card's pencil).
	const startInEdit = $derived(page.url.searchParams.has('edit'));
</script>

{#if !thread}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Thread not found.
	</div>
{:else}
	<!-- Remount per note so the outgoing note flushes its own pending save. -->
	{#key `${id}/${noteId}`}
		<NotePage threadSlug={id} {noteId} {startInEdit} />
	{/key}
{/if}
