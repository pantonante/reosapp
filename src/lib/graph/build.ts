import type { Paper, ReadingStatus, SummaryMeta } from '$lib/types';

export interface GraphNode {
	id: string;
	label: string;
	topics: string[];
	domains: string[];
	keywords: string[];
	primaryTopic: string | null;
	primaryDomain: string | null;
	threadId: string | null;
	readingStatus: ReadingStatus;
	rating: number | null;
	authors: string[];
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	weight: number;
	sharedTopics: string[];
	sharedDomains: string[];
	sharedKeywords: string[];
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	hiddenPaperCount: number;
}

const TOPIC_WEIGHT = 3;
const DOMAIN_WEIGHT = 1;
const KEYWORD_WEIGHT = 1;

/**
 * Builds a graph from papers + their summary metadata.
 *
 * Edge weight = 3 * |shared topics| + |shared domains| + |shared keywords|.
 * Topic dominates because the primary use case is connecting papers that share
 * a technique across application domains (the user's Gaussian-splat example).
 *
 * Papers without summary metadata are omitted entirely; the count is returned
 * so the UI can display "N papers hidden".
 */
export function buildGraph(
	papers: Paper[],
	metaByPaperId: Map<string, SummaryMeta>,
	options: { threshold?: number } = {}
): GraphData {
	const threshold = options.threshold ?? 2;

	const nodes: GraphNode[] = [];
	let hiddenPaperCount = 0;

	for (const p of papers) {
		const meta = metaByPaperId.get(p.id);
		if (!meta || (meta.topics.length === 0 && meta.domains.length === 0 && meta.keywords.length === 0)) {
			hiddenPaperCount++;
			continue;
		}
		nodes.push({
			id: p.id,
			label: p.title,
			topics: meta.topics,
			domains: meta.domains,
			keywords: meta.keywords,
			primaryTopic: meta.topics[0] ?? null,
			primaryDomain: meta.domains[0] ?? null,
			threadId: p.threadId ?? null,
			readingStatus: p.readingStatus,
			rating: p.rating,
			authors: p.authors
		});
	}

	const edges: GraphEdge[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		const aTopics = new Set(a.topics);
		const aDomains = new Set(a.domains);
		const aKeywords = new Set(a.keywords);
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			const sharedTopics = b.topics.filter((t) => aTopics.has(t));
			const sharedDomains = b.domains.filter((d) => aDomains.has(d));
			const sharedKeywords = b.keywords.filter((k) => aKeywords.has(k));
			const weight =
				TOPIC_WEIGHT * sharedTopics.length +
				DOMAIN_WEIGHT * sharedDomains.length +
				KEYWORD_WEIGHT * sharedKeywords.length;
			if (weight >= threshold) {
				edges.push({
					id: `${a.id}__${b.id}`,
					source: a.id,
					target: b.id,
					weight,
					sharedTopics,
					sharedDomains,
					sharedKeywords
				});
			}
		}
	}

	return { nodes, edges, hiddenPaperCount };
}

/** Stable categorical color from a string. Used to color nodes by domain/topic. */
export function categoricalColor(key: string | null | undefined): string {
	if (!key) return '#94a3b8'; // slate-400 fallback for empty
	let h = 0;
	for (let i = 0; i < key.length; i++) {
		h = (h * 31 + key.charCodeAt(i)) >>> 0;
	}
	const hue = h % 360;
	// Use a moderate saturation/lightness so edges remain visible against nodes
	// in both themes; tuned to read well on the app's dark/light backgrounds.
	return `hsl(${hue}, 62%, 58%)`;
}
