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
	import ThreadView from '$lib/components/ThreadView.svelte';
	import { cn } from '$lib/utils/cn';
	import { pruneMissingPapers, syncExternalChanges } from '$lib/tauri/external-sync';
	import { notesSync } from '$lib/stores/notes.svelte';
	import { handleTextZoomKey } from '$lib/text-zoom.svelte';

	let { children } = $props();
	let booting = $state(true);

	// Threads/papers added from outside the app (the MCP server) land on disk
	// only; pull them into the cache on focus and on a short poll.
	const EXTERNAL_SYNC_INTERVAL_MS = 5000;
	let syncing = false;

	// Pruning lists every thread folder, so it runs on boot/focus (throttled)
	// rather than on the 5s poll.
	const PRUNE_MIN_INTERVAL_MS = 30_000;
	let lastPruneAt = 0;

	async function pullExternalChanges(opts: { prune?: boolean } = {}) {
		if (syncing || !papers.loaded) return;
		syncing = true;
		try {
			const { stale, changed } = await syncExternalChanges();
			let pruned = 0;
			if (opts.prune && Date.now() - lastPruneAt >= PRUNE_MIN_INTERVAL_MS) {
				lastPruneAt = Date.now();
				pruned = await pruneMissingPapers();
			}
			if (pruned > 0) {
				await Promise.all([papers.reload(), threads.reload(), summaryMeta.reload()]);
			} else if (changed) await Promise.all([papers.reload(), threads.reload()]);
			if (stale) notesSync.revision++;
		} catch (e) {
			console.error('[reos] external sync failed', e);
		} finally {
			syncing = false;
		}
	}

	onMount(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') void pullExternalChanges({ prune: true });
		};
		const onFocus = () => void pullExternalChanges({ prune: true });
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVisible);
		const timer = setInterval(() => void pullExternalChanges(), EXTERNAL_SYNC_INTERVAL_MS);

		(async () => {
			theme.apply();
			await config.load();
			if (config.value.papersDir) {
				await Promise.all([papers.load(), threads.load(), summaryMeta.load()]);
				await pullExternalChanges({ prune: true });
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

	// SvelteKit unmounts a route's page whenever the route changes, so a thread
	// page would rebuild from scratch every time you switch tabs. Instead the
	// layout keeps one ThreadView mounted per open thread tab (plus the current
	// thread, e.g. the Inbox, which has no tab) and only hides the inactive ones.
	// Closing the tab unmounts its view.
	const currentThreadId = $derived(page.url.pathname.match(/^\/threads\/([^/]+)$/)?.[1] ?? null);
	const keptThreadIds = $derived.by(() => {
		const ids = ui.openTabs.filter((t) => t.kind === 'thread').map((t) => t.id);
		if (currentThreadId && !ids.includes(currentThreadId)) ids.push(currentThreadId);
		return ids;
	});

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

<svelte:window onkeydown={handleTextZoomKey} />

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
				<div class="relative min-h-0 flex-1">
					<main class={cn('absolute inset-0 overflow-auto', currentThreadId && 'invisible')}>
						{@render children?.()}
					</main>
					{#each keptThreadIds as tid (tid)}
						<!-- visibility rather than display:none, so each view keeps its scroll offset -->
						<div
							class={cn('absolute inset-0 overflow-auto', tid !== currentThreadId && 'invisible')}
							inert={tid !== currentThreadId}
						>
							<ThreadView id={tid} />
						</div>
					{/each}
				</div>
			</div>
		</div>
	</div>
	<CommandPalette />
	<QuickOpenModal />
	<AddPaperModal />
	<NewThreadModal />
	<BulkSummaryModal />
{/if}
