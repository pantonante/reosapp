// The 8 read-only tools. List tools return compact JSON; get tools return
// markdown. Descriptions encode the cost-first reading order from the app's
// navigate-thread skill: meta -> summary -> notes -> chats -> PDF last.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './config.js';
import { ResolveError, resolvePaper, resolveThread, searchPapers } from './search.js';
import {
	countChatsIn,
	fileExists,
	listChatsIn,
	listPaperIds,
	listThreadArtifacts,
	listThreadSlugs,
	paperChatsDir,
	paperPdfPath,
	readChatIn,
	readNotes,
	readPaperHighlights,
	readPaperMeta,
	readPaperSummary,
	readTextOrNull,
	readThreadMeta,
	reosMetaDir,
	threadChatsDir
} from './store.js';
import type { StoredPaper } from './types.js';

const CHARACTER_LIMIT = 30000;
const MAX_CHAT_MESSAGES = 200;

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false
} as const;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(s: string): ToolResult {
	if (s.length > CHARACTER_LIMIT) {
		s =
			s.slice(0, CHARACTER_LIMIT) +
			`\n\n[Response truncated at ${CHARACTER_LIMIT} characters — narrow the request ` +
			`(fewer sections, a specific chat, pagination) to see the rest.]`;
	}
	return { content: [{ type: 'text', text: s }] };
}

function errorText(s: string): ToolResult {
	return { content: [{ type: 'text', text: s }], isError: true };
}

/** Wrap a handler so Config/Resolve errors become actionable tool errors. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
	return async (args) => {
		try {
			return await fn(args);
		} catch (err) {
			if (err instanceof ConfigError || err instanceof ResolveError) {
				return errorText(`Error: ${err.message}`);
			}
			return errorText(
				`Error: unexpected failure: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	};
}

const threadParam = z
	.string()
	.min(1)
	.describe("Thread slug (e.g. 't1777830790430', 'inbox') or a title substring");
const paperParam = z
	.string()
	.min(1)
	.describe("Paper arxivId (e.g. '2301.08243', 'local-...', 'web-...') or a title substring");

function truncate(s: string, max: number): string {
	const t = s.trim().replace(/\s+/g, ' ');
	return t.length > max ? t.slice(0, max) + '…' : t;
}

function authorsShort(authors: string[]): string {
	if (!authors.length) return '';
	return authors.length > 1 ? `${authors[0]} et al.` : authors[0];
}

async function paperFlags(threadSlug: string, meta: StoredPaper) {
	const [hasPdf, summary, notes] = await Promise.all([
		fileExists(await paperPdfPath(threadSlug, meta.arxivId)),
		readPaperSummary(threadSlug, meta.arxivId),
		readNotes(threadSlug, meta.arxivId)
	]);
	return { hasPdf, hasSummary: summary !== null, hasNotes: notes.trim().length > 0 };
}

export function registerTools(server: McpServer): void {
	server.registerTool(
		'list_threads',
		{
			title: 'List Re:OS threads',
			description: `List the research threads in the Re:OS library, sorted by last update.

A thread is a narrative research investigation bundling an ordered set of papers, notes, and chats. The special thread 'inbox' holds papers not yet filed into an investigation.

Args:
  - status (optional): filter by 'active' | 'paused' | 'concluded' | 'archived'

Returns JSON rows: { slug, title, status, question (truncated), paperCount, updatedAt, parentId }. Use the slug to address a thread in other tools. Start here, then call get_thread for detail.`,
			inputSchema: {
				status: z
					.enum(['active', 'paused', 'concluded', 'archived'])
					.optional()
					.describe('Only return threads with this status')
			},
			annotations: READ_ONLY
		},
		safe(async ({ status }) => {
			const slugs = await listThreadSlugs();
			const rows = await Promise.all(
				slugs.map(async (slug) => {
					const meta = await readThreadMeta(slug);
					const paperCount = (await listPaperIds(slug)).length;
					return {
						slug,
						title: meta?.title ?? null,
						status: meta?.status ?? null,
						question: truncate(meta?.question ?? '', 120),
						paperCount,
						updatedAt: meta?.updatedAt ?? null,
						parentId: meta?.parentId ?? null
					};
				})
			);
			const filtered = status ? rows.filter((r) => r.status === status) : rows;
			filtered.sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1));
			return text(JSON.stringify({ count: filtered.length, threads: filtered }, null, 2));
		})
	);

	server.registerTool(
		'get_thread',
		{
			title: 'Get a Re:OS thread',
			description: `Get one thread in full: its research question, ordered papers, artifacts, and chat count.

Cost-first reading order for answering questions about a thread: this tool first (metadata), then get_paper_content for the relevant papers (summaries/notes), then list_chats/get_chat for prior discussions, and only read a paper.pdf (path from get_paper) as a last resort.

Args:
  - thread: slug or title substring

Returns markdown: thread meta (full question, parent/child threads), the papers in reading order with { arxivId, title, readingStatus, tags, contextNote, hasPdf, hasSummary, hasNotes }, ad-hoc markdown artifacts saved at the thread root, and the number of thread-level chats.`,
			inputSchema: { thread: threadParam },
			annotations: READ_ONLY
		},
		safe(async ({ thread }) => {
			const { slug, meta } = await resolveThread(thread);
			const ids = await listPaperIds(slug);
			const papers = (
				await Promise.all(
					ids.map(async (arxivId) => {
						const m = await readPaperMeta(slug, arxivId);
						if (!m) return null;
						return { m, flags: await paperFlags(slug, m) };
					})
				)
			).filter((p): p is NonNullable<typeof p> => p !== null);
			papers.sort(
				(a, b) =>
					(a.m.orderInThread ?? Number.MAX_SAFE_INTEGER) -
						(b.m.orderInThread ?? Number.MAX_SAFE_INTEGER) ||
					(a.m.addedAt < b.m.addedAt ? -1 : 1)
			);

			const allSlugs = await listThreadSlugs();
			const children: string[] = [];
			for (const s of allSlugs) {
				if (s === slug) continue;
				const m = await readThreadMeta(s);
				if (m?.parentId === slug) children.push(s);
			}
			const [artifacts, chatCount] = await Promise.all([
				listThreadArtifacts(slug),
				countChatsIn(await threadChatsDir(slug))
			]);

			const lines = [
				`# Thread: ${meta?.title ?? slug} (${slug})`,
				'',
				`- **Status**: ${meta?.status ?? 'unknown'}`,
				`- **Question**: ${meta?.question || '(none)'}`,
				`- **Created**: ${meta?.createdAt ?? '?'} · **Updated**: ${meta?.updatedAt ?? '?'}`
			];
			if (meta?.parentId) lines.push(`- **Parent thread**: ${meta.parentId}`);
			if (children.length) lines.push(`- **Child threads**: ${children.join(', ')}`);
			lines.push(`- **Thread-level chats**: ${chatCount} (see list_chats)`);
			if (artifacts.length)
				lines.push(`- **Artifacts at thread root**: ${artifacts.join(', ')}`);
			lines.push('', `## Papers (${papers.length})`, '');
			for (const { m, flags } of papers) {
				lines.push(`### ${m.title} (${m.arxivId})`);
				const bits = [
					`status: ${m.readingStatus}`,
					m.tags.length ? `tags: ${m.tags.join(', ')}` : null,
					`pdf: ${flags.hasPdf ? 'yes' : 'no'}`,
					`summary: ${flags.hasSummary ? 'yes' : 'no'}`,
					`notes: ${flags.hasNotes ? 'yes' : 'no'}`
				].filter(Boolean);
				lines.push(`- ${bits.join(' · ')}`);
				if (m.contextNote) lines.push(`- context: ${m.contextNote}`);
				lines.push('');
			}
			return text(lines.join('\n'));
		})
	);

	server.registerTool(
		'search_papers',
		{
			title: 'Search Re:OS papers',
			description: `Search (or list) the papers in the Re:OS library. Omit 'query' to list papers, newest first.

Matches case-insensitive substrings of every whitespace-separated query term against title, tags/topics/domains/keywords, categories, abstract, and authors (all terms must match; title matches rank highest). Call get_vocabulary to see the tag values used across the library.

Args:
  - query (optional): search terms, e.g. 'diffusion policy'
  - thread (optional): restrict to one thread (slug or title substring)
  - status (optional): 'unread' | 'reading' | 'read' | 'archived'
  - tags (optional): tags that must all be present (matched against tags + summary frontmatter)
  - limit (default 25, max 100), offset (default 0)

Returns JSON: { total, count, offset, has_more, papers: [{ arxivId, title, authors, year, threadSlug, readingStatus, tags, matched }] }. Follow up with get_paper / get_paper_content using the arxivId.`,
			inputSchema: {
				query: z.string().optional().describe('Search terms; omit to list all papers'),
				thread: threadParam.optional(),
				status: z.enum(['unread', 'reading', 'read', 'archived']).optional(),
				tags: z.array(z.string()).optional().describe('Tags that must all match'),
				limit: z.number().int().min(1).max(100).default(25),
				offset: z.number().int().min(0).default(0)
			},
			annotations: READ_ONLY
		},
		safe(async ({ query, thread, status, tags, limit, offset }) => {
			const threadSlug = thread ? (await resolveThread(thread)).slug : undefined;
			const { total, hits } = await searchPapers({
				query,
				threadSlug,
				status,
				tags,
				limit,
				offset
			});
			const papers = hits.map(({ paper, matched }) => ({
				arxivId: paper.meta.arxivId,
				title: paper.meta.title,
				authors: authorsShort(paper.meta.authors),
				year: paper.meta.publishedDate.slice(0, 4) || null,
				threadSlug: paper.threadSlug,
				readingStatus: paper.meta.readingStatus,
				tags: paper.meta.tags,
				...(matched.length ? { matched } : {})
			}));
			return text(
				JSON.stringify(
					{
						total,
						count: papers.length,
						offset,
						has_more: offset + papers.length < total,
						papers
					},
					null,
					2
				)
			);
		})
	);

	server.registerTool(
		'get_paper',
		{
			title: 'Get a Re:OS paper',
			description: `Get one paper's full metadata and file inventory (which content exists on disk).

To answer questions about the paper, call get_paper_content first — the stored summary, notes, and highlights are far cheaper than the PDF and usually suffice. Only read the returned pdf_path with your file tools when they don't answer the question (specific equations, figures, ablation numbers).

Args:
  - paper: arxivId or title substring
  - thread (optional): narrow the lookup to one thread

Returns markdown: title, authors, abstract, tags/categories, reading status, rating, links, owning thread, summary frontmatter tags, and either the absolute pdf_path or (for webpage-sourced papers with no local PDF) the sourceUrl to fetch instead.`,
			inputSchema: { paper: paperParam, thread: threadParam.optional() },
			annotations: READ_ONLY
		},
		safe(async ({ paper, thread }) => {
			const found = await resolvePaper(paper, thread);
			const { threadSlug, meta } = found;
			const pdfPath = await paperPdfPath(threadSlug, meta.arxivId);
			const [hasPdf, summary, notes, highlights, chatCount] = await Promise.all([
				fileExists(pdfPath),
				readPaperSummary(threadSlug, meta.arxivId),
				readNotes(threadSlug, meta.arxivId),
				readPaperHighlights(threadSlug, meta.arxivId),
				paperChatsDir(threadSlug, meta.arxivId).then(countChatsIn)
			]);

			const lines = [
				`# ${meta.title} (${meta.arxivId})`,
				'',
				`- **Authors**: ${meta.authors.join(', ') || '(unknown)'}`,
				`- **Published**: ${meta.publishedDate || '(unknown)'} · **Added**: ${meta.addedAt}`,
				`- **Thread**: ${threadSlug}`,
				`- **Reading status**: ${meta.readingStatus}` +
					(meta.rating != null ? ` · **Rating**: ${meta.rating}` : ''),
				`- **Tags**: ${meta.tags.join(', ') || '(none)'}`,
				`- **Categories**: ${meta.categories.join(', ') || '(none)'}`
			];
			if (meta.contextNote) lines.push(`- **Context in thread**: ${meta.contextNote}`);
			if (meta.arxivUrl) lines.push(`- **Arxiv URL**: ${meta.arxivUrl}`);
			if (meta.links.length) lines.push(`- **Links**: ${meta.links.join(', ')}`);
			if (summary?.meta) {
				const fm = summary.meta;
				lines.push(
					`- **Summary frontmatter**: topics [${fm.topics.join(', ')}] · ` +
						`domains [${fm.domains.join(', ')}] · keywords [${fm.keywords.join(', ')}]`
				);
			}
			lines.push('', '## Files');
			if (hasPdf) {
				lines.push(
					`- **pdf_path**: ${pdfPath}`,
					'  (read directly with your file tools — but try get_paper_content first, it is far cheaper)'
				);
			} else if (meta.sourceUrl) {
				lines.push(
					`- **No local PDF** — this is a webpage-sourced paper. Fetch the source instead: ${meta.sourceUrl}`
				);
			} else {
				lines.push('- **No local PDF** and no source URL on record.');
			}
			lines.push(
				`- summary.md: ${summary !== null ? 'yes' : 'no'} · notes.md: ${notes.trim() ? 'yes' : 'no'} · highlights: ${highlights.length} · chats: ${chatCount}`,
				'',
				'## Abstract',
				'',
				meta.abstract || '(none)'
			);
			return text(lines.join('\n'));
		})
	);

	server.registerTool(
		'get_paper_content',
		{
			title: 'Get Re:OS paper content',
			description: `Get the stored content for a paper: the generated summary, the user's notes, and PDF highlights. This is the cheap way to learn what a paper says — prefer it over reading the PDF.

Args:
  - paper: arxivId or title substring
  - thread (optional): narrow the lookup
  - sections (optional): subset of ['summary', 'notes', 'highlights']; default all three

Returns markdown with one section per requested part; missing content is reported as '(none)' (many papers have no summary yet — fall back to the abstract via get_paper, or the PDF path).`,
			inputSchema: {
				paper: paperParam,
				thread: threadParam.optional(),
				sections: z
					.array(z.enum(['summary', 'notes', 'highlights']))
					.optional()
					.describe('Which sections to include; default all')
			},
			annotations: READ_ONLY
		},
		safe(async ({ paper, thread, sections }) => {
			const found = await resolvePaper(paper, thread);
			const { threadSlug, meta } = found;
			const wanted = new Set(sections?.length ? sections : ['summary', 'notes', 'highlights']);
			const lines = [`# ${meta.title} (${meta.arxivId})`, ''];

			if (wanted.has('summary')) {
				const summary = await readPaperSummary(threadSlug, meta.arxivId);
				lines.push('## Summary', '', summary ? summary.body.trim() || '(empty)' : '(none)', '');
			}
			if (wanted.has('notes')) {
				const notes = await readNotes(threadSlug, meta.arxivId);
				lines.push('## Notes', '', notes.trim() || '(none)', '');
			}
			if (wanted.has('highlights')) {
				const highlights = await readPaperHighlights(threadSlug, meta.arxivId);
				lines.push('## Highlights', '');
				if (!highlights.length) {
					lines.push('(none)', '');
				} else {
					for (const h of highlights) {
						const page = h.areas[0]?.page;
						lines.push(`> ${h.text.trim().replace(/\s+/g, ' ')}`);
						lines.push(`— page ${page ?? '?'}, ${h.createdAt}`, '');
					}
				}
			}
			return text(lines.join('\n'));
		})
	);

	server.registerTool(
		'list_chats',
		{
			title: 'List Re:OS chats',
			description: `List past chat sessions for a thread (or one paper in it). Useful for "what did we discuss" and continuity questions.

Args:
  - thread: slug or title substring
  - paper (optional): arxivId or title substring — list that paper's chats instead of the thread-level ones

Returns JSON rows { id, title (first message, truncated), messageCount, updatedAt }, newest first. Without 'paper', also includes per-paper chat counts for the thread. Read a specific chat with get_chat.`,
			inputSchema: { thread: threadParam, paper: paperParam.optional() },
			annotations: READ_ONLY
		},
		safe(async ({ thread, paper }) => {
			const { slug } = await resolveThread(thread);
			if (paper) {
				const found = await resolvePaper(paper, slug);
				const chats = await listChatsIn(
					await paperChatsDir(found.threadSlug, found.meta.arxivId)
				);
				return text(
					JSON.stringify(
						{ scope: 'paper', paper: found.meta.arxivId, count: chats.length, chats },
						null,
						2
					)
				);
			}
			const chats = await listChatsIn(await threadChatsDir(slug));
			const paperChats: Record<string, number> = {};
			for (const arxivId of await listPaperIds(slug)) {
				const n = await countChatsIn(await paperChatsDir(slug, arxivId));
				if (n > 0) paperChats[arxivId] = n;
			}
			return text(
				JSON.stringify(
					{ scope: 'thread', thread: slug, count: chats.length, chats, paperChatCounts: paperChats },
					null,
					2
				)
			);
		})
	);

	server.registerTool(
		'get_chat',
		{
			title: 'Get a Re:OS chat',
			description: `Read the messages of one past chat session (thread-level, or a paper's chat when 'paper' is given).

Args:
  - thread: slug or title substring
  - chat_id: id from list_chats (e.g. '2026-08-13T19-29-52-865Z')
  - paper (optional): arxivId or title substring for per-paper chats
  - last_n (optional): only return the most recent N messages

Returns the messages as markdown ('**role** (timestamp):'). Long chats are capped at ${MAX_CHAT_MESSAGES} messages — use last_n to tail.`,
			inputSchema: {
				thread: threadParam,
				chat_id: z.string().min(1).describe('Chat id from list_chats'),
				paper: paperParam.optional(),
				last_n: z.number().int().min(1).optional().describe('Return only the last N messages')
			},
			annotations: READ_ONLY
		},
		safe(async ({ thread, chat_id, paper, last_n }) => {
			const { slug } = await resolveThread(thread);
			let dir: string;
			if (paper) {
				const found = await resolvePaper(paper, slug);
				dir = await paperChatsDir(found.threadSlug, found.meta.arxivId);
			} else {
				dir = await threadChatsDir(slug);
			}
			const all = await readChatIn(dir, chat_id);
			if (!all.length) {
				return errorText(
					`Error: chat '${chat_id}' not found or empty. Use list_chats to see available chat ids.`
				);
			}
			const cap = Math.min(last_n ?? all.length, MAX_CHAT_MESSAGES);
			const msgs = all.slice(-cap);
			const lines: string[] = [];
			if (msgs.length < all.length) {
				lines.push(`(showing last ${msgs.length} of ${all.length} messages)`, '');
			}
			for (const m of msgs) {
				lines.push(`**${m.role}** (${m.createdAt}):`, '', m.content.trim(), '', '---', '');
			}
			return text(lines.join('\n'));
		})
	);

	server.registerTool(
		'get_vocabulary',
		{
			title: 'Get Re:OS tag vocabulary',
			description: `Get the library-wide tag vocabulary (auto-generated from the summary frontmatter of all papers). Use these values for the 'tags' filter of search_papers and to interpret a paper's topics/domains/keywords.

Returns the markdown contents of _reos/vocabulary.md.`,
			inputSchema: {},
			annotations: READ_ONLY
		},
		safe(async () => {
			const path = join(await reosMetaDir(), 'vocabulary.md');
			const content = await readTextOrNull(path);
			return text(content?.trim() || '(no vocabulary yet — no papers have been summarized)');
		})
	);
}
