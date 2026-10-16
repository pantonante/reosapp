#!/usr/bin/env python3
"""Locate and crop figures/tables from a paper PDF for the summary.

Stdlib only; shells out to poppler's `pdftotext` and `pdftoppm`.

    figures.py captions paper.pdf
        One JSON object per figure/table caption: page, kind, number, the
        caption text, and a suggested crop box (PDF points, origin top-left).

    figures.py crop paper.pdf PAGE X0 Y0 X1 Y1 OUT.png [--dpi 200]
        Render the box (PDF points) on PAGE to OUT.png.

    figures.py page paper.pdf PAGE OUT.png
        Render the whole page at 72 dpi, so 1 pixel == 1 point. Use it to
        eyeball coordinates when a suggested box is off.
"""

import json
import os
import re
import subprocess
import sys
from collections import defaultdict

# "Figure 3:", "Fig. 3.", "Table 2 |", "Figure S1:" — the trailing punctuation
# separates captions from in-text references like "Figure 3 shows".
LABEL_RE = re.compile(r"^(Figure|Fig\.?|Table|TABLE|FIGURE)$")
NUMBER_RE = re.compile(r"^([A-Z]?\d+)([:.|]?)$")
GAP = 7  # points; wider than justified word spacing, narrower than a column gutter
PAD = 4  # points of breathing room around a suggested box


def run(cmd):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"{cmd[0]} failed ({res.returncode}): {res.stderr.strip()}")
    return res.stdout


def read_layout(pdf):
    """Return {page: {"w", "h", "blocks": [block]}} from `pdftotext -tsv`.

    A block is {"lines": [{"x0","y0","x1","y1","text","words"}], bbox...}.
    """
    pages = {}
    lines = defaultdict(list)  # (page, flow, block, line) -> words
    for row in run(["pdftotext", "-tsv", pdf, "-"]).splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12:
            continue
        level, page, flow, block, line = (int(c) for c in cols[:5])
        left, top, width, height = (float(c) for c in cols[6:10])
        text = cols[11]
        if level == 1:
            pages[page] = {"w": width, "h": height, "blocks": []}
        elif level == 5:
            lines[(page, flow, block, line)].append((left, top, left + width, top + height, text))

    blocks = defaultdict(list)
    for (page, flow, block, _), words in sorted(lines.items()):
        blocks[(page, flow, block)].append({
            "x0": min(w[0] for w in words),
            "y0": min(w[1] for w in words),
            "x1": max(w[2] for w in words),
            "y1": max(w[3] for w in words),
            "text": " ".join(w[4] for w in words),
            "words": words,
        })
    for (page, _, _), blines in sorted(blocks.items()):
        if page not in pages:
            continue
        pages[page]["blocks"].append({
            "lines": blines,
            "x0": min(l["x0"] for l in blines),
            "y0": min(l["y0"] for l in blines),
            "x1": max(l["x1"] for l in blines),
            "y1": max(l["y1"] for l in blines),
        })
    return pages


def text_bounds(page):
    """Horizontal extent of the page's text area, from its paragraphs."""
    paras = [b for b in page["blocks"] if len(b["lines"]) >= 3] or page["blocks"]
    if not paras:
        return 0.0, page["w"]
    # Paragraph extents are stable; single lines include arXiv side stamps
    # and figure labels.
    return min(b["x0"] for b in paras), max(b["x1"] for b in paras)


def is_prose(block, col_w):
    """Body-text paragraph: several lines that mostly fill the column."""
    full = [l for l in block["lines"] if (l["x1"] - l["x0"]) > 0.8 * col_w]
    return len(block["lines"]) >= 3 and len(full) >= 2


def suggest_box(pdf, pnum, page, cap, caps):
    lo, hi = text_bounds(page)
    mid = (lo + hi) / 2
    if cap["wrapped"]:
        # Wrapped float: body text runs down the other side of the column.
        x0, x1 = (cap["wrap_edge"] + 2, hi) if cap["x0"] > mid - 20 else (lo, cap["x1"])
    elif cap["x1"] - cap["x0"] > 0.6 * (hi - lo) or (cap["x0"] < mid - 20 and cap["x1"] > mid + 20):
        x0, x1 = lo, hi
    elif cap["x1"] <= mid + 20:
        x0, x1 = lo, mid - 5
    else:
        x0, x1 = mid + 5, hi
    col_w = x1 - x0

    def in_column(b):
        return b["x1"] > x0 + 5 and b["x0"] < x1 - 5

    # Running headers and page numbers are single lines near the page edge;
    # figures can extend right up to them (raster figures have no text to
    # find, so the first text block is no guide).
    def edge_line(b, top):
        return len(b["lines"]) == 1 and (b["y1"] < 0.08 * page["h"] if top else b["y0"] > 0.92 * page["h"])
    body = [b for b in page["blocks"] if not (edge_line(b, True) or edge_line(b, False))]
    top_margin = max((b["y1"] for b in page["blocks"] if edge_line(b, True)), default=0.05 * page["h"]) + PAD
    bottom_margin = min((b["y0"] for b in page["blocks"] if edge_line(b, False)), default=0.95 * page["h"]) - PAD

    # Paragraphs and other captions bound the region on either side.
    cap_blocks = [c["block"] for c in caps]
    walls = [(b["y0"], b["y1"], None) for b in body
             if not any(b is cb for cb in cap_blocks) and in_column(b) and is_prose(b, col_w)]
    walls += [(c["y0"], c["y1"], c["kind"]) for c in caps if c is not cap and in_column(c)]
    above = (max([w[1] for w in walls if w[1] <= cap["y0"] + 1], default=top_margin), cap["y0"])
    below_wall = min([w for w in walls if w[0] >= cap["y1"] - 1], key=lambda w: w[0], default=(bottom_margin, None, None))
    below = (cap["y1"], below_wall[0])

    if cap["kind"] == "figure":
        y0, y1 = above
    else:
        # Tables put their caption above or below. LaTeX sets a caption
        # closer to its float than to the surrounding text, so take the side
        # with the smaller blank gap.
        # Spans start 3pt clear of the caption so its own ascenders and
        # descenders don't count as content.
        def gap(span, from_top):
            span = (span[0] + 3, span[1]) if from_top else (span[0], span[1] - 3)
            found = ink(pdf, pnum, [x0, span[0], x1, span[1]])
            if not found:
                return float("inf")
            rows = found[0]
            return rows[0] if from_top else (span[1] - span[0]) - rows[-1]
        if below_wall[2] == "figure":
            y0, y1 = above  # the span below is that figure's body
        else:
            y0, y1 = below if gap(below, True) <= gap(above, False) else above

    if (y0, y1) == above:
        y0, y1 = y0 + 1, y1 - 2  # stop short of the caption's first line
    else:
        y0, y1 = y0 + 2, y1 - 1

    # A float narrower than the text width may have a paragraph wrapped
    # beside it; move the inner edge past that paragraph's words.
    if x1 - x0 < 0.9 * (hi - lo):
        beside = [w for b in body if is_prose(b, col_w)
                  for l in b["lines"] if y0 < l["y1"] and l["y0"] < y1
                  for w in l["words"]]
        if x0 > lo + 20:
            x0 = max([x0] + [w[2] + 2 + PAD for w in beside if w[2] < cap["x0"] + 10])
        else:
            x1 = min([x1] + [w[0] - 2 - PAD for w in beside if w[0] > cap["x1"] - 10])
    return [round(max(0, x0 - PAD), 1), round(max(0, y0), 1),
            round(min(page["w"], x1 + PAD), 1), round(min(page["h"], y1), 1)]


def ink(pdf, page, box):
    """Rows and columns (points from the box's top-left) that hold ink."""
    x0, y0, x1, y1 = box
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    res = subprocess.run(
        ["pdftoppm", "-gray", "-r", "72", "-f", str(page), "-l", str(page),
         "-x", str(int(x0)), "-y", str(int(y0)), "-W", str(int(x1 - x0)), "-H", str(int(y1 - y0)), pdf],
        capture_output=True)
    # Binary PGM: "P5\n<w> <h>\n<maxval>\n" then one byte per pixel.
    parts = res.stdout.split(maxsplit=4)
    if res.returncode != 0 or len(parts) < 5 or parts[0] != b"P5":
        return None
    w, h = int(parts[1]), int(parts[2])
    pixels = parts[4][-w * h:] if w * h else b""
    if len(pixels) != w * h:
        return None
    rows = [r for r in range(h) if min(pixels[r * w:(r + 1) * w]) < 230]
    cols = [c for c in range(w) if min(pixels[c::w]) < 230]
    return (rows, cols) if rows and cols else None


def tighten(pdf, page, box):
    """Shrink a box to the ink inside it, so crops carry no blank margins."""
    found = ink(pdf, page, box)
    if not found:
        return box
    rows, cols = found
    x0, y0, x1, y1 = box
    return [round(max(x0, x0 + cols[0] - PAD), 1), round(max(y0, y0 + rows[0] - PAD), 1),
            round(min(x1, x0 + cols[-1] + 1 + PAD), 1), round(min(y1, y0 + rows[-1] + 1 + PAD), 1)]


def find_captions(page):
    """Yield caption dicts for every "Figure N:" / "Table N." on the page.

    A caption starts a line, or follows a wide gap when a wrapped figure puts
    it on the same text line as body copy. It runs to the end of its block,
    keeping only words right of its start in the wrapped case.
    """
    for block in page["blocks"]:
        for li, line in enumerate(block["lines"]):
            words = line["words"]
            for wi in range(len(words) - 1):
                if wi > 0 and words[wi][0] - words[wi - 1][2] < GAP:
                    continue
                label, num = LABEL_RE.match(words[wi][4]), NUMBER_RE.match(words[wi + 1][4])
                if not (label and num):
                    continue
                # Without punctuation this is a reference ("Figure 3 shows").
                if not num.group(2) and not (wi + 2 < len(words) and words[wi + 2][4] in ":.|"):
                    continue
                left = words[wi][0] - 2
                capwords = words[wi:] + [w for l in block["lines"][li + 1:] for w in l["words"] if w[0] >= left]
                yield {
                    "kind": "table" if label.group(1).lower().startswith("tab") else "figure",
                    "number": num.group(1),
                    "text": " ".join(w[4] for w in capwords),
                    "x0": min(w[0] for w in capwords),
                    "y0": min(w[1] for w in capwords),
                    "x1": max(w[2] for w in capwords),
                    "y1": max(w[3] for w in capwords),
                    "block": block,
                    "wrapped": wi > 0,
                    "wrap_edge": words[wi - 1][2] if wi > 0 else None,
                }
                break


def cmd_captions(pdf):
    pages = read_layout(pdf)
    seen = set()
    for num, page in sorted(pages.items()):
        caps = list(find_captions(page))
        for cap in caps:
            key = (cap["kind"], cap["number"])
            if key in seen:  # continued tables, or appendix re-numbering
                continue
            seen.add(key)
            print(json.dumps({
                "page": num,
                "kind": cap["kind"],
                "number": cap["number"],
                "caption": cap["text"][:400],
                "captionBox": [round(cap[k], 1) for k in ("x0", "y0", "x1", "y1")],
                "suggestedBox": tighten(pdf, num, suggest_box(pdf, num, page, cap, caps)),
                "pageSize": [page["w"], page["h"]],
            }))


def render(pdf, page, out, dpi, box=None):
    out_base, ext = os.path.splitext(out)
    if ext.lower() != ".png":
        sys.exit("output must end in .png")
    cmd = ["pdftoppm", "-png", "-singlefile", "-r", str(dpi), "-f", str(page), "-l", str(page)]
    if box:
        s = dpi / 72.0
        x0, y0, x1, y1 = box
        cmd += ["-x", str(int(x0 * s)), "-y", str(int(y0 * s)),
                "-W", str(int((x1 - x0) * s)), "-H", str(int((y1 - y0) * s))]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    run(cmd + [pdf, out_base])
    print(out)


def main(argv):
    if len(argv) >= 2 and argv[0] == "captions":
        return cmd_captions(argv[1])
    if len(argv) >= 7 and argv[0] == "crop":
        dpi = 200
        if "--dpi" in argv:
            i = argv.index("--dpi")
            dpi = int(argv[i + 1])
            argv = argv[:i] + argv[i + 2:]
        box = [float(v) for v in argv[3:7]]
        if box[2] <= box[0] or box[3] <= box[1]:
            sys.exit("box must be X0 Y0 X1 Y1 with X1 > X0 and Y1 > Y0")
        return render(argv[1], int(argv[2]), argv[7], dpi, box)
    if len(argv) >= 4 and argv[0] == "page":
        return render(argv[1], int(argv[2]), argv[3], 72)
    sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
