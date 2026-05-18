// Renders a paper/thread title with inline KaTeX math.
//
// Splits the title on `$…$` segments and runs each through KaTeX; the
// non-math portions are HTML-escaped so titles from external metadata
// (Arxiv API, AI extraction, user input) can't inject markup. The result is
// safe to drop into a `{@html …}` slot.

import katex from 'katex';

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// `$…$` with at least one non-`$`/non-newline character inside. The lookbehind
// excludes escaped dollar signs (`\$`). Display math (`$$…$$`) and `\(…\)`
// delimiters are out of scope — titles only ever carry short inline math.
const INLINE_MATH = /(?<!\\)\$([^$\n]+?)\$/g;

export function renderTitleHtml(text: string): string {
	if (!text) return '';
	let out = '';
	let cursor = 0;
	for (const match of text.matchAll(INLINE_MATH)) {
		const start = match.index ?? 0;
		out += escapeHtml(text.slice(cursor, start));
		try {
			out += katex.renderToString(match[1], {
				throwOnError: false,
				output: 'html',
				displayMode: false
			});
		} catch {
			out += escapeHtml(match[0]);
		}
		cursor = start + match[0].length;
	}
	out += escapeHtml(text.slice(cursor));
	return out;
}
