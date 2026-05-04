import type { SummaryMeta } from './types';

export interface ParsedSummary {
	meta: Pick<SummaryMeta, 'topics' | 'domains' | 'keywords'> | null;
	body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Extracts YAML frontmatter from the top of a `summary.md` body. Hand-rolled
 * because the schema is fixed (three array fields) and we don't want to ship a
 * full YAML dependency. Tolerates either inline-array `[a, b]` or block-list
 * style. Unknown keys are ignored.
 *
 * Returns `meta: null` if no frontmatter block is present, in which case the
 * full input is returned as `body`.
 */
export function parseSummaryFrontmatter(input: string): ParsedSummary {
	const match = input.match(FRONTMATTER_RE);
	if (!match) {
		return { meta: null, body: input };
	}
	const yaml = match[1];
	const body = input.slice(match[0].length);

	const fields: { topics: string[]; domains: string[]; keywords: string[] } = {
		topics: [],
		domains: [],
		keywords: []
	};

	const lines = yaml.split(/\r?\n/);
	let current: keyof typeof fields | null = null;
	let buffer = '';

	function flushInline() {
		if (current && buffer) {
			fields[current] = parseArray(buffer);
		}
		current = null;
		buffer = '';
	}

	for (const rawLine of lines) {
		const line = rawLine.replace(/\s+$/, '');
		if (!line.trim()) continue;

		const blockItem = line.match(/^\s*-\s*(.+)$/);
		if (blockItem && current) {
			fields[current].push(...parseArray(blockItem[1]));
			continue;
		}

		const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (kv) {
			flushInline();
			const key = kv[1].toLowerCase();
			const value = kv[2];
			if (key === 'topics' || key === 'domains' || key === 'keywords') {
				current = key;
				if (value.trim()) {
					buffer = value;
					flushInline();
				}
			} else {
				current = null;
			}
		}
	}
	flushInline();

	const meta = {
		topics: normalize(fields.topics),
		domains: normalize(fields.domains),
		keywords: normalize(fields.keywords)
	};

	return { meta, body };
}

function parseArray(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		return splitItems(trimmed.slice(1, -1));
	}
	return splitItems(trimmed);
}

function splitItems(value: string): string[] {
	return value
		.split(',')
		.map((s) => stripQuotes(s).trim())
		.filter(Boolean);
}

function stripQuotes(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function normalize(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of items) {
		const tag = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '');
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
	}
	return out;
}

export function isMetaEmpty(
	meta: Pick<SummaryMeta, 'topics' | 'domains' | 'keywords'> | null
): boolean {
	return !meta || (meta.topics.length === 0 && meta.domains.length === 0 && meta.keywords.length === 0);
}
