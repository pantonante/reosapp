<script lang="ts">
	import { Button, Card, Input } from '$lib/components/ui';
	import { config, papers, summaryMeta, threads } from '$lib/stores.svelte';
	import { rebuildCache, type RebuildResult } from '$lib/tauri/rebuild';
	import { db } from '$lib/tauri/db';
	import { INBOX_SLUG, readPaperSummary } from '$lib/tauri/fs';
	import { parseSummaryFrontmatter, isMetaEmpty } from '$lib/summary-meta';
	import { open as openDialog, ask } from '@tauri-apps/plugin-dialog';
	import {
		FolderOpen,
		RefreshCw,
		Loader2,
		Tags,
		Check,
		KeyRound,
		Eye,
		EyeOff,
		Trash2,
		ExternalLink,
		ShieldCheck,
		Wifi,
		Copy,
		Share2
	} from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { theme, THEMES, type Theme } from '$lib/theme.svelte';
	import { cn } from '$lib/utils/cn';
	import { APP_VERSION } from '$lib/version';
	import {
		deleteAlphaXivApiKey,
		getAlphaXivCredentialStatus,
		saveAlphaXivApiKey,
		testAlphaXivApiKey,
		type AlphaXivCredentialStatus
	} from '$lib/tauri/alphaxiv';
	import { openExternal } from '$lib/tauri/shell';
	import {
		getRemoteServerStatus,
		setRemoteServerEnabled,
		shareRemoteAddress,
		type RemoteServerStatus
	} from '$lib/tauri/remote-server';

	let rebuilding = $state(false);
	let lastResult = $state<RebuildResult | null>(null);
	let builtAt = $state<string | null>(null);
	let error = $state<string | null>(null);

	let reindexing = $state(false);
	let reindexResult = $state<{ scanned: number; indexed: number; cleared: number } | null>(null);
	let reindexError = $state<string | null>(null);

	let alphaXivStatus = $state<AlphaXivCredentialStatus | null>(null);
	let alphaXivKey = $state('');
	let alphaXivKeyVisible = $state(false);
	let alphaXivBusy = $state<'save' | 'test' | 'remove' | null>(null);
	let alphaXivMessage = $state<string | null>(null);
	let alphaXivError = $state<string | null>(null);
	let remoteServer = $state<RemoteServerStatus | null>(null);
	let remoteServerBusy = $state(false);
	let remoteServerError = $state<string | null>(null);
	let copiedAddress = $state<string | null>(null);
	let sharingAddress = $state<string | null>(null);

	onMount(async () => {
		builtAt = await db.getMeta('builtAt');
		try {
			remoteServer = await getRemoteServerStatus();
		} catch (e) {
			remoteServerError = e instanceof Error ? e.message : String(e);
		}
		try {
			alphaXivStatus = await getAlphaXivCredentialStatus();
		} catch (e) {
			alphaXivError = e instanceof Error ? e.message : String(e);
		}
	});

	async function toggleRemoteServer() {
		remoteServerBusy = true;
		remoteServerError = null;
		try {
			remoteServer = await setRemoteServerEnabled(!remoteServer?.running);
			await config.load();
		} catch (e) {
			remoteServerError = e instanceof Error ? e.message : String(e);
		} finally {
			remoteServerBusy = false;
		}
	}

	async function copyAddress(address: string) {
		try {
			await navigator.clipboard.writeText(address);
			copiedAddress = address;
		} catch (e) {
			remoteServerError = e instanceof Error ? e.message : String(e);
		}
	}

	async function shareAddress(address: string) {
		sharingAddress = address;
		remoteServerError = null;
		try {
			await shareRemoteAddress(address);
		} catch (e) {
			remoteServerError = e instanceof Error ? e.message : String(e);
		} finally {
			sharingAddress = null;
		}
	}

	async function saveAlphaXivKey() {
		if (!alphaXivKey.trim()) return;
		alphaXivBusy = 'save';
		alphaXivMessage = null;
		alphaXivError = null;
		try {
			alphaXivStatus = await saveAlphaXivApiKey(alphaXivKey);
			alphaXivKey = '';
			alphaXivKeyVisible = false;
			alphaXivMessage = 'Key saved to the system credential vault.';
		} catch (e) {
			alphaXivError = e instanceof Error ? e.message : String(e);
		} finally {
			alphaXivBusy = null;
		}
	}

	async function testAlphaXivConnection() {
		alphaXivBusy = 'test';
		alphaXivMessage = null;
		alphaXivError = null;
		try {
			await testAlphaXivApiKey();
			alphaXivMessage = 'Connected. AlphaXiv paper reports are available.';
		} catch (e) {
			alphaXivError = e instanceof Error ? e.message : String(e);
		} finally {
			alphaXivBusy = null;
		}
	}

	async function removeAlphaXivKey() {
		const ok = await ask(
			'Remove the AlphaXiv API key from this device? Already imported summaries and images will be kept.',
			{ title: 'Remove AlphaXiv key', kind: 'warning', okLabel: 'Remove', cancelLabel: 'Cancel' }
		);
		if (!ok) return;
		alphaXivBusy = 'remove';
		alphaXivMessage = null;
		alphaXivError = null;
		try {
			alphaXivStatus = await deleteAlphaXivApiKey();
			alphaXivKey = '';
			alphaXivMessage = 'AlphaXiv key removed.';
		} catch (e) {
			alphaXivError = e instanceof Error ? e.message : String(e);
		} finally {
			alphaXivBusy = null;
		}
	}

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
		<div class="flex items-start justify-between gap-4">
			<div class="flex min-w-0 items-start gap-3">
				<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-border/70 bg-secondary/50">
					<Wifi class="h-4 w-4 text-accent" />
				</span>
				<div>
					<h2 class="text-sm font-semibold">iPad server</h2>
					<p class="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
						Browse your papers, PDFs, summaries, and notes from an iPad on the same network.
						The server listens on all network interfaces while Re:OS is open.
					</p>
				</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-label="iPad server"
				aria-checked={remoteServer?.running ?? false}
				disabled={remoteServerBusy || !remoteServer || !config.value.papersDir}
				class={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', remoteServer?.running ? 'bg-primary' : 'bg-muted')}
				onclick={toggleRemoteServer}
			>
				<span class={cn('absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform', remoteServer?.running ? 'translate-x-0.5' : '-translate-x-[19px]')} style="left: 21px"></span>
			</button>
		</div>
		{#if remoteServer?.running}
			<div class="mt-5 border-t border-border/60 pt-4">
				<p class="text-xs font-medium">Open one of these addresses in Safari on your iPad:</p>
				{#if remoteServer.addresses.length}
					<div class="mt-2 space-y-2">
						{#each remoteServer.addresses as address}
							<div class="flex items-center gap-2 rounded-[8px] border border-border/60 bg-secondary/30 p-2">
								<code class="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap px-1 font-mono text-xs">{address}</code>
								<Button variant="outline" size="sm" aria-label="Copy address" onclick={() => copyAddress(address)}>
									{#if copiedAddress === address}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
								</Button>
								{#if remoteServer.airdropAvailable}
									<Button variant="outline" size="sm" aria-label="Share address with AirDrop" disabled={!!sharingAddress} onclick={() => shareAddress(address)}>
										{#if sharingAddress === address}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Share2 class="h-3.5 w-3.5" />{/if}
										Share
									</Button>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<p class="mt-2 text-xs text-muted-foreground">No active IPv4 network address found. Connect your Mac to Wi-Fi or Ethernet.</p>
				{/if}
				<p class="mt-3 text-[11px] text-muted-foreground">The address includes a private access key. Anyone with the link on your network can read your library and edit notes.</p>
			</div>
		{/if}
		{#if remoteServerError}<p class="mt-3 text-xs text-destructive">{remoteServerError}</p>{/if}
	</Card>

	<Card class="overflow-hidden">
		<div class="border-b border-border/60 bg-secondary/20 px-6 py-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="flex min-w-0 gap-3">
					<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-border/70 bg-background shadow-sm">
						<KeyRound class="h-4 w-4 text-accent" />
					</span>
					<div>
						<h2 class="text-sm font-semibold">AlphaXiv</h2>
						<p class="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
							Import available AI paper reports through AlphaXiv's official MCP API. Reports and
							API-provided figures are cached with the paper for offline reading.
						</p>
					</div>
				</div>
				<div
					class={cn(
						'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider',
						alphaXivStatus?.configured
							? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
							: 'border-border/70 bg-background text-muted-foreground'
					)}
				>
					<span
						class={cn(
							'h-1.5 w-1.5 rounded-full',
							alphaXivStatus?.configured ? 'bg-emerald-500' : 'bg-muted-foreground/50'
						)}
					></span>
					{alphaXivStatus?.configured ? `Configured ${alphaXivStatus.hint ?? ''}` : 'Not configured'}
				</div>
			</div>
		</div>

		<div class="px-6 py-5">
			<label for="alphaxiv-key" class="text-xs font-medium">
				{alphaXivStatus?.configured ? 'Replace API key' : 'API key'}
			</label>
			<div class="mt-2 flex flex-wrap gap-2">
				<div class="relative min-w-[16rem] flex-1">
					<Input
						id="alphaxiv-key"
						type={alphaXivKeyVisible ? 'text' : 'password'}
						bind:value={alphaXivKey}
						placeholder={alphaXivStatus?.configured ? 'Enter a replacement key' : 'axv2_…'}
						autocomplete="off"
						spellcheck={false}
						class="pr-10 font-mono text-xs"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter' && alphaXivKey.trim() && !alphaXivBusy) void saveAlphaXivKey();
						}}
					/>
					<button
						type="button"
						class="absolute right-1 top-1 flex h-7 w-8 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
						onclick={() => (alphaXivKeyVisible = !alphaXivKeyVisible)}
						aria-label={alphaXivKeyVisible ? 'Hide API key' : 'Show API key'}
					>
						{#if alphaXivKeyVisible}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
					</button>
				</div>
				<Button onclick={saveAlphaXivKey} disabled={!alphaXivKey.trim() || !!alphaXivBusy}>
					{#if alphaXivBusy === 'save'}<Loader2 class="h-4 w-4 animate-spin" />{:else}<ShieldCheck class="h-4 w-4" />{/if}
					Save key
				</Button>
			</div>

			<div class="mt-3 flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onclick={testAlphaXivConnection}
					disabled={!alphaXivStatus?.configured || !!alphaXivBusy}
				>
					{#if alphaXivBusy === 'test'}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
					Test connection
				</Button>
				{#if alphaXivStatus?.configured}
					<Button
						variant="ghost"
						size="sm"
						class="text-destructive hover:text-destructive"
						onclick={removeAlphaXivKey}
						disabled={!!alphaXivBusy}
					>
						{#if alphaXivBusy === 'remove'}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
						Remove
					</Button>
				{/if}
				<Button
					variant="link"
					size="sm"
					class="ml-auto px-1"
					onclick={() => openExternal('https://www.alphaxiv.org/settings')}
				>
					Manage keys on AlphaXiv
					<ExternalLink class="h-3 w-3" />
				</Button>
			</div>

			{#if alphaXivMessage}
				<p class="mt-3 text-xs text-emerald-600 dark:text-emerald-400">{alphaXivMessage}</p>
			{/if}
			{#if alphaXivError}
				<p class="mt-3 text-xs text-destructive">{alphaXivError}</p>
			{/if}
			<p class="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
				<ShieldCheck class="h-3 w-3 shrink-0" />
				The key is stored in your system credential vault, never in the Re:OS database or papers folder.
			</p>
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
		<h2 class="text-sm font-semibold">MCP server</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Chat with your papers and threads from Claude Code or Claude Desktop. The server is
			read-only: it reads the papers folder directly and never modifies your library. It ships
			with the Re:OS repo under <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">mcp/</code>.
		</p>

		<h3 class="mt-4 text-xs font-semibold">1. Build it once</h3>
		<pre class="mt-1.5 select-text overflow-x-auto rounded-[8px] bg-muted p-3 font-mono text-[11px] leading-relaxed">cd &lt;reos-repo&gt;/mcp
npm install
npm run build</pre>

		<h3 class="mt-4 text-xs font-semibold">2. Register it</h3>
		<p class="mt-1 text-xs text-muted-foreground">Claude Code (available in every project):</p>
		<pre class="mt-1.5 select-text overflow-x-auto rounded-[8px] bg-muted p-3 font-mono text-[11px] leading-relaxed">claude mcp add --scope user reos -- node &lt;reos-repo&gt;/mcp/dist/index.js</pre>
		<p class="mt-2 text-xs text-muted-foreground">
			Claude Desktop — add to
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">~/Library/Application Support/Claude/claude_desktop_config.json</code>:
		</p>
		<pre class="mt-1.5 select-text overflow-x-auto rounded-[8px] bg-muted p-3 font-mono text-[11px] leading-relaxed">{`{
  "mcpServers": {
    "reos": {
      "command": "node",
      "args": ["<reos-repo>/mcp/dist/index.js"]
    }
  }
}`}</pre>

		<h3 class="mt-4 text-xs font-semibold">3. Use it</h3>
		<p class="mt-1 text-xs text-muted-foreground">
			Just ask in natural language — "list my active research threads", "what does paper
			2301.08243 say", "summarize the discussions in thread Mocap". Under the hood the agent
			gets eight tools:
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">list_threads</code>,
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">get_thread</code>,
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">search_papers</code>,
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">get_paper</code>,
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">get_paper_content</code>,
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">list_chats</code>,
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">get_chat</code> and
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">get_vocabulary</code>.
			It reads summaries and notes before falling back to PDFs, and it picks up the papers
			folder configured above — no separate setup. After changing the folder here, new chats
			see it immediately; rebuild is only needed when the server code itself changes.
		</p>
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
