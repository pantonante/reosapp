<script lang="ts">
	import { Button, Card, Input } from '$lib/components/ui';
	import { config, papers, summaryMeta, threads } from '$lib/stores.svelte';
	import { rebuildCache, type RebuildResult } from '$lib/tauri/rebuild';
	import { db } from '$lib/tauri/db';
	import { INBOX_SLUG, readPaperSummary } from '$lib/tauri/fs';
	import { parseSummaryFrontmatter, isMetaEmpty } from '$lib/summary-meta';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import { FolderOpen, RefreshCw, Loader2, Tags, Check } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { theme, THEMES, type Theme } from '$lib/theme.svelte';
	import { cn } from '$lib/utils/cn';
	import { APP_VERSION } from '$lib/version';

	let rebuilding = $state(false);
	let lastResult = $state<RebuildResult | null>(null);
	let builtAt = $state<string | null>(null);
	let error = $state<string | null>(null);

	let reindexing = $state(false);
	let reindexResult = $state<{ scanned: number; indexed: number; cleared: number } | null>(null);
	let reindexError = $state<string | null>(null);

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
			await summaryMeta.reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			rebuilding = false;
		}
	}

	async function doReindexSummaryMeta() {
		reindexing = true;
		reindexError = null;
		reindexResult = null;
		let scanned = 0;
		let indexed = 0;
		let cleared = 0;
		try {
			const now = new Date().toISOString();
			for (const p of papers.items) {
				scanned++;
				const text = await readPaperSummary(p.threadId ?? INBOX_SLUG, p.arxivId);
				if (!text) {
					if (summaryMeta.has(p.id)) {
						await summaryMeta.remove(p.id);
						cleared++;
					}
					continue;
				}
				const { meta } = parseSummaryFrontmatter(text);
				if (isMetaEmpty(meta)) {
					if (summaryMeta.has(p.id)) {
						await summaryMeta.remove(p.id);
						cleared++;
					}
					continue;
				}
				await summaryMeta.set({
					paperId: p.id,
					topics: meta!.topics,
					domains: meta!.domains,
					keywords: meta!.keywords,
					updatedAt: now
				});
				indexed++;
			}
			reindexResult = { scanned, indexed, cleared };
		} catch (e) {
			reindexError = e instanceof Error ? e.message : String(e);
		} finally {
			reindexing = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
	<header>
		<h1 class="font-mono text-2xl font-light tracking-tight">Settings</h1>
		<p class="mt-1 text-sm text-muted-foreground">App configuration and cache management.</p>
	</header>

	<Card class="p-6">
		<h2 class="text-sm font-semibold">Theme</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Choose the look of the app. Saved per device.
		</p>
		<div class="mt-3 grid gap-2 sm:grid-cols-2">
			{#each THEMES as t (t.id)}
				{@const active = theme.current === t.id}
				<button
					type="button"
					class={cn(
						'flex items-center gap-3 rounded-[10px] border p-3 text-left transition-colors',
						active
							? 'border-border bg-secondary'
							: 'border-border/60 hover:border-border hover:bg-secondary/40'
					)}
					onclick={() => theme.set(t.id as Theme)}
				>
					<span
						class={cn(
							'flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-border/60',
							t.id === 'dracula' && 'bg-[hsl(222_24%_4%)]',
							t.id === 'dark' && 'bg-[hsl(0_0%_5%)]',
							t.id === 'light' && 'bg-[hsl(220_14%_96%)]',
							t.id === 'solarized' && 'bg-[hsl(44_87%_94%)]'
						)}
					>
						<span
							class={cn(
								'h-3.5 w-3.5 rounded-full',
								t.id === 'dracula' && 'bg-[hsl(210_80%_62%)]',
								t.id === 'dark' && 'bg-[hsl(210_80%_62%)]',
								t.id === 'light' && 'bg-[hsl(210_80%_50%)]',
								t.id === 'solarized' && 'bg-[hsl(18_80%_44%)]'
							)}
						></span>
					</span>
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium">{t.label}</span>
						<span class="block text-[11px] text-muted-foreground">{t.description}</span>
					</span>
					{#if active}
						<Check class="h-4 w-4 text-foreground" />
					{/if}
				</button>
			{/each}
		</div>
	</Card>

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
		<h2 class="text-sm font-semibold">Summary metadata</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Re-parses YAML frontmatter from every <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">summary.md</code>
			into the cache that powers the Graph view. Run after editing summaries by hand
			or when you've upgraded summaries from older versions without metadata.
		</p>
		<div class="mt-3 grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
			<div>
				<div class="text-muted-foreground">Indexed</div>
				<div class="mt-0.5 font-mono">{summaryMeta.items.length}</div>
			</div>
			<div>
				<div class="text-muted-foreground">Papers total</div>
				<div class="mt-0.5 font-mono">{papers.items.length}</div>
			</div>
			<div>
				<div class="text-muted-foreground">Coverage</div>
				<div class="mt-0.5 font-mono">
					{papers.items.length === 0
						? '—'
						: `${Math.round((summaryMeta.items.length / papers.items.length) * 100)}%`}
				</div>
			</div>
		</div>
		{#if reindexResult}
			<p class="mt-3 text-xs text-muted-foreground">
				Scanned {reindexResult.scanned} papers · indexed {reindexResult.indexed}
				{#if reindexResult.cleared > 0}
					· cleared {reindexResult.cleared} stale
				{/if}.
			</p>
		{/if}
		{#if reindexError}
			<p class="mt-3 text-xs text-destructive">{reindexError}</p>
		{/if}
		<div class="mt-4">
			<Button variant="outline" onclick={doReindexSummaryMeta} disabled={reindexing}>
				{#if reindexing}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Tags class="h-4 w-4" />
				{/if}
				Reindex summary metadata
			</Button>
		</div>
	</Card>

	<Card class="p-6">
		<h2 class="text-sm font-semibold">About</h2>
		<div class="mt-3 flex items-baseline gap-2">
			<span class="text-xs text-muted-foreground">Version</span>
			<span class="font-mono text-sm">v{APP_VERSION}</span>
		</div>
		<p class="mt-2 text-xs text-muted-foreground">
			Re:OS standalone · Tauri 2 · SvelteKit 5
		</p>
	</Card>
</div>
