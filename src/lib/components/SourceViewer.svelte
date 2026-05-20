<script module lang="ts">
	// Cache live iframe elements keyed by paper id. When the user switches tabs
	// we detach the iframe (keeping the element + its loaded document in memory)
	// and reattach on return, preserving scroll position, login state, and any
	// in-page JS without re-fetching the URL.
	type CachedFrame = { iframe: HTMLIFrameElement; url: string };
	const frameCache = new Map<string, CachedFrame>();
</script>

<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';

	let {
		url,
		paperId,
		reloadToken = 0
	}: { url: string; paperId: string; reloadToken?: number } = $props();
	let appliedReloadToken = 0;

	let containerEl = $state<HTMLDivElement | undefined>();
	let attachedIframe: HTMLIFrameElement | null = null;
	let attachedKey: string | null = null;

	function buildIframe(forUrl: string): HTMLIFrameElement {
		const f = document.createElement('iframe');
		f.src = forUrl;
		f.className = 'h-full w-full border-0 bg-background';
		f.setAttribute(
			'sandbox',
			'allow-scripts allow-same-origin allow-popups allow-forms'
		);
		f.setAttribute('referrerpolicy', 'no-referrer');
		f.setAttribute('data-tauri-drag-region', 'false');
		f.tabIndex = 0;
		f.title = (() => {
			try {
				return new URL(forUrl).hostname;
			} catch {
				return forUrl;
			}
		})();
		return f;
	}

	function attach(forPaperId: string, forUrl: string) {
		if (!containerEl) return;
		const key = `${forPaperId}::${forUrl}`;
		if (attachedKey === key && attachedIframe && attachedIframe.parentNode === containerEl) {
			return;
		}
		// Detach the previous iframe (it remains in cache).
		if (attachedIframe && attachedIframe.parentNode === containerEl) {
			containerEl.removeChild(attachedIframe);
		}
		attachedIframe = null;
		attachedKey = null;

		const cached = frameCache.get(forPaperId);
		if (cached && cached.url === forUrl) {
			containerEl.appendChild(cached.iframe);
			attachedIframe = cached.iframe;
			attachedKey = key;
			try {
				cached.iframe.contentWindow?.focus();
			} catch {
				/* no-op */
			}
			return;
		}

		const iframe = buildIframe(forUrl);
		// Focus on every load so WKWebView keeps the iframe as the scroll
		// target. Otherwise macOS scroll-latching relatches to the parent
		// webview after idle time and wheel events stop reaching the iframe.
		const onLoad = () => {
			try {
				iframe.contentWindow?.focus();
			} catch {
				/* cross-origin focus call is allowed but may no-op */
			}
		};
		iframe.addEventListener('load', onLoad);
		// Re-claim focus whenever the cursor enters the iframe area or the user
		// interacts with it. Cheap, idempotent — and reliably keeps WKWebView's
		// scroll latch pointed at the iframe.
		const refocus = () => {
			try {
				iframe.contentWindow?.focus();
			} catch {
				/* no-op */
			}
		};
		iframe.addEventListener('mouseenter', refocus);
		iframe.addEventListener('pointerenter', refocus);
		iframe.addEventListener('pointerdown', refocus);
		containerEl.appendChild(iframe);
		attachedIframe = iframe;
		attachedKey = key;
		frameCache.set(forPaperId, { iframe, url: forUrl });
	}

	onMount(() => {
		void tick().then(() => attach(paperId, url));
	});

	$effect(() => {
		if (!containerEl) return;
		// When the parent bumps reloadToken, drop the cached iframe so attach()
		// rebuilds from scratch instead of reattaching the stale one.
		if (reloadToken !== appliedReloadToken) {
			appliedReloadToken = reloadToken;
			const existing = frameCache.get(paperId);
			if (existing && existing.iframe.parentNode === containerEl) {
				containerEl.removeChild(existing.iframe);
			}
			frameCache.delete(paperId);
			attachedIframe = null;
			attachedKey = null;
		}
		attach(paperId, url);
	});

	onDestroy(() => {
		// Detach the iframe from the container but keep it in the cache so the
		// next mount can reattach without losing state.
		if (attachedIframe && containerEl && attachedIframe.parentNode === containerEl) {
			containerEl.removeChild(attachedIframe);
		}
		attachedIframe = null;
		attachedKey = null;
	});
</script>

<div
	bind:this={containerEl}
	class="h-full w-full"
	data-tauri-drag-region="false"
	onmouseenter={() => {
		try {
			attachedIframe?.contentWindow?.focus();
		} catch {
			/* no-op */
		}
	}}
	role="presentation"
></div>
