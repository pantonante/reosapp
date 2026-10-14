# reos-mcp-server

MCP (Model Context Protocol) server for the Re:OS paper library. Lets Claude Code / Claude Desktop chat with your papers and research threads from outside the app: browse threads, search papers, read summaries/notes/highlights and past chats, get PDF paths to read directly — and create threads and add papers.

## How it works

- Bootstraps from `~/.reos/config.json` → `papersDir` (the same config the app writes).
- Works on the library **directly on disk** — the filesystem is Re:OS's source of truth. It never touches the app's SQLite cache, so it works whether or not the app is running.
- **Read-only except two additive tools**: `create_thread` and `add_paper` create new folders/files (`threads/<slug>/meta.json`, `papers/<id>/{meta.json,paper.pdf}`), and `add_paper` may move a paper's folder out of the inbox into a thread. Nothing is ever edited in place or deleted. The read path (`store.ts`) only imports `readFile`/`readdir`/`stat`; all writes live in `mutate.ts`.
- **App sync**: every write bumps `_reos/external-changes.json`. The app polls that marker (on focus and every 5s) and pulls new threads/papers into its cache (`src/lib/tauri/external-sync.ts`) — no manual "Rebuild cache" needed.
- No PDF text extraction: tools return the absolute `paper.pdf` path and the client reads the PDF natively.

On-disk layout it reads:

```
<papersDir>/
├── _reos/
│   ├── vocabulary.md
│   └── external-changes.json   # written by create_thread/add_paper
└── threads/<slug>/
    ├── meta.json
    ├── chats/<chatId>.jsonl
    └── papers/<arxivId>/
        ├── meta.json
        ├── paper.pdf          # absent for webpage-sourced papers
        ├── summary.md         # frontmatter (topics/domains/keywords) + prose
        ├── notes.md
        ├── highlights.json
        └── chats/<chatId>.jsonl
```

## Tools

| Tool | Purpose |
|---|---|
| `list_threads` | List threads (optionally by status), newest first |
| `get_thread` | One thread in full: question, ordered papers, artifacts, chat count |
| `search_papers` | Search/list papers by query, thread, status, tags; paginated |
| `get_paper` | Full metadata + file inventory + `pdf_path` (or `sourceUrl`) |
| `get_paper_content` | Summary, notes, and highlights — the cheap way to read a paper |
| `list_chats` | Past chat sessions for a thread or paper |
| `get_chat` | Messages of one chat session (`last_n` to tail) |
| `get_vocabulary` | Library-wide tag vocabulary (`_reos/vocabulary.md`) |
| `create_thread` | Create a thread (title, optional question and parent thread) |
| `add_paper` | Add a paper by arXiv/AlphaXiv/bioRxiv/medRxiv ID or URL, any DOI or URL (journal page, PubMed Central, direct PDF link), or a local PDF path — into a thread or the inbox. Fetches metadata + PDF, dedups against the library |

`add_paper` PDF discovery for non-arXiv sources, in order: the URL itself if it serves a PDF, the page's `citation_pdf_url`, Europe PMC full-text links (for PMC URLs), then open-access locations from OpenAlex for the DOI. Metadata falls back to Europe PMC / OpenAlex when the publisher page is bot-protected. Paywalled papers end up as webpage papers (no PDF) and the response lists what was tried; the caller can supply `pdf_path` (local file) or `pdf_url`. Every downloaded file is checked for the `%PDF-` header, so paywall/challenge HTML is never saved as a PDF.

Dedup rules: already in the library → not re-added. In the inbox and a `thread` was given → moved into that thread; in another thread → left where it is (a paper belongs to one thread). In every case a missing PDF is backfilled when one is supplied or found, so re-running `add_paper` with the same source plus `pdf_path` attaches a PDF to an existing webpage paper. Local PDFs get a content-hash id (`local-<sha256 prefix>`), so adding the same file twice is a no-op.

Tool descriptions steer agents through the cost-first reading order used by the app's own skills: metadata → summary → notes → chats → PDF last.

## Build

```sh
cd mcp
npm install
npm run build
```

Rebuild (`npm run build`) after editing anything in `src/`.

## Register

Claude Code (user scope, works from any directory):

```sh
claude mcp add --scope user reos -- node /Users/antonap/reos/standalone/mcp/dist/index.js
```

Claude Desktop — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reos": {
      "command": "node",
      "args": ["/Users/antonap/reos/standalone/mcp/dist/index.js"]
    }
  }
}
```

## Test without a client

```sh
node smoke-test.mjs   # scripted end-to-end pass over every tool (needs a built dist/)
npm run inspect       # MCP Inspector against src/ via tsx
# or against the build:
npx @modelcontextprotocol/inspector node dist/index.js
```

`smoke-test.mjs` only exercises the read tools. To try the write tools without touching your real library, point `HOME` at a scratch dir whose `.reos/config.json` names a scratch `papersDir`.

Smoke tests: `list_threads` → `get_thread <slug>` → `search_papers` with a vocabulary tag → `get_paper <arxivId>` → `get_paper_content` → `list_chats` → `get_chat`. Error paths worth checking: a bogus paper ref (candidate-listing error), a `web-*` paper (returns `sourceUrl`, no PDF), a paper without `summary.md` (`(none)`).

In Claude Code, try: "list my active research threads", "what does paper 2301.08243 say", "summarize the discussions in thread &lt;title&gt;", "start a thread on diffusion policies and add 2303.04137".
