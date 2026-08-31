# reos-mcp-server

Read-only MCP (Model Context Protocol) server for the Re:OS paper library. Lets Claude Code / Claude Desktop chat with your papers and research threads from outside the app: browse threads, search papers, read summaries/notes/highlights and past chats, and get PDF paths to read directly.

## How it works

- Bootstraps from `~/.reos/config.json` → `papersDir` (the same config the app writes).
- Reads the library **directly from disk** — the filesystem is Re:OS's source of truth. It never touches the app's SQLite cache, so it works whether or not the app is running.
- **Strictly read-only**: the code only imports `readFile`/`readdir`/`stat`. Nothing under `papersDir` is ever created or modified.
- No PDF text extraction: tools return the absolute `paper.pdf` path and the client reads the PDF natively.

On-disk layout it reads:

```
<papersDir>/
├── _reos/vocabulary.md
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

Smoke tests: `list_threads` → `get_thread <slug>` → `search_papers` with a vocabulary tag → `get_paper <arxivId>` → `get_paper_content` → `list_chats` → `get_chat`. Error paths worth checking: a bogus paper ref (candidate-listing error), a `web-*` paper (returns `sourceUrl`, no PDF), a paper without `summary.md` (`(none)`).

In Claude Code, try: "list my active research threads", "what does paper 2301.08243 say", "summarize the discussions in thread &lt;title&gt;".
