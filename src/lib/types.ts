export type ReadingStatus = 'unread' | 'reading' | 'read' | 'archived';
export type ThreadStatus = 'active' | 'paused' | 'concluded' | 'archived';

export interface Paper {
	id: string;
	arxivId: string;
	title: string;
	authors: string[];
	abstract: string;
	publishedDate: string;
	categories: string[];
	tags: string[];
	readingStatus: ReadingStatus;
	rating: number | null;
	pdfPath: string;
	arxivUrl: string;
	addedAt: string;
	links: string[];
	/** For webpage-papers: the original source URL (normalized). Absent for Arxiv/PDF papers. */
	sourceUrl?: string;
	/** Slug of the thread that owns this paper on disk. */
	threadId?: string;
	/** Order within the owning thread. */
	orderInThread?: number;
	/** Per-thread note about why this paper is in the thread. */
	contextNote?: string;
}

export interface ThreadPaper {
	paperId: string;
	contextNote: string;
	order: number;
}

export interface Thread {
	id: string;
	title: string;
	question: string;
	status: ThreadStatus;
	papers: ThreadPaper[];
	createdAt: string;
	updatedAt: string;
	/** Parent thread id; null/undefined for root threads. Inbox is always root. */
	parentId?: string | null;
}

export interface Note {
	id: string;
	paperId: string;
	content: string;
	createdAt: string;
}

/** A page-relative rectangle used to redraw a PDF highlight at any zoom level. */
export interface PaperHighlightArea {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A single text selection, which may span multiple lines or PDF pages. */
export interface PaperHighlight {
	id: string;
	text: string;
	createdAt: string;
	areas: PaperHighlightArea[];
}

/**
 * Chat messages live as JSONL on disk, not in the SQLite cache.
 *
 * - Per-paper chats: multiple sessions, one .jsonl file each, under
 *   papers/{arxivId}/chats/{chatId}.jsonl.
 * - Per-thread chat: still a single chat.jsonl per thread.
 */
export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	createdAt: string;
}

/** Lightweight summary of a per-paper chat session, derived from its .jsonl file. */
export interface ChatSummary {
	id: string;
	title: string;
	updatedAt: string;
	messageCount: number;
}

export interface ReosConfig {
	papersDir: string | null;
}

/**
 * Structured metadata extracted from the YAML frontmatter at the top of each
 * `summary.md`. Cached in SQLite so the graph view doesn't have to read every
 * file on load. Arrays are normalized to lowercase, hyphenated, deduped tags.
 */
export interface SummaryMeta {
	paperId: string;
	topics: string[];
	domains: string[];
	keywords: string[];
	updatedAt: string;
}

/**
 * A free-form markdown note that belongs to a thread (not to a paper). Stored
 * as `threads/<slug>/notes/<id>.md` with a small YAML frontmatter block; media
 * it embeds lives next to it in `notes/media/` and is referenced relatively
 * (`![](media/plot.png)`).
 */
export interface ThreadNote {
	id: string;
	title: string;
	/** Markdown body, without the frontmatter. */
	content: string;
	createdAt: string;
	updatedAt: string;
}
