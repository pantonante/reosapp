<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { Marked } from 'marked';
	import { katexExtension } from '$lib/utils/markdown-katex';
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { isVideoPath, PAPER_LINK_SCHEME } from '$lib/note-format';
	import { papers, ui } from '$lib/stores.svelte';
	import { loadMediaBlobUrl, resolveNoteMediaPath } from '$lib/tauri/notes';
	import { openExternal } from '$lib/tauri/shell';

	let { content, threadSlug }: { content: string; threadSlug: string } = $props();

	function escapeAttr(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	}

	const marked = new Marked({ async: false });
	marked.use(katexExtension());
	// Markdown has no video syntax: `![caption](clip.mp4)` renders as a player.
	marked.use({
		renderer: {
			image({ href, title, text }) {
				if (!isVideoPath(href)) return false;
				const label = title || text;
				return `<video controls preload="metadata" src="${escapeAttr(href)}"${
					label ? ` title="${escapeAttr(label)}"` : ''
				}></video>`;
			}
		}
	});

	// Local media can't be loaded by URL from the webview, so `src` is moved
	// to `data-note-src` before the HTML hits the DOM (no broken-image flash)
	// and swapped for a blob URL once the bytes are read from disk.
	const MEDIA_SELECTOR = 'img[src], video[src], source[src]';
	// lucide "file-text", inlined so it can live inside rendered markdown.
	const PAPER_ICON =
		'<svg class="paper-link-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

	const html = $derived.by(() => {
		const tpl = document.createElement('template');
		tpl.innerHTML = marked.parse(content) as string;
		for (const el of tpl.content.querySelectorAll(MEDIA_SELECTOR)) {
			const src = el.getAttribute('src') ?? '';
			if (/^(https?:|data:|blob:)/i.test(src)) continue;
			el.setAttribute('data-note-src', src);
			el.removeAttribute('src');
		}
		// `paper:<arxivId>` links: tag them with the paper they point to (read
		// from the store, so links update when papers are added or removed).
		for (const a of tpl.content.querySelectorAll<HTMLAnchorElement>(`a[href^="${PAPER_LINK_SCHEME}"]`)) {
			const ref = decodeURIComponent(a.getAttribute('href')!.slice(PAPER_LINK_SCHEME.length));
			const paper = papers.get(ref);
			a.classList.add('paper-link');
			a.insertAdjacentHTML('afterbegin', PAPER_ICON);
			if (paper) {
				a.dataset.paperId = paper.id;
				a.classList.add(`paper-${paper.readingStatus}`);
				const year = paper.publishedDate.slice(0, 4);
				const authors = paper.authors.length > 1 ? `${paper.authors[0]} et al.` : (paper.authors[0] ?? '');
				a.title = [paper.title, [authors, year].filter(Boolean).join(', ')].filter(Boolean).join('\n');
			} else {
				a.classList.add('paper-link-missing');
				a.title = `Paper not in the library: ${ref}`;
			}
		}
		return tpl.innerHTML;
	});

	let container = $state<HTMLDivElement | null>(null);
	const blobUrls = new Map<string, Promise<string>>();

	function blobFor(path: string): Promise<string> {
		let url = blobUrls.get(path);
		if (!url) {
			url = loadMediaBlobUrl(path);
			blobUrls.set(path, url);
			url.catch(() => blobUrls.delete(path));
		}
		return url;
	}

	$effect(() => {
		void html;
		if (!container) return;
		for (const el of container.querySelectorAll<HTMLElement>('[data-note-src]')) {
			const src = el.dataset.noteSrc!;
			void (async () => {
				const path = await resolveNoteMediaPath(threadSlug, src);
				if (!path) return;
				try {
					el.setAttribute('src', await blobFor(path));
					if (el.tagName === 'SOURCE') (el.parentElement as HTMLVideoElement | null)?.load();
				} catch (err) {
					el.classList.add('note-media-missing');
					el.setAttribute('title', `Missing media: ${src}`);
					console.warn('[reos] note media failed to load', path, err);
				}
			})();
		}
	});

	onDestroy(() => {
		for (const url of blobUrls.values()) url.then(URL.revokeObjectURL, () => {});
	});

	// Links would otherwise navigate the app's own webview.
	function onClick(e: MouseEvent) {
		const a = (e.target as HTMLElement).closest('a');
		const href = a?.getAttribute('href');
		if (!href || href.startsWith('#')) return;
		e.preventDefault();
		if (href.startsWith(PAPER_LINK_SCHEME)) {
			const paperId = a?.dataset.paperId;
			if (!paperId) return;
			ui.openPaper(paperId, { newTab: e.metaKey || e.ctrlKey });
			goto(`/paper/${paperId}`);
			return;
		}
		if (/^(https?:|mailto:)/i.test(href)) void openExternal(href);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="note-md" bind:this={container} onclick={onClick}>
	{@html html}
</div>

<style>
	.note-md {
		font-size: 14px;
		line-height: 1.65;
		color: hsl(var(--foreground) / 0.92);
		overflow-wrap: anywhere;
	}
	.note-md > :global(:first-child) {
		margin-top: 0;
	}
	.note-md > :global(:last-child) {
		margin-bottom: 0;
	}
	.note-md :global(h1) {
		font-size: 1.35rem;
		font-weight: 600;
		line-height: 1.25;
		margin: 1.2rem 0 0.7rem;
	}
	.note-md :global(h2) {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 1.4rem 0 0.5rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid hsl(var(--border) / 0.7);
	}
	.note-md :global(h3) {
		font-size: 0.95rem;
		font-weight: 600;
		margin: 1.1rem 0 0.4rem;
	}
	.note-md :global(h4) {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: hsl(var(--muted-foreground));
		margin: 1rem 0 0.35rem;
	}
	.note-md :global(p) {
		margin: 0.7rem 0;
	}
	.note-md :global(ul),
	.note-md :global(ol) {
		margin: 0.7rem 0;
		padding-left: 1.5rem;
	}
	.note-md :global(ul) {
		list-style-type: disc;
	}
	.note-md :global(ol) {
		list-style-type: decimal;
	}
	.note-md :global(li) {
		margin: 0.25rem 0;
	}
	.note-md :global(li::marker) {
		color: hsl(var(--muted-foreground));
	}
	.note-md :global(input[type='checkbox']) {
		margin-right: 0.4rem;
		vertical-align: middle;
	}
	.note-md :global(strong) {
		font-weight: 600;
		color: hsl(var(--foreground));
	}
	.note-md :global(em) {
		font-style: italic;
	}
	.note-md :global(code) {
		font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		background: hsl(var(--muted) / 0.7);
		padding: 0.08em 0.35em;
		border-radius: 3px;
		font-size: 0.85em;
	}
	.note-md :global(pre) {
		background: hsl(var(--muted) / 0.6);
		border: 1px solid hsl(var(--border));
		border-radius: 6px;
		padding: 0.75rem 0.9rem;
		overflow-x: auto;
		margin: 0.9rem 0;
		line-height: 1.5;
	}
	.note-md :global(pre code) {
		background: transparent;
		padding: 0;
	}
	.note-md :global(blockquote) {
		border-left: 3px solid hsl(var(--accent) / 0.6);
		padding: 0.1rem 0 0.1rem 0.9rem;
		margin: 0.9rem 0;
		color: hsl(var(--muted-foreground));
	}
	.note-md :global(table) {
		border-collapse: collapse;
		margin: 1rem 0;
		font-size: 0.92em;
		width: 100%;
	}
	.note-md :global(th),
	.note-md :global(td) {
		border: 1px solid hsl(var(--border));
		padding: 0.4rem 0.6rem;
		text-align: left;
		vertical-align: top;
	}
	.note-md :global(th) {
		background: hsl(var(--muted) / 0.7);
		font-weight: 600;
	}
	.note-md :global(hr) {
		border: 0;
		border-top: 1px solid hsl(var(--border));
		margin: 1.25rem 0;
	}
	.note-md :global(a) {
		color: hsl(var(--accent));
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
	}
	.note-md :global(a.paper-link) {
		text-decoration: none;
		border-bottom: 1px solid hsl(var(--accent) / 0.45);
		padding: 0 0.1em;
		border-radius: 2px;
		cursor: pointer;
		transition: background 120ms ease-out;
	}
	.note-md :global(a.paper-link:hover) {
		background: hsl(var(--accent) / 0.1);
		border-bottom-color: hsl(var(--accent));
	}
	.note-md :global(.paper-link-icon) {
		display: inline-block;
		width: 0.85em;
		height: 0.85em;
		margin-right: 0.2em;
		vertical-align: -0.08em;
		opacity: 0.8;
	}
	.note-md :global(a.paper-link-missing) {
		color: hsl(var(--muted-foreground));
		border-bottom-style: dashed;
		border-bottom-color: hsl(var(--muted-foreground) / 0.6);
		cursor: not-allowed;
		text-decoration: line-through;
		text-decoration-thickness: 1px;
	}
	.note-md :global(a.paper-link-missing:hover) {
		background: transparent;
	}
	.note-md :global(img),
	.note-md :global(video) {
		display: block;
		max-width: 100%;
		max-height: 70vh;
		margin: 0.9rem 0;
		border-radius: 6px;
		border: 1px solid hsl(var(--border) / 0.6);
	}
	.note-md :global(video) {
		width: 100%;
		background: black;
	}
	.note-md :global(.note-media-missing) {
		min-height: 3rem;
		min-width: 8rem;
		border-style: dashed;
		background: hsl(var(--muted) / 0.4);
	}
	.note-md :global(.katex-display) {
		margin: 0.9rem 0;
		overflow-x: auto;
		overflow-y: hidden;
	}
</style>
