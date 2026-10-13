# Re:OS — Standalone (Tauri)

Self-contained desktop build of Re:OS. Lives independently of the parent web
app at `../src/`; all code under `./standalone/` is the desktop binary.

## Develop

```sh
cd standalone
npm install
npm run dev   # tauri dev → spawns vite + opens webview
```

First launch shows a wizard asking for the papers folder. The folder layout
matches the parent app's filesystem-as-source-of-truth model
(`<papersDir>/threads/<slug>/papers/<arxivId>/{paper.pdf,meta.json,notes.md}`).
Generated or imported reports live beside them as `summary.md`; downloaded
summary figures are kept in `summary-assets/` so they remain available offline.

AlphaXiv reports can be imported from a paper's Summary tab. Add an AlphaXiv
API key in Settings first; Re:OS stores it in the operating system credential
vault rather than in `config.json` or the papers folder.

Settings are saved to `~/.reos/config.json`. The SQLite cache lives at
`~/.reos/cache/reos.db` and is rebuildable from the settings page.

## iPad reader

Choose a papers folder, then enable **iPad server** in Settings. Re:OS listens
on port 3847 on all IPv4 network interfaces and shows the addresses to open in
Safari. The server starts again when Re:OS opens if the toggle was left on, and
stops when Re:OS quits. The iPad reader can search papers, open PDFs with a
PDF.js reader, read summaries, and edit paper notes. Its library sidebar starts
hidden; the menu button opens it and marks papers open in the current desktop
window. The desktop app remains the place for importing papers, managing
threads, and AI chat.
Use the Share button beside an address to send its link through AirDrop.

Each address contains a private access key. Share it only with devices you
trust; the connection uses plain HTTP and is intended for a private local
network. If your Mac has several network addresses, use the one on the same
network as your iPad.

## Build

```sh
cd standalone
npm run build   # tauri build
```

Bundles end up under `src-tauri/target/release/bundle/`.

## Stack

- Tauri 2 (Rust shell)
- SvelteKit (Svelte 5 runes) + adapter-static
- shadcn-svelte / bits-ui + Tailwind (dark theme only)
- `tauri-plugin-sql` (SQLite cache)
- `tauri-plugin-fs` (papers folder I/O)
- `tauri-plugin-http` (Arxiv API)
- `tauri-plugin-shell` + custom Rust commands (chat via `claude` CLI, reveal
  in Finder)
