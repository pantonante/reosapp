---
name: navigate-thread
description: Use when the user is chatting inside a Re:OS thread folder and asks questions that require reading across multiple papers, the thread synthesis, or prior conversations — e.g. "compare the methods in this thread", "what does this thread say about X", "what did we discuss earlier", "synthesize this thread", "which paper covers Y", "update the synthesis". Trigger this whenever the working directory contains a `meta.json` thread descriptor and a `papers/` subdirectory.
---

# Navigate a Re:OS thread folder

You are inside a Re:OS thread — a research investigation that bundles a set of papers, the user's notes, and prior chats. Your working directory IS the thread folder. Read freely; write thoughtfully.

## Folder layout (always present)

```
./                        # the thread folder (your CWD)
├── meta.json             # { id, title, question, status, createdAt, updatedAt }
├── synthesis.md          # the user's evolving synthesis (may be empty)
├── chats/<id>.jsonl      # prior thread-level chats (one JSON message per line)
└── papers/<arxivId>/     # one folder per paper in the thread
    ├── meta.json           # { arxivId, title, authors, abstract, tags, readingStatus, … }
    ├── paper.pdf           # full PDF (Read tool handles PDFs natively)
    ├── summary.md          # generated summary with YAML frontmatter
    │                       #   topics: […]   domains: […]   keywords: […]
    ├── notes.md            # user freeform notes (often missing)
    └── chats/<id>.jsonl    # prior per-paper chats
```

`summary.md` files start with a YAML frontmatter block — those tags power the cross-paper graph and are useful signal for "find the paper about X" queries.

## Cost-first reading order

Always read in increasing-cost order. Stop the moment you have what you need.

1. **`meta.json`** at thread or paper level — cheap, gives titles, abstract, tags.
2. **`summary.md`** — distilled, opinionated, usually answers the question.
3. **`notes.md`** — short user-authored signal; check if the user explicitly took notes.
4. **`chats/*.jsonl`** — prior conversations; useful for "what did we discuss" / continuity.
5. **`paper.pdf`** — only when summary + notes don't answer the question, or the user asks for something the summary wouldn't capture (specific equation, figure, ablation number).

## Recipes

### "Compare the papers in this thread"
1. List `papers/*/` directories.
2. For each, read `meta.json` (title) and `summary.md` (extract Problem, Pipeline, Results sections, plus the frontmatter `topics`/`domains`/`keywords`).
3. Build a markdown table with one row per paper. Columns chosen to match the user's question (e.g., method · domain · key result · weakness).
4. End with a 2-3 sentence "through-line" — the actual narrative that connects them.

### "What does this thread say about <topic>?"
1. Grep `summary.md` files for the topic (literal + close synonyms). Read every match in full.
2. If thin coverage in summaries, scan `notes.md` files.
3. If still thin, fall back to `paper.pdf` for the most-relevant paper (use the summary's frontmatter `keywords` to choose).
4. Cite each claim with the arxivId folder name.

### "What did we discuss?"
1. List `chats/*.jsonl` (thread-level) sorted by mtime.
2. Read the most recent 1-3. Each line is `{"role":"user"|"assistant","content":"…","createdAt":"…"}`.
3. Optionally include `papers/<arxivId>/chats/*.jsonl` if the user's question is paper-specific.
4. Summarize the substantive points (skip pleasantries, skip your own re-explanations).

### "Synthesize this thread" / "update the synthesis"
1. Read `meta.json` for the thread question.
2. Read every `papers/*/summary.md`. Read `notes.md` where present.
3. Read the existing `synthesis.md` — preserve any YAML frontmatter (`topics`/`domains`/`keywords`) at the top verbatim if present.
4. Write a synthesis that answers the thread's question, citing papers by arxivId. Structure:
   - one paragraph framing the question
   - a paragraph per cluster of papers grouped by approach/finding
   - an open-questions / next-steps paragraph
5. Save to `synthesis.md` (overwrite). Do not include preamble in your reply — the file is the deliverable.

### "Which paper covers <X>?"
1. Grep `summary.md` frontmatter (`topics:`, `domains:`, `keywords:`) for X first — that's the highest-signal index.
2. Fall back to grepping the body of summaries.
3. Return arxivId + title + a one-line "why this one".

## Writing artifacts

When you produce something durable — a comparison table, a literature map, a draft section — and the user hasn't told you where to put it, save it inside the thread folder with a meaningful filename (e.g. `comparison-methods.md`, `open-questions.md`). Do **not** silently overwrite `synthesis.md`, `notes.md`, or any `summary.md` unless the user's request was clearly about updating that specific file.

## What not to do

- Don't read every `paper.pdf` upfront. Summaries exist for a reason.
- Don't fabricate paths. The arxivId folders are exactly what `ls papers/` shows.
- Don't strip frontmatter from `summary.md` or `synthesis.md` files when editing — the graph view depends on it.
- Don't echo the contents of files you read back to the user verbatim. Synthesize.
