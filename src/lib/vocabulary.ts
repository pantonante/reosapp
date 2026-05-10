import type { SummaryMeta } from './types';

export interface VocabEntry {
	tag: string;
	count: number;
}

export interface VocabSnapshot {
	topics: VocabEntry[];
	domains: VocabEntry[];
	keywords: VocabEntry[];
}

type Field = 'topics' | 'domains' | 'keywords';

function aggregate(metas: SummaryMeta[], field: Field): VocabEntry[] {
	const counts = new Map<string, number>();
	for (const m of metas) {
		for (const tag of m[field]) {
			if (!tag) continue;
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function buildVocabulary(metas: SummaryMeta[]): VocabSnapshot {
	return {
		topics: aggregate(metas, 'topics'),
		domains: aggregate(metas, 'domains'),
		keywords: aggregate(metas, 'keywords')
	};
}

function renderSection(title: string, entries: VocabEntry[]): string {
	const header = `## ${title}`;
	if (entries.length === 0) return `${header}\n\n_No tags yet — coin freely._`;
	const lines = entries.map((e) => `- ${e.tag} (${e.count})`);
	return `${header}\n${lines.join('\n')}`;
}

export function formatVocabularyMarkdown(snap: VocabSnapshot): string {
	const intro = [
		'# Library vocabulary',
		'',
		'Auto-generated from existing paper summaries. When tagging a new paper,',
		'prefer these exact strings if any closely match what you would write.',
		'Counts indicate how many papers currently use each tag. Coin a new tag',
		'only when nothing here genuinely fits.'
	].join('\n');

	return [
		intro,
		'',
		renderSection('topics', snap.topics),
		'',
		renderSection('domains', snap.domains),
		'',
		renderSection('keywords', snap.keywords),
		''
	].join('\n');
}
