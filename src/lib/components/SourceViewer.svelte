<script lang="ts">
	import { onMount } from 'svelte';
	import { Globe, ExternalLink, RotateCw } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { openExternal } from '$lib/tauri/shell';

	let { url }: { url: string } = $props();

	let iframeEl = $state<HTMLIFrameElement | null>(null);
	let blocked = $state(false);
	let loadedOnce = $state(false);
	let reloadKey = $state(0);

	const hostname = $derived.by(() => {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	});

	const favicon = $derived(`https://${hostname}/favicon.ico`);

	// Many sites send X-Frame-Options: DENY / Content-Security-Policy frame-ancestors,
	// which silently produces a blank iframe — the `load` event still fires (in
	// most browsers it does not), and `contentDocument` is either null or throws
	// on access. We try both signals:
	//   • If `load` hasn't fired after ~3.5s, assume the frame was refused.
	//   • Once `load` fires, try reading `contentDocument`; null/throw = blocked.
	function checkBlocked() {
		const f = iframeEl;
		if (!f) return;
		try {
			const doc = f.contentDocument;
			if (!doc) {
				blocked = true;
				return;
			}
			// If we can read the document but it's a tiny error page (about:blank),
			// treat that as blocked too.
			if (doc.location && doc.location.href === 'about:blank') {
				blocked = true;
			}
		} catch {
			// Cross-origin access threw — that's actually the *success* path: the
			// site loaded but we can't introspect it. Only mark blocked if the
			// iframe never loaded at all.
		}
	}

	function onLoad() {
		loadedOnce = true;
		checkBlocked();
	}

	function reload() {
		blocked = false;
		loadedOnce = false;
		reloadKey += 1;
	}

	onMount(() => {
		const timer = setTimeout(() => {
			if (!loadedOnce) blocked = true;
		}, 3500);
		return () => clearTimeout(timer);
	});
</script>

<div class="relative h-full w-full">
	{#if !blocked}
		{#key reloadKey}
			<iframe
				bind:this={iframeEl}
				src={url}
				title={hostname}
				class="h-full w-full border-0 bg-background"
				sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
				referrerpolicy="no-referrer"
				onload={onLoad}
			></iframe>
		{/key}
	{:else}
		<div class="flex h-full items-center justify-center p-6">
			<div class="w-full max-w-md rounded-lg border border-border/60 bg-card p-5 shadow-sm">
				<div class="flex items-start gap-3">
					<img
						src={favicon}
						alt=""
						class="mt-0.5 h-6 w-6 shrink-0 rounded"
						onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
					/>
					<div class="min-w-0 flex-1">
						<div class="text-sm font-medium text-foreground">{hostname}</div>
						<div class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={url}>
							{url}
						</div>
					</div>
				</div>
				<p class="mt-4 text-xs leading-relaxed text-muted-foreground">
					This site can't be displayed inside Re:OS (it refuses to be framed). The Summary and
					Chat tabs still work — they fetch the page live via the Claude CLI.
				</p>
				<div class="mt-4 flex gap-2">
					<Button size="sm" onclick={() => openExternal(url)}>
						<ExternalLink class="h-3.5 w-3.5" />
						Open in browser
					</Button>
					<Button size="sm" variant="subtle" onclick={reload}>
						<RotateCw class="h-3.5 w-3.5" />
						Try again
					</Button>
				</div>
				<div class="mt-3 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
					<Globe class="h-3 w-3" />
					Source URL
				</div>
			</div>
		</div>
	{/if}
</div>
