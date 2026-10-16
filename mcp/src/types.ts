// Copied subset of ../../src/lib/types.ts — keep in sync with the app.
// These mirror what is actually persisted on disk (StoredPaper/StoredThread
// are the meta.json shapes; see ../../src/lib/tauri/fs.ts).

export type ReadingStatus = 'unread' | 'reading' | 'read' | 'archived';
export type ThreadStatus = 'active' | 'paused' | 'concluded' | 'archived';

/** threads/<slug>/meta.json */
export interface StoredThread {
	id: string;
	title: string;
	question: string;
	status: ThreadStatus;
	createdAt: string;
	updatedAt: string;
	parentId?: string | null;
}

/** threads/<slug>/papers/<arxivId>/meta.json (Paper minus threadId & pdfPath) */
export interface StoredPaper {
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
	arxivUrl: string;
	addedAt: string;
	links: string[];
	sourceUrl?: string;
	orderInThread?: number;
	contextNote?: string;
}

export interface PaperHighlightArea {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** threads/<slug>/papers/<arxivId>/highlights.json entries */
export interface PaperHighlight {
	id: string;
	text: string;
	createdAt: string;
	areas: PaperHighlightArea[];
}

/** One line of a chats/<id>.jsonl file */
export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	createdAt: string;
}

export interface ChatSummary {
	id: string;
	title: string;
	updatedAt: string;
	messageCount: number;
}

export interface SummaryFrontmatter {
	topics: string[];
	domains: string[];
	keywords: string[];
}

/** threads/<slug>/notes/<id>.md — frontmatter (title/createdAt/updatedAt) + markdown body */
export interface ThreadNote {
	id: string;
	title: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}
