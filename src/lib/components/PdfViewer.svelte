<script module lang="ts">
	// Cache of fully-loaded PDFs, keyed by paper id. When the route unmounts on
	// tab switch we stash the parsed pdf doc + rendered canvas DOM here so a
	// remount can reattach them instantly instead of re-reading and rasterizing
	// every page. Lives for the app session; cleared on app restart.
	type CachedPdf = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		pdfDoc: any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		pdfjsLib: any;
		// PDF.js' viewer-level builders own the selection boundary helpers for
		// each text layer. Keep them with the cached DOM so selection still works
		// after switching away from and back to a paper tab.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		textLayerBuilders: any[];
		fragment: DocumentFragment;
		path: string;
		scale: number;
		scrollTop: number;
		totalPages: number;
		currentPage: number;
	};
	const pdfCache = new Map<string, CachedPdf>();
</script>

<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { readFile } from '@tauri-apps/plugin-fs';
	import { Button } from '$lib/components/ui';
	import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, Minimize2 } from 'lucide-svelte';
	import { ui } from '$lib/stores.svelte';

	let { path, paperId }: { path: string; paperId?: string } = $props();

	let scrollContainer = $state<HTMLDivElement | undefined>();
	let canvasContainer = $state<HTMLDivElement | undefined>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let pdfDoc: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let pdfjsLib: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let TextLayerBuilderCtor: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let textLayerBuilders: any[] = [];
	let totalPages = $state(0);
	let currentPage = $state(1);
	let scale = $state(1.2);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let restored = $state(false);

	let pageObserver: IntersectionObserver | null = null;
	let renderToken = 0;

	function posKey(id: string) {
		return `reos:pdfPos:${id}`;
	}
	function readSavedPage(id: string): number | null {
		try {
			const raw = localStorage.getItem(posKey(id));
			if (!raw) return null;
			const parsed = JSON.parse(raw) as { page?: number };
			return typeof parsed.page === 'number' ? parsed.page : null;
		} catch {
			return null;
		}
	}
	function writeSavedPage(id: string, page: number) {
		try {
			localStorage.setItem(posKey(id), JSON.stringify({ page }));
		} catch {
			// quota or storage unavailable — ignore
		}
	}
	function scrollToPageInstant(n: number) {
		if (!scrollContainer || !canvasContainer) return;
		const el = canvasContainer.querySelector<HTMLElement>(`[data-page-number="${n}"]`);
		if (el) scrollContainer.scrollTop = el.offsetTop;
	}

	function attachPageObserver() {
		if (!canvasContainer) return;
		pageObserver?.disconnect();
		pageObserver = new IntersectionObserver(
			(entries) => {
				let best: IntersectionObserverEntry | null = null;
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
				}
				if (best) {
					const n = Number((best.target as HTMLElement).dataset.pageNumber);
					if (n) currentPage = n;
				}
			},
			{ root: scrollContainer, threshold: [0.25, 0.5, 0.75] }
		);
		canvasContainer
			.querySelectorAll<HTMLElement>('[data-page-number]')
			.forEach((el) => pageObserver!.observe(el));
	}

	async function restoreFromCache(cached: CachedPdf): Promise<boolean> {
		if (!canvasContainer || !scrollContainer) return false;
		pdfDoc = cached.pdfDoc;
		pdfjsLib = cached.pdfjsLib;
		textLayerBuilders = cached.textLayerBuilders;
		totalPages = cached.totalPages;
		scale = cached.scale;
		currentPage = cached.currentPage;
		canvasContainer.innerHTML = '';
		canvasContainer.appendChild(cached.fragment);
		// The fragment is empty now (children moved into the container). Drop
		// the cache entry so a stray duplicate loadPdf() in the same lifecycle
		// can't re-run this branch and wipe the container with empty content.
		if (paperId) pdfCache.delete(paperId);
		attachPageObserver();
		// Unhide the canvas container before assigning scrollTop — while
		// `loading` is true the container has display:none and the scroll
		// range collapses to 0, silently clamping any scrollTop we set here.
		loading = false;
		await tick();
		scrollContainer.scrollTop = cached.scrollTop;
		return true;
	}

	async function loadPdf() {
		loading = true;
		error = null;
		restored = false;
		try {
			// Fast path: a previous mount of this paper left its parsed doc and
			// rendered canvases in the cache. Reattach them and skip the file
			// read + rasterize entirely.
			const cached = paperId ? pdfCache.get(paperId) : null;
			if (cached && cached.path === path) {
				const ok = await restoreFromCache(cached);
				if (ok) return;
			}

			if (!pdfjsLib) {
				pdfjsLib = await import('pdfjs-dist');
				// Inline the worker for Tauri (no remote URL fetch needed).
				const workerSrc = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
				pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc.default;
			}
			if (!TextLayerBuilderCtor) {
				const pdfjsViewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
				TextLayerBuilderCtor = pdfjsViewer.TextLayerBuilder;
			}

			const bytes = await readFile(path);
			pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
			totalPages = pdfDoc.numPages;
			currentPage = 1;
			// New document — drop any stale wrappers from a previous PDF so the
			// in-place re-render path in renderAll() doesn't try to reuse them.
			if (canvasContainer) canvasContainer.innerHTML = '';
			for (const builder of textLayerBuilders) builder?.cancel?.();
			textLayerBuilders = [];
			pageObserver?.disconnect();
			pageObserver = null;
			await fitToWidth();
			await renderAll();
			// Unhide the canvas before doing the scroll restore — see the same
			// note in restoreFromCache(). Without this the scrollTop snaps to 0.
			loading = false;
			await tick();
			// Restore the user's last position for this paper, if any. Set
			// currentPage explicitly so the save effect doesn't briefly persist
			// page=1 before the IntersectionObserver catches up after scrolling.
			const saved = paperId ? readSavedPage(paperId) : null;
			if (saved && saved > 1 && saved <= totalPages) {
				currentPage = saved;
				scrollToPageInstant(saved);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
			restored = true;
		}
	}

	async function fitToWidth() {
		if (!pdfDoc || !scrollContainer) return;
		const page = await pdfDoc.getPage(1);
		const baseViewport = page.getViewport({ scale: 1 });
		// scrollContainer has p-4 (16px) on each side.
		const available = scrollContainer.clientWidth - 32;
		if (available > 0) scale = available / baseViewport.width;
	}

	async function renderAll() {
		if (!pdfDoc || !canvasContainer) return;
		const token = ++renderToken;

		// Re-use existing wrappers when the page count matches. This keeps
		// scrollTop stable across zoom and fullscreen-fit re-renders — wiping
		// the container collapses content height to 0 and the browser snaps
		// the user back to the top.
		const existing = Array.from(
			canvasContainer.querySelectorAll<HTMLDivElement>('[data-page-number]')
		);
		const inPlace = existing.length === totalPages;

		if (!inPlace) {
			canvasContainer.innerHTML = '';
			pageObserver?.disconnect();
			pageObserver = new IntersectionObserver(
				(entries) => {
					// Pick the most-visible page as the current one.
					let best: IntersectionObserverEntry | null = null;
					for (const entry of entries) {
						if (!entry.isIntersecting) continue;
						if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
					}
					if (best) {
						const n = Number((best.target as HTMLElement).dataset.pageNumber);
						if (n) currentPage = n;
					}
				},
				{ root: scrollContainer, threshold: [0.25, 0.5, 0.75] }
			);
		}

		// Anchor the scroll position to whichever page was visible before the
		// re-render. After each iteration mutates a wrapper above the anchor,
		// re-align scrollTop so the anchor stays visually fixed.
		const anchorPage = inPlace ? currentPage : 0;
		const anchorEl = anchorPage > 0 ? existing[anchorPage - 1] : null;

		for (let i = 1; i <= totalPages; i++) {
			if (token !== renderToken) return;
			const oldAnchorTop = anchorEl?.offsetTop ?? 0;

			const page = await pdfDoc.getPage(i);
			const viewport = page.getViewport({ scale });

			let wrapper: HTMLDivElement;
			let canvas: HTMLCanvasElement;
			let textLayerDiv: HTMLDivElement;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let textLayerBuilder: any;
			if (inPlace) {
				wrapper = existing[i - 1];
				canvas = wrapper.querySelector('canvas')!;
				textLayerBuilder = textLayerBuilders[i - 1];
				if (textLayerBuilder?.div?.parentNode === wrapper) {
					textLayerDiv = textLayerBuilder.div;
				} else {
					// Handles a layer rendered before the builder-backed selection fix
					// (notably during hot reload) without leaving stale overlay nodes.
					wrapper.querySelector('.textLayer')?.remove();
					if (!TextLayerBuilderCtor) {
						const pdfjsViewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
						TextLayerBuilderCtor = pdfjsViewer.TextLayerBuilder;
					}
					textLayerBuilder = new TextLayerBuilderCtor({ pdfPage: page });
					textLayerBuilders[i - 1] = textLayerBuilder;
					textLayerDiv = textLayerBuilder.div;
					wrapper.appendChild(textLayerDiv);
				}
			} else {
				wrapper = document.createElement('div');
				wrapper.dataset.pageNumber = String(i);
				wrapper.className = 'relative mx-auto';
				canvas = document.createElement('canvas');
				canvas.className = 'block rounded shadow-lg';
				wrapper.appendChild(canvas);
				textLayerBuilder = new TextLayerBuilderCtor({ pdfPage: page });
				textLayerBuilders[i - 1] = textLayerBuilder;
				textLayerDiv = textLayerBuilder.div;
				wrapper.appendChild(textLayerDiv);
				canvasContainer.appendChild(wrapper);
				pageObserver!.observe(wrapper);
			}
			// TextLayerBuilder expresses font sizes and marked-content positions
			// relative to this PDF.js variable. Keeping it on the page wrapper also
			// makes the overlay track the canvas exactly after zooming.
			wrapper.style.setProperty('--scale-factor', String(viewport.scale));

			// HiDPI/Retina: render to a backing-store-sized canvas so the
			// rasterized PDF matches the screen's physical pixels, then let CSS
			// scale it back down to the logical viewport size. Without this the
			// browser upscales a 1x canvas on a 2x display and the result looks
			// soft.
			const outputScale = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
			const cssWidth = Math.floor(viewport.width);
			const cssHeight = Math.floor(viewport.height);
			wrapper.style.width = `${cssWidth}px`;
			canvas.width = Math.floor(viewport.width * outputScale);
			canvas.height = Math.floor(viewport.height * outputScale);
			canvas.style.width = `${cssWidth}px`;
			canvas.style.height = `${cssHeight}px`;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				const transform =
					outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
				await page.render({ canvasContext: ctx, viewport, transform }).promise;
			}

			// Use PDF.js' viewer builder rather than the low-level TextLayer alone.
			// Besides positioning spans, the builder manages an end-of-content
			// sentinel while dragging. That keeps selection bounded to the active
			// line/paragraph instead of jumping across absolutely-positioned spans.
			await textLayerBuilder.render(viewport);
			if (token !== renderToken) return;

			// Keep the anchor pinned: any size change above it shifts its
			// offsetTop, so add the delta to scrollTop to compensate.
			if (anchorEl && scrollContainer && i < anchorPage) {
				const delta = anchorEl.offsetTop - oldAnchorTop;
				if (delta !== 0) scrollContainer.scrollTop += delta;
			}
		}
	}

	function scrollToPage(n: number) {
		if (!canvasContainer) return;
		const el = canvasContainer.querySelector<HTMLElement>(`[data-page-number="${n}"]`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function nextPage() {
		if (currentPage < totalPages) scrollToPage(currentPage + 1);
	}
	function prevPage() {
		if (currentPage > 1) scrollToPage(currentPage - 1);
	}
	function zoomIn() {
		scale = Math.min(scale + 0.2, 3);
		renderAll();
	}
	function zoomOut() {
		scale = Math.max(scale - 0.2, 0.5);
		renderAll();
	}

	onMount(() => {
		// loadPdf is triggered by the path-watching $effect below.
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && ui.pdfFullscreen) ui.pdfFullscreen = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	let lastLoadedPath = $state<string | null>(null);
	$effect(() => {
		if (path && path !== lastLoadedPath) {
			lastLoadedPath = path;
			loadPdf();
		}
	});

	$effect(() => {
		if (!restored || !paperId) return;
		writeSavedPage(paperId, currentPage);
	});

	// Refit width when the user toggles fullscreen — the container changes
	// width and the existing scale would leave the PDF either tiny (entering
	// fullscreen from a narrow pane) or clipped (exiting fullscreen).
	let lastFullscreen = $state<boolean | null>(null);
	$effect(() => {
		const fs = ui.pdfFullscreen;
		if (lastFullscreen === null) {
			lastFullscreen = fs;
			return;
		}
		if (fs === lastFullscreen) return;
		lastFullscreen = fs;
		if (!pdfDoc) return;
		// Defer to next frame so the layout has settled at the new width.
		requestAnimationFrame(async () => {
			await fitToWidth();
			await renderAll();
		});
	});

	onDestroy(() => {
		pageObserver?.disconnect();
		// If we own a fully-loaded PDF for a known paper, stash it for the next
		// mount instead of destroying. Switching paper tabs will reattach the
		// rendered canvases without a re-read or re-rasterize.
		if (paperId && pdfDoc && canvasContainer && totalPages > 0 && restored && !error) {
			const fragment = document.createDocumentFragment();
			while (canvasContainer.firstChild) fragment.appendChild(canvasContainer.firstChild);
			pdfCache.set(paperId, {
				pdfDoc,
				pdfjsLib,
				textLayerBuilders,
				fragment,
				path,
				scale,
				scrollTop: scrollContainer?.scrollTop ?? 0,
				totalPages,
				currentPage
			});
		} else {
			for (const builder of textLayerBuilders) builder?.cancel?.();
			pdfDoc?.destroy?.();
		}
	});
</script>

<div class="flex h-full flex-col">
	<div class="flex h-10 items-center justify-between border-b border-border/60 px-3">
		<div class="flex items-center gap-1">
			<Button variant="ghost" size="icon" onclick={prevPage} disabled={currentPage <= 1}>
				<ChevronLeft class="h-4 w-4" />
			</Button>
			<span class="font-mono text-xs text-muted-foreground">
				{currentPage} / {totalPages || '—'}
			</span>
			<Button
				variant="ghost"
				size="icon"
				onclick={nextPage}
				disabled={currentPage >= totalPages}
			>
				<ChevronRight class="h-4 w-4" />
			</Button>
		</div>
		<div class="flex items-center gap-1">
			<Button variant="ghost" size="icon" onclick={zoomOut}>
				<ZoomOut class="h-4 w-4" />
			</Button>
			<span class="font-mono text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
			<Button variant="ghost" size="icon" onclick={zoomIn}>
				<ZoomIn class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				onclick={() => (ui.pdfFullscreen = !ui.pdfFullscreen)}
				aria-label="Toggle fullscreen"
			>
				{#if ui.pdfFullscreen}
					<Minimize2 class="h-4 w-4" />
				{:else}
					<Maximize2 class="h-4 w-4" />
				{/if}
			</Button>
		</div>
	</div>

	<div bind:this={scrollContainer} class="flex-1 overflow-auto bg-muted/30 p-4">
		{#if loading}
			<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
				Loading PDF…
			</div>
		{:else if error}
			<div class="flex h-full items-center justify-center text-sm text-destructive">
				{error}
			</div>
		{/if}
		<div bind:this={canvasContainer} class="space-y-4" class:hidden={loading || !!error}></div>
	</div>
</div>

<style>
	/* PDF.js text layer: invisible spans positioned over the canvas so the user
	   can select and copy text from the rendered page. */
	:global(.textLayer) {
		position: absolute;
		inset: 0;
		overflow: clip;
		line-height: 1;
		opacity: 1;
		text-align: initial;
		text-size-adjust: none;
		forced-color-adjust: none;
		transform-origin: 0 0;
		caret-color: CanvasText;
		z-index: 2;
	}

	:global(.textLayer :is(span, br)) {
		color: transparent;
		position: absolute;
		white-space: pre;
		cursor: text;
		transform-origin: 0% 0%;
	}

	:global(.textLayer > :not(.markedContent)),
	:global(.textLayer .markedContent span:not(.markedContent)) {
		z-index: 1;
	}

	:global(.textLayer span.markedContent) {
		top: 0;
		height: 0;
	}

	:global(.textLayer span[role='img']) {
		user-select: none;
		cursor: default;
	}

	:global(.textLayer ::selection) {
		background: rgba(0, 100, 250, 0.3);
	}

	:global(.textLayer br::selection) {
		background: transparent;
	}

	/* TextLayerBuilder moves this full-page sentinel beside the active range
	   during a drag, which gives WebKit a stable selection boundary at the end
	   of short lines and paragraphs. */
	:global(.textLayer .endOfContent) {
		display: block;
		position: absolute;
		inset: 100% 0 0;
		z-index: 0;
		cursor: default;
		user-select: none;
	}

	:global(.textLayer.selecting .endOfContent) {
		top: 0;
	}
</style>
