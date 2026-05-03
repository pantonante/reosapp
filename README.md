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

Settings are saved to `~/.reos/config.json`. The SQLite cache lives at
`~/.reos/cache/reos.db` and is rebuildable from the settings page.

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
