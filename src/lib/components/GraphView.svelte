<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import cytoscape from 'cytoscape';
	import type { Core, EdgeSingular, NodeSingular } from 'cytoscape';
	// @ts-expect-error - no types shipped with this layout package
	import coseBilkent from 'cytoscape-cose-bilkent';
	import { goto } from '$app/navigation';
	import { Button, Input } from '$lib/components/ui';
	import { ui } from '$lib/stores.svelte';
	import { Maximize2, Search } from 'lucide-svelte';
	import { buildGraph, categoricalColor, type GraphNode, type GraphEdge } from '$lib/graph/build';
	import type { Paper, SummaryMeta } from '$lib/types';

	type ColorMode = 'domain' | 'topic';

	let registered = false;
	if (!registered) {
		try {
			cytoscape.use(coseBilkent);
		} catch {
			// already registered
		}
		registered = true;
	}

	let {
		papers,
		summaryMetaItems
	}: { papers: Paper[]; summaryMetaItems: SummaryMeta[] } = $props();

	let container: HTMLDivElement | null = $state(null);
	let cy: Core | null = null;

	let threshold = $state(2);
	let colorMode = $state<ColorMode>('domain');
	let search = $state('');
	let domainFilter = $state<string>('all');
	let topicFilter = $state<string>('all');

	// Floating tooltip state (positioned over the canvas).
	let tooltip = $state<{
		visible: boolean;
		x: number;
		y: number;
		title: string;
		body: string;
	}>({ visible: false, x: 0, y: 0, title: '', body: '' });

	const metaByPaperId = $derived(new Map(summaryMetaItems.map((m) => [m.paperId, m])));

	const graph = $derived(buildGraph(papers, metaByPaperId, { threshold }));

	const allDomains = $derived.by(() => {
		const s = new Set<string>();
		for (const n of graph.nodes) for (const d of n.domains) s.add(d);
		return Array.from(s).sort();
	});
	const allTopics = $derived.by(() => {
		const s = new Set<string>();
		for (const n of graph.nodes) for (const t of n.topics) s.add(t);
		return Array.from(s).sort();
	});

	const filteredNodeIds = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const out = new Set<string>();
		for (const n of graph.nodes) {
			if (domainFilter !== 'all' && !n.domains.includes(domainFilter)) continue;
			if (topicFilter !== 'all' && !n.topics.includes(topicFilter)) continue;
			if (q) {
				const hay = [
					n.label,
					n.authors.join(' '),
					n.topics.join(' '),
					n.domains.join(' '),
					n.keywords.join(' ')
				]
					.join(' ')
					.toLowerCase();
				if (!hay.includes(q)) continue;
			}
			out.add(n.id);
		}
		return out;
	});

	// Nodes shown in the legend swatch (domain or topic, depending on colorMode).
	const legend = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const n of graph.nodes) {
			const key = colorMode === 'domain' ? n.primaryDomain : n.primaryTopic;
			if (!key) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([key, count]) => ({ key, count, color: categoricalColor(key) }));
	});

	function nodeColor(n: GraphNode): string {
		const key = colorMode === 'domain' ? n.primaryDomain : n.primaryTopic;
		return categoricalColor(key);
	}

	function nodeSize(n: GraphNode): number {
		const base = 22;
		const ratingBonus = n.rating ? n.rating * 4 : 0;
		return base + ratingBonus;
	}

	function buildElements(g: { nodes: GraphNode[]; edges: GraphEdge[] }) {
		return [
			...g.nodes.map((n) => ({
				group: 'nodes' as const,
				data: {
					id: n.id,
					label: truncateLabel(n.label),
					fullLabel: n.label,
					color: nodeColor(n),
					size: nodeSize(n),
					authors: n.authors,
					topics: n.topics,
					domains: n.domains,
					keywords: n.keywords,
					rating: n.rating
				}
			})),
			...g.edges.map((e) => ({
				group: 'edges' as const,
				data: {
					id: e.id,
					source: e.source,
					target: e.target,
					weight: e.weight,
					thickness: 1 + Math.min(e.weight, 8) * 0.6,
					sharedTopics: e.sharedTopics,
					sharedDomains: e.sharedDomains,
					sharedKeywords: e.sharedKeywords
				}
			}))
		];
	}

	function truncateLabel(s: string): string {
		const colonIdx = s.indexOf(':');
		const base = colonIdx > 0 ? s.slice(0, colonIdx) : s;
		if (base.length <= 28) return base;
		return base.slice(0, 26) + '…';
	}

	function initCy() {
		if (!container || cy) return;
		cy = cytoscape({
			container,
			elements: buildElements(graph),
			wheelSensitivity: 0.2,
			style: [
				{
					selector: 'node',
					style: {
						'background-color': 'data(color)',
						label: 'data(label)',
						width: 'data(size)',
						height: 'data(size)',
						'font-size': 9,
						'font-family': 'Inter, system-ui, sans-serif',
						color: '#cbd5e1',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 4,
						'text-wrap': 'ellipsis',
						'text-max-width': '140px',
						'min-zoomed-font-size': 7,
						'text-outline-color': 'rgba(0,0,0,0.75)',
						'text-outline-width': 2,
						'border-width': 1,
						'border-color': 'rgba(255,255,255,0.15)'
					}
				},
				{
					selector: 'node.dim',
					style: { opacity: 0.18 }
				},
				{
					selector: 'node.match',
					style: { 'border-color': '#fbbf24', 'border-width': 2 }
				},
				{
					selector: 'edge',
					style: {
						width: 'data(thickness)',
						'line-color': 'rgba(148, 163, 184, 0.35)',
						'curve-style': 'straight',
						opacity: 0.7
					}
				},
				{
					selector: 'edge.dim',
					style: { opacity: 0.05 }
				},
				{
					selector: 'edge.highlight',
					style: { 'line-color': 'rgba(251, 191, 36, 0.85)', opacity: 1 }
				}
			],
			layout: {
				name: 'cose-bilkent',
				// @ts-expect-error - layout-specific options not in base type
				animate: 'end',
				animationDuration: 600,
				idealEdgeLength: 140,
				nodeRepulsion: 18000,
				edgeElasticity: 0.45,
				gravity: 0.25,
				numIter: 2500,
				tile: true,
				randomize: true
			}
		});

		cy.on('tap', 'node', (evt) => {
			const id = evt.target.id();
			ui.openPaper(id);
			goto(`/paper/${id}`);
		});

		cy.on('mouseover', 'node', (evt) => {
			const n = evt.target as NodeSingular;
			const data = n.data();
			const lines: string[] = [];
			if (data.authors?.length) {
				const authors = (data.authors as string[]).slice(0, 3).join(', ');
				const more = (data.authors as string[]).length > 3 ? ' et al.' : '';
				lines.push(authors + more);
			}
			if (data.topics?.length) lines.push(`Topics: ${(data.topics as string[]).join(', ')}`);
			if (data.domains?.length) lines.push(`Domains: ${(data.domains as string[]).join(', ')}`);
			if (data.keywords?.length) lines.push(`Keywords: ${(data.keywords as string[]).join(', ')}`);
			showTooltipForNode(n, data.fullLabel as string, lines.join('\n'));
		});
		cy.on('mouseout', 'node', () => hideTooltip());

		cy.on('mouseover', 'edge', (evt) => {
			const e = evt.target as EdgeSingular;
			const data = e.data();
			const lines: string[] = [];
			if (data.sharedTopics?.length)
				lines.push(`Shared topics: ${(data.sharedTopics as string[]).join(', ')}`);
			if (data.sharedDomains?.length)
				lines.push(`Shared domains: ${(data.sharedDomains as string[]).join(', ')}`);
			if (data.sharedKeywords?.length)
				lines.push(`Shared keywords: ${(data.sharedKeywords as string[]).join(', ')}`);
			showTooltipForEdge(e, `Connection · weight ${data.weight}`, lines.join('\n'));
			e.addClass('highlight');
		});
		cy.on('mouseout', 'edge', (evt) => {
			(evt.target as EdgeSingular).removeClass('highlight');
			hideTooltip();
		});
	}

	function showTooltipForNode(n: NodeSingular, title: string, body: string) {
		const r = n.renderedBoundingBox();
		tooltip = {
			visible: true,
			x: (r.x1 + r.x2) / 2,
			y: r.y1 - 6,
			title,
			body
		};
	}
	function showTooltipForEdge(e: EdgeSingular, title: string, body: string) {
		const mid = e.midpoint();
		const pan = cy?.pan();
		const zoom = cy?.zoom() ?? 1;
		const x = (pan?.x ?? 0) + mid.x * zoom;
		const y = (pan?.y ?? 0) + mid.y * zoom;
		tooltip = { visible: true, x, y, title, body };
	}
	function hideTooltip() {
		tooltip = { ...tooltip, visible: false };
	}

	function syncElements() {
		if (!cy) return;
		cy.elements().remove();
		cy.add(buildElements(graph));
		cy.layout({
			name: 'cose-bilkent',
			// @ts-expect-error - layout-specific options not in base type
			animate: 'end',
			animationDuration: 500,
			idealEdgeLength: 90,
			nodeRepulsion: 8000,
			gravity: 0.25,
			numIter: 2500,
			tile: true,
			randomize: false
		}).run();
	}

	function applyHighlight() {
		if (!cy) return;
		const allNodes = cy.nodes();
		const allEdges = cy.edges();
		const noFilter =
			search.trim() === '' && domainFilter === 'all' && topicFilter === 'all';
		if (noFilter) {
			allNodes.removeClass('dim match');
			allEdges.removeClass('dim');
			return;
		}
		allNodes.forEach((n) => {
			if (filteredNodeIds.has(n.id())) {
				n.removeClass('dim');
				n.addClass('match');
			} else {
				n.addClass('dim');
				n.removeClass('match');
			}
		});
		allEdges.forEach((e) => {
			if (filteredNodeIds.has(e.source().id()) && filteredNodeIds.has(e.target().id())) {
				e.removeClass('dim');
			} else {
				e.addClass('dim');
			}
		});
	}

	function applyColors() {
		if (!cy) return;
		cy.nodes().forEach((n) => {
			const id = n.id();
			const node = graph.nodes.find((g) => g.id === id);
			if (node) n.data('color', nodeColor(node));
		});
	}

	function fit() {
		cy?.fit(undefined, 40);
	}

	onMount(() => {
		initCy();
	});

	onDestroy(() => {
		cy?.destroy();
		cy = null;
	});

	// Rebuild elements when papers/meta/threshold change.
	$effect(() => {
		void graph;
		if (cy) syncElements();
	});

	// Recolor when colorMode changes (without rerunning layout).
	$effect(() => {
		void colorMode;
		applyColors();
	});

	// Apply filter highlighting when search/filters change.
	$effect(() => {
		void search;
		void domainFilter;
		void topicFilter;
		applyHighlight();
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
		<div class="relative">
			<Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<Input
				bind:value={search}
				placeholder="Search title, author, keyword…"
				class="h-8 w-64 pl-7 text-xs"
			/>
		</div>

		<select
			class="h-8 rounded-[10px] border border-border/70 bg-muted/60 px-2 text-xs"
			bind:value={domainFilter}
		>
			<option value="all">All domains</option>
			{#each allDomains as d (d)}
				<option value={d}>{d}</option>
			{/each}
		</select>

		<select
			class="h-8 rounded-[10px] border border-border/70 bg-muted/60 px-2 text-xs"
			bind:value={topicFilter}
		>
			<option value="all">All topics</option>
			{#each allTopics as t (t)}
				<option value={t}>{t}</option>
			{/each}
		</select>

		<div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
			<span>color</span>
			<div class="flex rounded-md border border-border/60 p-0.5">
				<button
					class="rounded px-2 py-0.5 text-[11px] transition-colors {colorMode === 'domain'
						? 'bg-secondary text-foreground'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (colorMode = 'domain')}
				>
					domain
				</button>
				<button
					class="rounded px-2 py-0.5 text-[11px] transition-colors {colorMode === 'topic'
						? 'bg-secondary text-foreground'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (colorMode = 'topic')}
				>
					topic
				</button>
			</div>
		</div>

		<div class="flex items-center gap-2 text-[11px] text-muted-foreground">
			<span>edges ≥</span>
			<input
				type="range"
				min="1"
				max="6"
				step="1"
				bind:value={threshold}
				class="h-1 w-24 cursor-pointer accent-current"
			/>
			<span class="font-mono w-3 text-foreground">{threshold}</span>
		</div>

		<div class="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
			<span class="font-mono">
				{graph.nodes.length} nodes · {graph.edges.length} edges
				{#if graph.hiddenPaperCount > 0}
					· <span class="text-amber-600 dark:text-amber-400">{graph.hiddenPaperCount} hidden</span>
				{/if}
			</span>
			<Button size="sm" variant="ghost" onclick={fit} title="Fit graph to view">
				<Maximize2 class="h-3.5 w-3.5" />
			</Button>
		</div>
	</div>

	<div class="relative min-h-0 flex-1">
		<div bind:this={container} class="h-full w-full"></div>

		{#if graph.nodes.length === 0}
			<div class="absolute inset-0 flex items-center justify-center">
				<div class="max-w-sm text-center text-xs text-muted-foreground">
					{#if papers.length === 0}
						No papers in your library yet.
					{:else}
						No papers have summary metadata yet. Open a paper, run "Generate summary",
						and it will appear here.
					{/if}
				</div>
			</div>
		{/if}

		{#if legend.length > 0}
			<div class="panel pointer-events-none absolute bottom-3 left-3 max-w-xs p-2 backdrop-blur">
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
					{colorMode === 'domain' ? 'Domains' : 'Topics'}
				</div>
				<div class="mt-1 grid grid-cols-1 gap-0.5">
					{#each legend as item (item.key)}
						<div class="flex items-center gap-1.5 text-[11px]">
							<span
								class="inline-block h-2.5 w-2.5 rounded-full"
								style="background:{item.color}"
							></span>
							<span class="truncate">{item.key}</span>
							<span class="ml-auto font-mono text-muted-foreground">{item.count}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if tooltip.visible}
			<div
				class="pointer-events-none absolute z-10 max-w-xs -translate-x-1/2 -translate-y-full rounded-md border border-border/60 bg-popover px-2 py-1.5 text-[11px] shadow-lg"
				style="left:{tooltip.x}px; top:{tooltip.y}px"
			>
				<div class="font-medium leading-tight text-foreground">{tooltip.title}</div>
				{#if tooltip.body}
					<div class="mt-0.5 whitespace-pre-line text-muted-foreground">{tooltip.body}</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
