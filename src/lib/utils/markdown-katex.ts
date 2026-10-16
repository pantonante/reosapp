// KaTeX extension for `marked`, shared by every markdown renderer.
//
// marked-katex-extension's display-math tokenizer has no `start` hint, so a
// `$$` block written directly under a line of text (no blank line between)
// is swallowed into the paragraph and shows up as raw TeX. Telling marked
// where a `$$` line begins lets the block interrupt the paragraph, the same
// way a fenced code block does.

import type { MarkedExtension, TokenizerExtension } from 'marked';
import markedKatex from 'marked-katex-extension';

const DISPLAY_MATH_START = /(?:^|\n)\$\$\n/;

export function katexExtension(): MarkedExtension {
	const ext = markedKatex({ throwOnError: false, nonStandard: true });
	const block = ext.extensions?.find(
		(e): e is TokenizerExtension => e.name === 'blockKatex' && 'level' in e
	);
	if (block) {
		block.start = (src: string) => {
			const m = src.match(DISPLAY_MATH_START);
			// Point at the `$$`, not the newline before it.
			return m ? m.index! + m[0].length - 3 : undefined;
		};
	}
	return ext;
}
