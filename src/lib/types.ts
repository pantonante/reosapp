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
}

export interface Note {
	id: string;
	paperId: string;
	content: string;
	createdAt: string;
}

/**
 * One chat per paper, one chat per thread. Messages live in chat.jsonl on disk,
 * not in the SQLite cache.
 */
export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	createdAt: string;
}

export interface ReosConfig {
	papersDir: string | null;
}
