import Database from '@tauri-apps/plugin-sql';
import type { Paper, SummaryMeta, Thread, ThreadPaper } from '$lib/types';

let _db: Database | null = null;
let _ready: Promise<Database> | null = null;

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS papers (
	id TEXT PRIMARY KEY,
	arxivId TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL,
	authors TEXT NOT NULL,
	abstract TEXT NOT NULL,
	publishedDate TEXT NOT NULL,
	categories TEXT NOT NULL,
	tags TEXT NOT NULL,
	readingStatus TEXT NOT NULL DEFAULT 'unread',
	rating INTEGER,
	pdfPath TEXT NOT NULL,
	arxivUrl TEXT NOT NULL,
	addedAt TEXT NOT NULL,
	links TEXT NOT NULL DEFAULT '[]',
	threadId TEXT,
	orderInThread INTEGER,
	contextNote TEXT
);

CREATE INDEX IF NOT EXISTS idx_papers_thread ON papers(threadId);
CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(readingStatus);

CREATE TABLE IF NOT EXISTS threads (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	question TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active',
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_papers (
	threadId TEXT NOT NULL,
	paperId TEXT NOT NULL,
	contextNote TEXT NOT NULL DEFAULT '',
	"order" INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (threadId, paperId),
	FOREIGN KEY (threadId) REFERENCES threads(id) ON DELETE CASCADE,
	FOREIGN KEY (paperId) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_meta (
	paperId TEXT PRIMARY KEY,
	topics TEXT NOT NULL DEFAULT '[]',
	domains TEXT NOT NULL DEFAULT '[]',
	keywords TEXT NOT NULL DEFAULT '[]',
	updatedAt TEXT NOT NULL,
	FOREIGN KEY (paperId) REFERENCES papers(id) ON DELETE CASCADE
);
`;

export async function getDb(): Promise<Database> {
	if (_db) return _db;
	if (_ready) return _ready;
	_ready = (async () => {
		const db = await Database.load('sqlite:reos.db');
		// Run each statement separately for better-sqlite-driver compatibility.
		for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
			await db.execute(stmt);
		}
		await db.execute('INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)', [
			'schemaVersion',
			String(SCHEMA_VERSION)
		]);
		_db = db;
		return db;
	})();
	return _ready;
}

function rowToPaper(row: Record<string, unknown>): Paper {
	return {
		id: row.id as string,
		arxivId: row.arxivId as string,
		title: row.title as string,
		authors: JSON.parse((row.authors as string) || '[]'),
		abstract: (row.abstract as string) ?? '',
		publishedDate: (row.publishedDate as string) ?? '',
		categories: JSON.parse((row.categories as string) || '[]'),
		tags: JSON.parse((row.tags as string) || '[]'),
		readingStatus: (row.readingStatus as Paper['readingStatus']) ?? 'unread',
		rating: row.rating == null ? null : Number(row.rating),
		pdfPath: (row.pdfPath as string) ?? '',
		arxivUrl: (row.arxivUrl as string) ?? '',
		addedAt: (row.addedAt as string) ?? new Date().toISOString(),
		links: JSON.parse((row.links as string) || '[]'),
		threadId: (row.threadId as string) ?? undefined,
		orderInThread: row.orderInThread == null ? undefined : Number(row.orderInThread),
		contextNote: (row.contextNote as string) ?? undefined
	};
}

function rowToSummaryMeta(row: Record<string, unknown>): SummaryMeta {
	return {
		paperId: row.paperId as string,
		topics: JSON.parse((row.topics as string) || '[]'),
		domains: JSON.parse((row.domains as string) || '[]'),
		keywords: JSON.parse((row.keywords as string) || '[]'),
		updatedAt: (row.updatedAt as string) ?? new Date().toISOString()
	};
}

function rowToThread(row: Record<string, unknown>, papers: ThreadPaper[]): Thread {
	return {
		id: row.id as string,
		title: row.title as string,
		question: (row.question as string) ?? '',
		status: (row.status as Thread['status']) ?? 'active',
		papers,
		createdAt: (row.createdAt as string) ?? new Date().toISOString(),
		updatedAt: (row.updatedAt as string) ?? new Date().toISOString()
	};
}

export const db = {
	async getAllPapers(): Promise<Paper[]> {
		const conn = await getDb();
		const rows = await conn.select<Record<string, unknown>[]>(
			'SELECT * FROM papers ORDER BY addedAt DESC'
		);
		return rows.map(rowToPaper);
	},

	async getPaper(id: string): Promise<Paper | null> {
		const conn = await getDb();
		const rows = await conn.select<Record<string, unknown>[]>(
			'SELECT * FROM papers WHERE id = ? OR arxivId = ?',
			[id, id]
		);
		return rows[0] ? rowToPaper(rows[0]) : null;
	},

	async addPaper(p: Paper): Promise<void> {
		const conn = await getDb();
		await conn.execute(
			`INSERT INTO papers(id, arxivId, title, authors, abstract, publishedDate, categories, tags, readingStatus, rating, pdfPath, arxivUrl, addedAt, links, threadId, orderInThread, contextNote)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				title = excluded.title,
				authors = excluded.authors,
				abstract = excluded.abstract,
				publishedDate = excluded.publishedDate,
				categories = excluded.categories,
				tags = excluded.tags,
				readingStatus = excluded.readingStatus,
				rating = excluded.rating,
				pdfPath = excluded.pdfPath,
				arxivUrl = excluded.arxivUrl,
				links = excluded.links,
				threadId = excluded.threadId,
				orderInThread = excluded.orderInThread,
				contextNote = excluded.contextNote`,
			[
				p.id,
				p.arxivId,
				p.title,
				JSON.stringify(p.authors),
				p.abstract,
				p.publishedDate,
				JSON.stringify(p.categories),
				JSON.stringify(p.tags),
				p.readingStatus,
				p.rating,
				p.pdfPath,
				p.arxivUrl,
				p.addedAt,
				JSON.stringify(p.links ?? []),
				p.threadId ?? null,
				p.orderInThread ?? null,
				p.contextNote ?? null
			]
		);
	},

	async updatePaper(id: string, patch: Partial<Paper>): Promise<void> {
		const current = await this.getPaper(id);
		if (!current) return;
		await this.addPaper({ ...current, ...patch, id });
	},

	async removePaper(id: string): Promise<void> {
		const conn = await getDb();
		await conn.execute('DELETE FROM papers WHERE id = ?', [id]);
	},

	async getAllThreads(): Promise<Thread[]> {
		const conn = await getDb();
		const tRows = await conn.select<Record<string, unknown>[]>(
			'SELECT * FROM threads ORDER BY updatedAt DESC'
		);
		const tpRows = await conn.select<Record<string, unknown>[]>(
			'SELECT threadId, paperId, contextNote, "order" FROM thread_papers ORDER BY threadId, "order"'
		);
		const byThread = new Map<string, ThreadPaper[]>();
		for (const r of tpRows) {
			const tid = r.threadId as string;
			const list = byThread.get(tid) ?? [];
			list.push({
				paperId: r.paperId as string,
				contextNote: (r.contextNote as string) ?? '',
				order: Number(r.order ?? 0)
			});
			byThread.set(tid, list);
		}
		return tRows.map((r) => rowToThread(r, byThread.get(r.id as string) ?? []));
	},

	async getThread(id: string): Promise<Thread | null> {
		const conn = await getDb();
		const tRows = await conn.select<Record<string, unknown>[]>(
			'SELECT * FROM threads WHERE id = ?',
			[id]
		);
		if (!tRows[0]) return null;
		const tpRows = await conn.select<Record<string, unknown>[]>(
			'SELECT paperId, contextNote, "order" FROM thread_papers WHERE threadId = ? ORDER BY "order"',
			[id]
		);
		const papers: ThreadPaper[] = tpRows.map((r) => ({
			paperId: r.paperId as string,
			contextNote: (r.contextNote as string) ?? '',
			order: Number(r.order ?? 0)
		}));
		return rowToThread(tRows[0], papers);
	},

	async addThread(t: Thread): Promise<void> {
		const conn = await getDb();
		await conn.execute(
			`INSERT INTO threads(id, title, question, status, createdAt, updatedAt)
			VALUES(?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				title = excluded.title,
				question = excluded.question,
				status = excluded.status,
				updatedAt = excluded.updatedAt`,
			[t.id, t.title, t.question, t.status, t.createdAt, t.updatedAt]
		);
		await conn.execute('DELETE FROM thread_papers WHERE threadId = ?', [t.id]);
		for (const p of t.papers) {
			await conn.execute(
				'INSERT INTO thread_papers(threadId, paperId, contextNote, "order") VALUES(?, ?, ?, ?)',
				[t.id, p.paperId, p.contextNote, p.order]
			);
		}
	},

	async updateThread(id: string, patch: Partial<Thread>): Promise<void> {
		const current = await this.getThread(id);
		if (!current) return;
		await this.addThread({ ...current, ...patch, id });
	},

	async removeThread(id: string): Promise<void> {
		const conn = await getDb();
		await conn.execute('DELETE FROM threads WHERE id = ?', [id]);
	},

	async wipeAll(): Promise<void> {
		const conn = await getDb();
		await conn.execute('DELETE FROM summary_meta');
		await conn.execute('DELETE FROM thread_papers');
		await conn.execute('DELETE FROM papers');
		await conn.execute('DELETE FROM threads');
	},

	async getAllSummaryMeta(): Promise<SummaryMeta[]> {
		const conn = await getDb();
		const rows = await conn.select<Record<string, unknown>[]>('SELECT * FROM summary_meta');
		return rows.map(rowToSummaryMeta);
	},

	async getSummaryMeta(paperId: string): Promise<SummaryMeta | null> {
		const conn = await getDb();
		const rows = await conn.select<Record<string, unknown>[]>(
			'SELECT * FROM summary_meta WHERE paperId = ?',
			[paperId]
		);
		return rows[0] ? rowToSummaryMeta(rows[0]) : null;
	},

	async setSummaryMeta(meta: SummaryMeta): Promise<void> {
		const conn = await getDb();
		await conn.execute(
			`INSERT INTO summary_meta(paperId, topics, domains, keywords, updatedAt)
			VALUES(?, ?, ?, ?, ?)
			ON CONFLICT(paperId) DO UPDATE SET
				topics = excluded.topics,
				domains = excluded.domains,
				keywords = excluded.keywords,
				updatedAt = excluded.updatedAt`,
			[
				meta.paperId,
				JSON.stringify(meta.topics),
				JSON.stringify(meta.domains),
				JSON.stringify(meta.keywords),
				meta.updatedAt
			]
		);
	},

	async removeSummaryMeta(paperId: string): Promise<void> {
		const conn = await getDb();
		await conn.execute('DELETE FROM summary_meta WHERE paperId = ?', [paperId]);
	},

	async setMeta(key: string, value: string): Promise<void> {
		const conn = await getDb();
		await conn.execute('INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)', [key, value]);
	},

	async getMeta(key: string): Promise<string | null> {
		const conn = await getDb();
		const rows = await conn.select<Record<string, unknown>[]>(
			'SELECT value FROM _meta WHERE key = ?',
			[key]
		);
		return rows[0] ? ((rows[0].value as string) ?? null) : null;
	}
};
