<script lang="ts">
	// The thread view is rendered by the root layout (see ThreadView), which
	// keeps it mounted while its tab is open. This route only registers the
	// visit as a tab.
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { ui } from '$lib/stores.svelte';

	const id = $derived(page.params.id!);

	$effect(() => {
		if (id) untrack(() => ui.openThread(id));
	});
</script>
