<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { config, papers, summaryMeta, threads, ui } from '$lib/stores.svelte';
	import { theme } from '$lib/theme.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import PaperTabs from '$lib/components/PaperTabs.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import QuickOpenModal from '$lib/components/QuickOpenModal.svelte';
	import AddPaperModal from '$lib/components/AddPaperModal.svelte';
	import NewThreadModal from '$lib/components/NewThreadModal.svelte';
	import BulkSummaryModal from '$lib/components/BulkSummaryModal.svelte';
	import FirstRunWizard from '$lib/components/FirstRunWizard.svelte';
	import { syncExternalChanges } from '$lib/tauri/external-sync';
	import { notesSync } from '$lib/stores/notes.svelte';

	let { children } = $props();
	let booting = $state(true);

	// Threads/papers added from outside the app (the MCP server) land on disk
	// only; pull them into the cache on focus and on a short poll.
	const EXTERNAL_SYNC_INTERVAL_MS = 5000;
	let syncing = false;

	async function pullExternalChanges() {
		if (syncing || !papers.loaded) return;
		syncing = true;
		try {
			const { stale, changed } = await syncExternalChanges();
			if (changed) await Promise.all([papers.reload(), threads.reload()]);
			if (stale) notesSync.revision++;
		} catch (e) {
			console.error('[reos] external sync failed', e);
		} finally {
			syncing = false;
		}
	}

	onMount(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') void pullExternalChanges();
		};
		const onFocus = () => void pullExternalChanges();
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVisible);
		const timer = setInterval(() => void pullExternalChanges(), EXTERNAL_SYNC_INTERVAL_MS);

		(async () => {
			theme.apply();
			await config.load();
			if (config.value.papersDir) {
				await Promise.all([papers.load(), threads.load(), summaryMeta.load()]);
				await pullExternalChanges();
			}
			booting = false;
		})();

		return () => {
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVisible);
			clearInterval(timer);
		};
	});

	const needsWizard = $derived(!booting && !config.value.papersDir);

	$effect(() => {
		const path = page.url.pathname;
		const paperChatMatch = path.match(/^\/paper\/([^/]+)\/chat$/);
		const threadChatMatch = path.match(/^\/threads\/([^/]+)\/chat$/);
		const noteMatch = path.match(/^\/threads\/([^/]+)\/notes\/([^/]+)$/);
		const paperMatch = path.match(/^\/paper\/([^/]+)$/);
		const threadMatch = path.match(/^\/threads\/([^/]+)$/);
		if (paperChatMatch) ui.activeTab = { kind: 'paper-chat', id: paperChatMatch[1] };
		else if (threadChatMatch) ui.activeTab = { kind: 'thread-chat', id: threadChatMatch[1] };
		else if (noteMatch) ui.activeTab = { kind: 'note', id: `${noteMatch[1]}/${noteMatch[2]}` };
		else if (paperMatch) ui.activeTab = { kind: 'paper', id: paperMatch[1] };
		else if (threadMatch) ui.activeTab = { kind: 'thread', id: threadMatch[1] };
		else ui.activeTab = null;
		if (!booting) ui.lastPath = path;
	});
</script>

{#if booting}
	<div class="flex min-h-screen w-full items-center justify-center text-sm text-muted-foreground">
		Booting…
	</div>
{:else if needsWizard}
	<FirstRunWizard />
{:else}
	<div class="flex h-screen w-full flex-col overflow-hidden" data-tauri-drag-region>
		<div class="h-7 shrink-0" data-tauri-drag-region></div>
		<div class="flex min-h-0 flex-1 gap-2 px-2 pb-2" data-tauri-drag-region>
			<Sidebar />
			<div
				class="panel flex min-w-0 flex-1 flex-col overflow-hidden"
				data-tauri-drag-region="false"
			>
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
	<BulkSummaryModal />
{/if}
