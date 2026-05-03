<script lang="ts">
	import { Button, Card, Input, Separator } from '$lib/components/ui';
	import { config, papers, threads } from '$lib/stores.svelte';
	import { rebuildCache, type RebuildResult } from '$lib/tauri/rebuild';
	import { db } from '$lib/tauri/db';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import { FolderOpen, RefreshCw, Loader2 } from 'lucide-svelte';
	import { onMount } from 'svelte';

	let rebuilding = $state(false);
	let lastResult = $state<RebuildResult | null>(null);
	let builtAt = $state<string | null>(null);
	let error = $state<string | null>(null);

	onMount(async () => {
		builtAt = await db.getMeta('builtAt');
	});

	async function pickFolder() {
		const result = await openDialog({
			directory: true,
			multiple: false,
			title: 'Choose your papers folder'
		});
		if (typeof result === 'string') {
			await config.update({ papersDir: result });
		}
	}

	async function doRebuild() {
		rebuilding = true;
		error = null;
		try {
			lastResult = await rebuildCache();
			builtAt = await db.getMeta('builtAt');
			await papers.reload();
			await threads.reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			rebuilding = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
	<header>
		<h1 class="font-mono text-2xl font-light tracking-tight">Settings</h1>
		<p class="mt-1 text-sm text-muted-foreground">App configuration and cache management.</p>
	</header>

	<Card class="p-6">
		<h2 class="text-sm font-semibold">Papers folder</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Where Re:OS stores your library on disk.
		</p>
		<div class="mt-3 flex flex-wrap gap-2">
			<Input
				value={config.value.papersDir ?? ''}
				oninput={(e: Event) =>
					config.update({ papersDir: (e.target as HTMLInputElement).value || null })}
				placeholder="/Users/you/Documents/reos"
				class="min-w-0 flex-1 font-mono text-xs"
			/>
			<Button variant="outline" onclick={pickFolder}>
				<FolderOpen class="h-4 w-4" />
				Browse
			</Button>
		</div>
	</Card>

	<Card class="p-6">
		<h2 class="text-sm font-semibold">SQLite cache</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Lives at <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">~/.reos/cache/reos.db</code>.
			Rebuild from your papers folder if files were edited externally.
		</p>
		<div class="mt-3 grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
			<div>
				<div class="text-muted-foreground">Papers</div>
				<div class="mt-0.5 font-mono">{papers.items.length}</div>
			</div>
			<div>
				<div class="text-muted-foreground">Threads</div>
				<div class="mt-0.5 font-mono">{threads.items.length}</div>
			</div>
			<div>
				<div class="text-muted-foreground">Last built</div>
				<div class="mt-0.5 font-mono">{builtAt?.slice(0, 19).replace('T', ' ') ?? '—'}</div>
			</div>
		</div>
		{#if lastResult}
			<p class="mt-3 text-xs text-muted-foreground">
				Last rebuild: {lastResult.papers} papers in {lastResult.threads} threads
				({lastResult.durationMs}ms).
			</p>
		{/if}
		{#if error}
			<p class="mt-3 text-xs text-destructive">{error}</p>
		{/if}
		<div class="mt-4">
			<Button variant="outline" onclick={doRebuild} disabled={rebuilding}>
				{#if rebuilding}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<RefreshCw class="h-4 w-4" />
				{/if}
				Rebuild cache
			</Button>
		</div>
	</Card>

	<Card class="p-6">
		<h2 class="text-sm font-semibold">About</h2>
		<p class="mt-2 text-xs text-muted-foreground">
			Re:OS standalone · v0.1.0 · Tauri 2 · SvelteKit 5
		</p>
	</Card>
</div>
