<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { readFile } from '@tauri-apps/plugin-fs';
	import { Button } from '$lib/components/ui';
	import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, Minimize2 } from 'lucide-svelte';
	import { ui } from '$lib/stores.svelte';

	let { path }: { path: string } = $props();

	let scrollContainer = $state<HTMLDivElement | undefined>();
	let canvasContainer = $state<HTMLDivElement | undefined>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let pdfDoc: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let pdfjsLib: any = null;
	let totalPages = $state(0);
	let currentPage = $state(1);
	let scale = $state(1.2);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let pageObserver: IntersectionObserver | null = null;
	let renderToken = 0;

	async function loadPdf() {
		loading = true;
		error = null;
		try {
			if (!pdfjsLib) {
				pdfjsLib = await import('pdfjs-dist');
				// Inline the worker for Tauri (no remote URL fetch needed).
				const workerSrc = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
				pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc.default;
			}

			const bytes = await readFile(path);
			pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
			totalPages = pdfDoc.numPages;
			currentPage = 1;
			// New document — drop any stale wrappers from a previous PDF so the
			// in-place re-render path in renderAll() doesn't try to reuse them.
			if (canvasContainer) canvasContainer.innerHTML = '';
			pageObserver?.disconnect();
			pageObserver = null;
			await fitToWidth();
			await renderAll();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
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
			if (inPlace) {
				wrapper = existing[i - 1];
				canvas = wrapper.querySelector('canvas')!;
				textLayerDiv = wrapper.querySelector<HTMLDivElement>('.textLayer')!;
				textLayerDiv.replaceChildren();
			} else {
				wrapper = document.createElement('div');
				wrapper.dataset.pageNumber = String(i);
				wrapper.className = 'relative mx-auto';
				canvas = document.createElement('canvas');
				canvas.className = 'block rounded shadow-lg';
				wrapper.appendChild(canvas);
				textLayerDiv = document.createElement('div');
				textLayerDiv.className = 'textLayer';
				wrapper.appendChild(textLayerDiv);
				canvasContainer.appendChild(wrapper);
				pageObserver!.observe(wrapper);
			}

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

			// Selectable text overlay. PDF.js positions transparent spans on top
			// of the canvas so text selection / copy-paste works against the
			// rasterized page.
			textLayerDiv.style.width = `${cssWidth}px`;
			textLayerDiv.style.height = `${cssHeight}px`;
			const textContent = await page.getTextContent();
			if (token !== renderToken) return;
			const textLayer = new pdfjsLib.TextLayer({
				textContentSource: textContent,
				container: textLayerDiv,
				viewport
			});
			await textLayer.render();

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
		loadPdf();
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
		pdfDoc?.destroy?.();
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

	:global(.textLayer ::selection) {
		background: rgba(0, 100, 250, 0.3);
	}
</style>
