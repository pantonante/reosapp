<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { config, papers, summaryMeta, threads, ui } from '$lib/stores.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import PaperTabs from '$lib/components/PaperTabs.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import QuickOpenModal from '$lib/components/QuickOpenModal.svelte';
	import AddPaperModal from '$lib/components/AddPaperModal.svelte';
	import NewThreadModal from '$lib/components/NewThreadModal.svelte';
	import FirstRunWizard from '$lib/components/FirstRunWizard.svelte';

	let { children } = $props();
	let booting = $state(true);

	onMount(async () => {
		await config.load();
		if (config.value.papersDir) {
			await Promise.all([papers.load(), threads.load(), summaryMeta.load()]);
		}
		booting = false;
	});

	const needsWizard = $derived(!booting && !config.value.papersDir);
</script>

{#if booting}
	<div class="flex min-h-screen w-full items-center justify-center text-sm text-muted-foreground">
		Booting…
	</div>
{:else if needsWizard}
	<FirstRunWizard />
{:else}
	<div class="flex h-screen w-full flex-col overflow-hidden">
		<header
			class="flex h-7 shrink-0 items-center bg-card pl-20 pr-2"
			data-tauri-drag-region
		>
			<a
				href="/"
				class="font-mono text-sm tracking-tight"
				data-tauri-drag-region="false"
			>
				<span class="text-accent">Re:</span><span>OS</span>
			</a>
		</header>
		<div class="flex min-h-0 flex-1">
			<Sidebar />
			<div class="flex min-w-0 flex-1 flex-col">
				{#if !ui.pdfFullscreen}
					<PaperTabs />
					<Breadcrumbs />
				{/if}
				<main class="min-h-0 flex-1 overflow-auto">
					{@render children?.()}
				</main>
			</div>
		</div>
	</div>
	<CommandPalette />
	<QuickOpenModal />
	<AddPaperModal />
	<NewThreadModal />
{/if}
