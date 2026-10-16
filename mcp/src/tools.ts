// The 9 read-only tools plus 4 write tools (create_thread, add_paper,
// create_note, update_note). List
// tools return compact JSON; get tools return markdown. Descriptions encode the
// cost-first reading order from the app's navigate-thread skill:
// meta -> summary -> notes -> chats -> PDF last.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './config.js';
import {
	attachPdf,
	createNote,
	createThread,
	movePaper,
	MutateInputError,
	updateNote,
	writeNewPaper,
	type NewPaper,
	type NoteWriteResult
} from './mutate.js';
import { NOTE_MEDIA_DIR, noteExcerpt, paperRefs } from './note-format.js';
import { ResolveError, resolvePaper, resolveThread, searchPapers } from './search.js';
import {
	downloadArxivPdf,
	downloadBiorxivPdf,
	downloadPdf,
	fetchArxivMeta,
	fetchBiorxivMeta,
	fetchWebSource,
	localPaperId,
	localTitleFromPath,
	parseSource,
	readLocalPdf,
	type PaperSource
} from './sources.js';
import {
	countChatsIn,
	fileExists,
	INBOX_SLUG,
	listChatsIn,
	listPaperIds,
	listThreadArtifacts,
	listThreadNotes,
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
	scanLibrary,
	threadChatsDir,
	threadNotesDir,
	type LibraryPaper
} from './store.js';
import type { StoredPaper, ThreadNote } from './types.js';

const CHARACTER_LIMIT = 30000;
const MAX_CHAT_MESSAGES = 200;

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false
} as const;

/** Raised by write tools for expected, user-fixable failures. */
class ToolInputError extends Error {}

const APP_SYNC_NOTE =
	'The Re:OS app picks this up automatically the next time its window is focused (or within a few seconds if it is open).';

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
			if (
				err instanceof ConfigError ||
				err instanceof ResolveError ||
				err instanceof ToolInputError ||
				err instanceof MutateInputError
			) {
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
const noteParam = z
	.string()
	.min(1)
	.describe(
		`Note id (e.g. 'n1777830790430') or a title substring. A reference copied from the app reads 'n1777830790430 in thread t1777830790430 ("Title")' — pass the n… id here and the t… slug as thread.`
	);
const paperParam = z
	.string()
	.min(1)
	.describe("Paper arxivId (e.g. '2301.08243', 'local-...', 'web-...') or a title substring");

function truncate(s: string, max: number): string {
	const t = s.trim().replace(/\s+/g, ' ');
	return t.length > max ? t.slice(0, max) + '…' : t;
}

function authorsList(authors: string[], max = 10): string {
	if (!authors.length) return '(unknown)';
	if (authors.length <= max) return authors.join(', ');
	return `${authors.slice(0, max).join(', ')}, … (${authors.length} total)`;
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

Returns markdown: thread meta (full question, parent/child threads), the thread's markdown notes (id, title, excerpt — read them with get_note), the papers in reading order with { arxivId, title, readingStatus, tags, contextNote, hasPdf, hasSummary, hasNotes }, ad-hoc markdown artifacts saved at the thread root, and the number of thread-level chats.`,
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
			const [artifacts, chatCount, notes] = await Promise.all([
				listThreadArtifacts(slug),
				countChatsIn(await threadChatsDir(slug)),
				listThreadNotes(slug)
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
			lines.push('', `## Notes (${notes.length})`, '');
			for (const n of notes) {
				const excerpt = noteExcerpt(n.content, 120);
				lines.push(`- **${n.title}** (\`${n.id}\`, updated ${n.updatedAt.slice(0, 10)})${excerpt ? ` — ${excerpt}` : ''}`);
			}
			if (notes.length) lines.push('', 'Read one in full with get_note.');
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

	server.registerTool(
		'create_thread',
		{
			title: 'Create a Re:OS thread',
			description: `Create a new research thread (a narrative investigation that papers get filed into).

Args:
  - title: short thread title, e.g. 'Linear attention scaling'
  - question (optional): the research question the thread investigates
  - parent (optional): slug or title substring of an existing thread to nest this one under (sub-thread)

Refuses when a thread with the same title already exists (returns its slug instead) — check list_threads first if unsure. Returns markdown with the new thread's slug; pass it as 'thread' to add_paper to file papers into it.`,
			inputSchema: {
				title: z.string().trim().min(1).max(200).describe('Thread title'),
				question: z.string().trim().max(2000).optional().describe('Research question'),
				parent: threadParam.optional().describe('Parent thread (slug or title substring)')
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		safe(async ({ title, question, parent }) => {
			let parentId: string | null = null;
			if (parent) {
				parentId = (await resolveThread(parent)).slug;
				if (parentId === INBOX_SLUG) {
					throw new ToolInputError('The inbox cannot have sub-threads. Omit parent.');
				}
			}
			for (const slug of await listThreadSlugs()) {
				const meta = await readThreadMeta(slug);
				if (meta && slug !== INBOX_SLUG && meta.title.toLowerCase() === title.toLowerCase()) {
					throw new ToolInputError(
						`A thread titled '${meta.title}' already exists (slug ${slug}). ` +
							`Use that slug, or pick a different title.`
					);
				}
			}
			const meta = await createThread({ title, question: question ?? '', parentId });
			return text(
				[
					`Created thread **${meta.title}** (slug \`${meta.id}\`).`,
					'',
					`- **Question**: ${meta.question || '(none)'}`,
					parentId ? `- **Parent thread**: ${parentId}` : null,
					'',
					`Add papers with add_paper (thread: '${meta.id}'). ${APP_SYNC_NOTE}`
				]
					.filter((l) => l !== null)
					.join('\n')
			);
		})
	);

	server.registerTool(
		'add_paper',
		{
			title: 'Add a paper to Re:OS',
			description: `Add a paper to the library: fetches metadata, gets the PDF, and files it into a thread (or the inbox).

Accepted sources:
  - arXiv ID or URL ('2301.08243', 'arxiv.org/abs/2301.08243v2', AlphaXiv links)
  - bioRxiv/medRxiv URL or dated DOI ('10.1101/2024.01.02.573421')
  - any other DOI ('10.1109/TOH.2013.6', 'https://doi.org/…') or http(s) URL (journal page, PubMed Central, direct PDF link, blog post)
  - a local PDF file: absolute path, '~/…', or file:// URL ending in .pdf

For DOIs and other URLs the PDF is found best-effort: a direct PDF link, the page's citation_pdf_url, then open-access copies listed by OpenAlex. Paywalled or bot-protected publishers (IEEE, SAGE, many society journals, PMC's PDF links) often can't be fetched — the paper is then saved as a webpage paper (no PDF) and the response says so. If you can obtain the PDF another way (e.g. ask the user to download it), pass pdf_path or pdf_url. Metadata for DOIs falls back to OpenAlex; pass title/authors/abstract/year when you know them better (always do this for local PDFs, whose title otherwise comes from the filename).

Args:
  - source: ID, DOI, URL, or local PDF path as above
  - thread (optional): slug or title substring of the destination thread; default 'inbox'. Create one first with create_thread if needed.
  - context_note (optional): why this paper belongs in the thread
  - tags (optional): tags to attach
  - title / authors / abstract / year (optional): metadata overrides
  - pdf_path / pdf_url (optional, one of): the paper's PDF, used instead of automatic discovery

Deduplicates: if the paper is already in the library it is not re-added. If it sits in the inbox and a thread is given, it is moved (filed) into that thread; if it belongs to a different thread it is left there. Either way, if it has no PDF yet, the PDF (pdf_path / pdf_url, or a fresh discovery attempt) is attached — so calling add_paper again with the same source and a pdf_path backfills a missing PDF. Returns markdown with the paper's arxivId (its id in every other tool), title, thread, and pdf_path.`,
			inputSchema: {
				source: z
					.string()
					.trim()
					.min(1)
					.describe('arXiv/bioRxiv/medRxiv ID, DOI, URL, or absolute path to a local PDF'),
				thread: threadParam
					.optional()
					.describe("Destination thread (slug or title substring); default 'inbox'"),
				context_note: z.string().trim().max(2000).optional().describe('Why this paper is in the thread'),
				tags: z.array(z.string().trim().min(1)).optional().describe('Tags to attach'),
				title: z.string().trim().min(1).optional().describe('Override the fetched title'),
				authors: z.array(z.string().trim().min(1)).optional().describe('Override the fetched authors'),
				abstract: z.string().trim().optional().describe('Override the fetched abstract'),
				year: z
					.string()
					.regex(/^\d{4}$/)
					.optional()
					.describe('Publication year (YYYY), used when no date is fetched'),
				pdf_path: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe('Absolute (or ~/) path to a local copy of the PDF'),
				pdf_url: z.string().trim().url().optional().describe('Direct URL of the PDF')
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		safe(async (args) => {
			const parsed = parseSource(args.source);
			if (!parsed) {
				throw new ToolInputError(
					`Could not parse '${args.source}' as an arXiv ID, DOI, URL, or local PDF path.`
				);
			}
			if (args.pdf_path && args.pdf_url) {
				throw new ToolInputError('Pass pdf_path or pdf_url, not both.');
			}
			const targetSlug = args.thread ? (await resolveThread(args.thread)).slug : INBOX_SLUG;

			// Explicit PDFs are loaded up front so a bad path/URL fails before anything is written.
			let explicitPdf: Uint8Array | null = null;
			try {
				if (parsed.kind === 'local') explicitPdf = await readLocalPdf(parsed.path);
				else if (args.pdf_path) explicitPdf = await readLocalPdf(args.pdf_path);
				else if (args.pdf_url) explicitPdf = await downloadPdf(args.pdf_url);
			} catch (err) {
				throw new ToolInputError(err instanceof Error ? err.message : String(err));
			}
			const arxivId = parsed.kind === 'local' ? localPaperId(explicitPdf!) : parsed.arxivId;

			const library = await scanLibrary();
			const existing = library.find(
				(p) =>
					p.meta.arxivId === arxivId ||
					(parsed.kind === 'web' && p.meta.sourceUrl === parsed.normalizedUrl)
			);
			if (existing) {
				// No thread given means "add if missing", not "file into the inbox".
				const moveTo = args.thread ? targetSlug : null;
				return text(await updateExisting(existing, moveTo, parsed, explicitPdf, args.context_note));
			}

			let paper: NewPaper;
			let pdf = explicitPdf;
			let pdfFailures: string[] = [];
			if (parsed.kind === 'arxiv') {
				const meta = await fetchArxivMeta(parsed.arxivId);
				pdf ??= await downloadArxivPdf(parsed.arxivId);
				paper = {
					...meta,
					arxivId,
					tags: [],
					arxivUrl: `https://arxiv.org/abs/${parsed.arxivId}`
				};
			} else if (parsed.kind === 'biorxiv') {
				const { contentUrl, ...meta } = await fetchBiorxivMeta(parsed.ref);
				pdf ??= await downloadBiorxivPdf(contentUrl);
				paper = { ...meta, arxivId, tags: [], arxivUrl: contentUrl };
			} else if (parsed.kind === 'web') {
				const found = await fetchWebSource(parsed.normalizedUrl, { findPdf: !pdf });
				pdf ??= found.pdf;
				pdfFailures = found.failures;
				paper = {
					arxivId,
					title: found.meta.title || new URL(parsed.normalizedUrl).hostname,
					authors: found.meta.authors ?? [],
					abstract: found.meta.abstract ?? '',
					publishedDate: found.meta.publishedDate ?? '',
					categories: [],
					tags: [],
					arxivUrl: '',
					sourceUrl: parsed.normalizedUrl
				};
			} else {
				paper = {
					arxivId,
					title: localTitleFromPath(parsed.path),
					authors: [],
					abstract: '',
					publishedDate: '',
					categories: [],
					tags: [],
					arxivUrl: ''
				};
			}
			if (args.title) paper.title = args.title;
			if (args.authors?.length) paper.authors = args.authors;
			if (args.abstract !== undefined) paper.abstract = args.abstract;
			if (args.year && !paper.publishedDate.startsWith(args.year)) {
				paper.publishedDate = `${args.year}-01-01`;
			}
			if (args.tags?.length) paper.tags = [...new Set(args.tags)];
			if (args.context_note) paper.contextNote = args.context_note;

			const { meta, pdfPath } = await writeNewPaper(targetSlug, paper, pdf);
			const lines = [
				`Added **${meta.title}** (${meta.arxivId}) to ${targetSlug === INBOX_SLUG ? 'the inbox' : `thread '${targetSlug}'`}.`,
				'',
				`- **Authors**: ${authorsList(meta.authors)}`,
				`- **Published**: ${meta.publishedDate || '(unknown)'}`
			];
			if (meta.tags.length) lines.push(`- **Tags**: ${meta.tags.join(', ')}`);
			if (pdfPath) lines.push(`- **pdf_path**: ${pdfPath}`);
			if (meta.sourceUrl) lines.push(`- **Source URL**: ${meta.sourceUrl}`);
			if (!pdfPath) lines.push('', ...noPdfNotice(pdfFailures, true));
			lines.push('', APP_SYNC_NOTE);
			return text(lines.join('\n'));
		})
	);

	server.registerTool(
		'get_note',
		{
			title: 'Get a Re:OS thread note',
			description: `Read one of a thread's markdown notes in full. Thread notes are free-form research notes that live in the thread itself (separate from papers and from per-paper notes.md); get_thread lists them.

Args:
  - thread: slug or title substring
  - note: note id (from get_thread) or a title substring

Returns markdown: the note's title, id, dates, absolute file path, and full body. Embedded media is referenced relative to the notes folder (e.g. media/plot.png); the media folder's absolute path is included so you can open those files.`,
			inputSchema: { thread: threadParam, note: noteParam },
			annotations: READ_ONLY
		},
		safe(async ({ thread, note }) => {
			const { slug } = await resolveThread(thread);
			const n = await resolveNote(slug, note);
			const dir = await threadNotesDir(slug);
			return text(
				[
					`# ${n.title}`,
					'',
					`- **Note id**: ${n.id} · **Thread**: ${slug}`,
					`- **Created**: ${n.createdAt} · **Updated**: ${n.updatedAt}`,
					`- **Path**: ${join(dir, `${n.id}.md`)}`,
					`- **Media folder**: ${join(dir, NOTE_MEDIA_DIR)}`,
					'',
					'---',
					'',
					n.content.trim() || '(empty)'
				].join('\n')
			);
		})
	);

	const NOTE_CONTENT_HELP = `Content is markdown (GFM tables, task lists, and $…$ / $$…$$ math render in the app). To embed an image or video, reference a local file by absolute path — ![caption](/abs/path/plot.png), ![](~/clip.mp4), or <img src="/abs/path.png" width="400"> — and it is copied into the thread's notes/media/ folder and the link rewritten (images: png, jpg, gif, webp, svg, avif; video: mp4, mov, webm, m4v, ogv; videos use the same ![…](…) syntax and render as a player). http(s) image URLs are left as-is.

Citing papers — REQUIRED: every paper the note uses, quotes, or mentions must be linked inline with [text](paper:<arxivId>), e.g. 'builds on [Diffusion Policy](paper:2303.04137)'. The app renders these as links that open the paper. Never cite a paper as plain text or a bare URL. Before writing, find each paper's arxivId with search_papers (or get_thread); if a paper is not in the library, add it FIRST with add_paper (into this thread unless it clearly belongs elsewhere) and link it with the arxivId add_paper returns — non-arXiv sources get ids like 'doi-…' or 'web-…', so always use the returned id. The response lists any paper: links that don't match a library paper; fix those before finishing.`;

	server.registerTool(
		'create_note',
		{
			title: 'Create a Re:OS thread note',
			description: `Create a markdown note inside a thread. Notes live in their own section of the thread (not among the papers) and the user can read and edit them in the app — use them for syntheses, comparisons, open questions, experiment logs, or anything worth keeping alongside the thread's papers.

${NOTE_CONTENT_HELP}

Args:
  - thread: slug or title substring (sub-threads work the same way)
  - title: short note title
  - content: markdown body (don't repeat the title as a heading)

Returns markdown with the new note's id (use it with update_note / get_note) and file path.`,
			inputSchema: {
				thread: threadParam,
				title: z.string().trim().min(1).max(200).describe('Note title'),
				content: z.string().describe('Markdown body')
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		safe(async ({ thread, title, content }) => {
			const { slug } = await resolveThread(thread);
			const res = await createNote(slug, { title, content });
			return text(await noteWriteSummary(`Created note **${res.note.title}**`, slug, res));
		})
	);

	server.registerTool(
		'update_note',
		{
			title: 'Update a Re:OS thread note',
			description: `Edit an existing thread note: rename it, replace its body, or append to it. The user may have edited the note in the app — when replacing, read it with get_note first and preserve their changes.

${NOTE_CONTENT_HELP}

Args:
  - thread: slug or title substring
  - note: note id or title substring
  - title (optional): new title
  - content (optional): markdown to write
  - mode (default 'replace'): 'replace' overwrites the body with content; 'append' adds content at the end (separated by a blank line)

Returns markdown with the note's id, path, and any media that was imported.`,
			inputSchema: {
				thread: threadParam,
				note: noteParam,
				title: z.string().trim().min(1).max(200).optional().describe('New title'),
				content: z.string().optional().describe('Markdown body (or the part to append)'),
				mode: z.enum(['replace', 'append']).default('replace')
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		safe(async ({ thread, note, title, content, mode }) => {
			if (title === undefined && content === undefined) {
				throw new ToolInputError('Nothing to update: pass title and/or content.');
			}
			const { slug } = await resolveThread(thread);
			const current = await resolveNote(slug, note);
			const res = await updateNote(slug, current, { title, content, mode });
			const verb = content === undefined ? 'Renamed' : mode === 'append' ? 'Appended to' : 'Updated';
			return text(await noteWriteSummary(`${verb} note **${res.note.title}**`, slug, res));
		})
	);
}

function noPdfNotice(failures: string[], isNew: boolean): string[] {
	return [
		isNew
			? '**No PDF found** — saved as a webpage paper (the app shows the source URL instead of a PDF).'
			: '**Still no PDF** — automatic discovery found nothing new.',
		...(failures.length ? ['Tried:', ...failures.map((f) => `  - ${f}`)] : []),
		'To attach the PDF later, call add_paper again with the same source plus pdf_path (a local copy, e.g. one the user downloaded) or pdf_url.'
	];
}

/**
 * add_paper on a paper that's already in the library: file it out of the
 * inbox if asked, and backfill a missing PDF.
 */
async function updateExisting(
	existing: LibraryPaper,
	targetSlug: string | null,
	parsed: PaperSource,
	explicitPdf: Uint8Array | null,
	contextNote: string | undefined
): Promise<string> {
	const { meta } = existing;
	let slug = existing.threadSlug;
	const lines: string[] = [];
	if (targetSlug === null || slug === targetSlug) {
		lines.push(`**${meta.title}** (${meta.arxivId}) is already in ${where(slug)}.`);
	} else if (slug === INBOX_SLUG) {
		slug = targetSlug;
		await movePaper(INBOX_SLUG, slug, meta.arxivId, contextNote);
		lines.push(`Moved **${meta.title}** (${meta.arxivId}) from the inbox into thread '${slug}'.`);
	} else {
		lines.push(
			`**${meta.title}** (${meta.arxivId}) is already in the library, in thread '${slug}'. ` +
				`A paper belongs to one thread at a time, so it was left there (the user can move it in the app).`
		);
	}

	const pdfPath = await paperPdfPath(slug, meta.arxivId);
	if (await fileExists(pdfPath)) {
		lines.push(`- **pdf_path**: ${pdfPath}`);
		if (explicitPdf) lines.push('It already has a PDF; the one you passed was not used.');
		if (slug !== existing.threadSlug) lines.push('', APP_SYNC_NOTE);
		return lines.join('\n');
	}

	let pdf = explicitPdf;
	let failures: string[] = [];
	if (!pdf) {
		try {
			if (parsed.kind === 'arxiv') pdf = await downloadArxivPdf(parsed.arxivId);
			else if (parsed.kind === 'biorxiv') pdf = await downloadBiorxivPdf(meta.arxivUrl);
			else if (parsed.kind === 'web') {
				const found = await fetchWebSource(parsed.normalizedUrl, { findPdf: true });
				pdf = found.pdf;
				failures = found.failures;
			}
		} catch (err) {
			failures.push(err instanceof Error ? err.message : String(err));
		}
	}
	if (pdf) {
		lines.push(`Attached a PDF: ${await attachPdf(slug, meta.arxivId, pdf)}`);
	} else {
		lines.push('', ...noPdfNotice(failures, false));
	}
	if (pdf || slug !== existing.threadSlug) lines.push('', APP_SYNC_NOTE);
	return lines.join('\n');
}

/** Exact id first, then a unique case-insensitive title substring. */
async function resolveNote(threadSlug: string, query: string): Promise<ThreadNote> {
	const notes = await listThreadNotes(threadSlug);
	const byId = notes.find((n) => n.id === query);
	if (byId) return byId;
	const q = query.toLowerCase();
	const exact = notes.filter((n) => n.title.toLowerCase() === q);
	const matches = exact.length ? exact : notes.filter((n) => n.title.toLowerCase().includes(q));
	if (matches.length === 1) return matches[0];
	if (!matches.length) {
		throw new ToolInputError(
			notes.length
				? `No note matching '${query}' in thread '${threadSlug}'. Notes: ${notes.map((n) => `${n.title} (${n.id})`).join('; ')}`
				: `Thread '${threadSlug}' has no notes yet — create one with create_note.`
		);
	}
	throw new ToolInputError(
		`'${query}' matches ${matches.length} notes: ${matches.map((n) => `${n.title} (${n.id})`).join('; ')}. Pass the id.`
	);
}

async function noteWriteSummary(
	headline: string,
	slug: string,
	res: NoteWriteResult
): Promise<string> {
	const lines = [
		`${headline} in thread '${slug}'.`,
		'',
		`- **Note id**: ${res.note.id}`,
		`- **Path**: ${res.path}`
	];
	if (res.imported.length) lines.push(`- **Media imported**: ${res.imported.join(', ')}`);

	// Paper links must resolve to a library paper (by arxivId or internal id).
	const refs = [...paperRefs(res.note.content)];
	if (refs.length) {
		const known = new Set((await scanLibrary()).flatMap((p) => [p.meta.arxivId, p.meta.id]));
		const missing = refs.filter((r) => !known.has(r));
		lines.push(`- **Papers linked**: ${refs.length - missing.length} of ${refs.length} resolve`);
		if (missing.length) {
			lines.push(
				'',
				`**Unresolved paper links**: ${missing.map((m) => `paper:${m}`).join(', ')} — these don't match any paper in the library. ` +
					`Add each with add_paper; if add_paper returns a different arxivId, update the note's link to it (update_note).`
			);
		}
	} else {
		lines.push(
			'',
			'No papers are linked. If this note draws on any paper, link it with [text](paper:<arxivId>) (add_paper first if it is not in the library).'
		);
	}
	lines.push('', APP_SYNC_NOTE);
	return lines.join('\n');
}

function where(slug: string): string {
	return slug === INBOX_SLUG ? 'the inbox' : `thread '${slug}'`;
}
