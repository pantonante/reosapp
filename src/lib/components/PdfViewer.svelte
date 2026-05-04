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
			const pdfjs = await import('pdfjs-dist');
			// Inline the worker for Tauri (no remote URL fetch needed).
			const workerSrc = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
			pdfjs.GlobalWorkerOptions.workerSrc = workerSrc.default;

			const bytes = await readFile(path);
			pdfDoc = await pdfjs.getDocument({ data: bytes }).promise;
			totalPages = pdfDoc.numPages;
			currentPage = 1;
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

		for (let i = 1; i <= totalPages; i++) {
			if (token !== renderToken) return;
			const page = await pdfDoc.getPage(i);
			const viewport = page.getViewport({ scale });
			const wrapper = document.createElement('div');
			wrapper.dataset.pageNumber = String(i);
			wrapper.className = 'mx-auto';
			wrapper.style.width = `${viewport.width}px`;
			const canvas = document.createElement('canvas');
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			canvas.className = 'rounded shadow-lg';
			const ctx = canvas.getContext('2d');
			wrapper.appendChild(canvas);
			canvasContainer.appendChild(wrapper);
			pageObserver.observe(wrapper);
			await page.render({ canvasContext: ctx, viewport }).promise;
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

	$effect(() => {
		if (path) loadPdf();
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
