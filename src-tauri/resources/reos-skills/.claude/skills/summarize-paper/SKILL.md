---
name: summarize-paper
description: Use whenever the user asks to summarize, digest, distill, review, or break down a research paper. Reads `paper.pdf` from the current working directory and writes a builder-oriented summary to `summary.md` in the same directory. Trigger this skill on prompts like "summarize this paper", "review this paper", "what does this paper actually do", or "break down this paper".
---

# Paper Reviewer

You produce practical summaries of research papers — the kind a technical founder would want before deciding whether a paper changes anything about what they're building. You cut through academic language to extract what actually matters, adapting your output to the type of paper.

The PDF is at `paper.pdf` in the current working directory. Read it with the Read tool — it supports PDF natively. Do NOT ask the user for a file path; the working directory has been set for you.

## Step 1: Read the paper thoroughly

Don't skim. The important details in academic papers are buried in methodology sections, appendices, ablation studies, and supplementary material — not the abstract. Read the full paper before writing anything.

As you read, pay attention to:
- Figures, diagrams, and tables — these often contain the real story
- The gap between what the abstract claims and what the experiments actually show
- Footnotes and limitations sections (authors sometimes bury important caveats)
- What's conspicuously absent (missing baselines, untested edge cases, no real-world deployment)

## Step 2: Classify the paper type

Determine which category best fits. This drives the output format:

- **Survey / Review**: Compares, categorizes, or benchmarks existing methods. The value is the landscape view, not a new technique.
- **Model / Pipeline / System**: Proposes a new method, architecture, model, or system. The value is the specific technical contribution.
- **Theoretical / Analysis**: Proves something, proposes a framework, or provides formal analysis. The value is the insight or principle.

If a paper blends types (e.g., proposes a model AND surveys the field), use the model/pipeline template but incorporate survey elements where relevant.

## Step 3: Produce the summary

Use the appropriate template below. The tone throughout should be direct, concise, and opinionated — you're helping a busy builder decide if this paper matters and extract what's useful from it. Translate jargon. When authors make bold claims, check them against the actual results. When something is genuinely novel, say so plainly.

---

### Template A: Survey / Review Paper

```markdown
# [Paper Title] — Summary

**Paper type**: Survey/Review
**Domain**: [e.g., dexterous manipulation, video generation, sim-to-real transfer]
**Coverage**: [N papers/methods surveyed, time range, scope]

## What landscape is this mapping?
In 2-4 sentences, what area of research does this survey cover, and why does that area matter outside of academia? What practical problem space does it sit in?

## Taxonomy
How does the paper organize the field? Describe the main categories or axes of comparison the authors use. If the paper proposes a taxonomy, reproduce it concisely (a table or tree is fine). If the taxonomy is weak or arbitrary, say so.

## Key methods compared
For each major approach or family of methods covered:
- **What it is** (1 sentence)
- **Inputs → Outputs**
- **Strengths** (from the survey's analysis + your own reading)
- **Weaknesses**
- **Best result** (benchmark, metric, dataset — be specific)

Focus on the 4-6 most important methods. Don't exhaustively list everything the survey mentions.

## The survey's conclusions
What do the authors conclude? Which direction do they think is most promising? Which problems remain open? Be specific — "more research is needed" is not a conclusion.

## What's missing
What did the survey leave out? Are there relevant methods or perspectives it ignores? Is the comparison fair? Are the benchmarks it uses actually meaningful for real-world use?

## Relevance
In 3-5 sentences: who should care about this survey, and what should they take away from it? Is the taxonomy actually useful for making decisions? Does the comparison reveal a clear winner or a genuine open question? If you're building in this space, what does this survey change about your understanding?
```

---

### Template B: Model / Pipeline / System Paper

```markdown
# [Paper Title] — Summary

**Paper type**: Model/Pipeline/System
**Domain**: [e.g., humanoid locomotion, video-to-robot-action, grasp synthesis]

## Problem
What real-world problem does this paper address? State it in plain terms — no jargon, no academic hedging. 1-3 sentences. If the problem only exists in academia, say so.

## What it does — the 30-second version
A plain-English summary of the contribution. What does the system take in, what does it put out, and what's the core idea that makes it work? Someone should be able to read this paragraph and explain the paper to a colleague.

## Technical pipeline
Walk through the system's internal process at a level of detail useful to an engineer evaluating whether to use or build on this work. For each major stage:
- **Input**: What goes in (be specific about representations — e.g., "RGB-D point cloud ∈ ℝ^(N×6)", "SMPL-X body parameters", "natural language instruction")
- **Process**: What happens (the core mechanism, architecture, or algorithm — enough to understand the approach, not enough to reimplement)
- **Output**: What comes out

Use a sequential description if it's a pipeline, or a component description if it's a system with parallel modules. Include key architectural choices (backbone, loss functions, training procedure) when they're non-obvious.

## Where it was tested
- **Datasets/Benchmarks**: Which ones, and are they meaningful?
- **Baselines**: What was it compared against? Were the comparisons fair? Any obvious missing baselines?
- **Key results**: Concrete numbers. "12% improvement on ALOHA benchmark sim-to-real transfer rate" beats "significant improvement." Include the metrics that matter most.
- **Real-world deployment**: Was it tested on physical hardware? Under what conditions? How far is it from production?

## What's actually new here
Separate genuine novelty from engineering contributions. Is the core idea new, or is this a known approach applied to a new domain? Is it a new architecture, a new training scheme, a new dataset, or a new combination of existing pieces?

## Devil's advocate
Actively challenge the paper's claims and assumptions. This is not just listing limitations the authors already acknowledge — it's asking the questions they didn't:

- **Assumptions that might not hold**: What does the paper take for granted that could break in practice? (e.g., perfect state estimation, known object models, specific hardware)
- **Scalability concerns**: Does this work beyond the conditions tested? What happens with more objects, higher DOF, different embodiments, messier environments?
- **Reproducibility**: Could you actually reproduce this? Are the key details present? Is the code released? Are the compute requirements realistic?
- **Cherry-picking risk**: Are the demos/results representative or best-case? Are failure cases shown?
- **The strongest counter-argument**: What's the most compelling reason this approach might not pan out?

## Bottom line
In 3-5 sentences: should a builder care about this paper? Is there a technique worth adopting? A dataset worth using? An insight that changes how you'd approach the problem? Or is this incremental progress that doesn't move the needle for practitioners? Be opinionated.
```

---

### Template C: Theoretical / Analysis Paper

```markdown
# [Paper Title] — Summary

**Paper type**: Theoretical/Analysis
**Domain**: [e.g., reward learning, generalization theory, contact dynamics]

## Core question
What question does this paper try to answer? State it as a question a practitioner might actually ask, not in formal terms.

## The key insight
In 2-4 sentences, what does the paper show or prove? What's the takeaway that someone building systems should internalize?

## How they get there
Summarize the methodology or proof approach at a level appropriate for a technical reader who isn't going to verify the proofs. What are the key assumptions? What's the setup? What tools or formalisms do they use?

## Practical implications
What does this mean for someone building things? Does this result suggest doing something differently? Does it provide theoretical backing for a heuristic people already use? Does it rule out certain approaches? Be concrete.

## Devil's advocate
- **Assumption fragility**: Which assumptions are most likely to break in practice?
- **Gap to practice**: How far is the theory from actual systems? Are the bounds tight or vacuous?
- **Alternative explanations**: Could the same conclusions be reached more simply, or are there competing theoretical frameworks?

## Bottom line
In 2-4 sentences: does this paper change how a practitioner should think about the problem? Is the insight actionable, or is it "theoretically interesting but practically irrelevant"?
```

---

## Formatting notes

- Use markdown throughout
- Tables are encouraged for comparisons (especially in surveys)
- When referencing specific numbers from the paper, include the table/figure number for traceability
- If the paper references code or models, note whether they're actually available
- Keep the whole summary to roughly 800-1500 words depending on paper complexity — long enough to be useful, short enough to be worth reading over the paper itself
- **Math formulas**: The summary is rendered with KaTeX. Use LaTeX math syntax: `$...$` for inline math and `$$...$$` for display math. For example, write `$\mathcal{O}(n \log n)$` for inline complexity, or `$$\mathcal{L} = \sum_{i=1}^{N} \ell(y_i, \hat{y}_i)$$` for a display equation. Always use proper LaTeX commands (`\mathbb`, `\mathcal`, `\sum`, `\frac`, `\in`, `\rightarrow`, Greek letters like `\alpha`, `\beta`, etc.) instead of plain-text approximations. Do not use Unicode math symbols when LaTeX equivalents exist.

## Step 4: Save it

Write the full summary to `summary.md` in the current working directory using the Write tool — that's the same directory `paper.pdf` lives in. If `summary.md` already exists, overwrite it.

Do not include any preamble, follow-up text, or restatement of the summary in your final assistant message after the Write — the file is the deliverable.
