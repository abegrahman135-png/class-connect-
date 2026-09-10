#!/usr/bin/env python3
"""Generate selectable-text source-code PDFs (landscape A4, monospace).

Outputs:
  pdf-exports/01-backend.pdf
  pdf-exports/02-tests-config.pdf
  pdf-exports/03-frontend-deploy.pdf

Each file section starts with a "=== full/path ===" header, with line
numbers and wrapped long lines. Aborts if a likely secret is detected.
"""
import datetime
import os
import re
import sys
import textwrap
from html import escape

from reportlab.lib.pagesizes import landscape, A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
)
from reportlab.lib import colors

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# When run from repo root via python3 scripts/export-pdfs.py, ROOT resolves correctly.
if not os.path.isfile(os.path.join(ROOT, "package.json")):
    # Fallback: assume cwd is repo root
    ROOT = os.getcwd()

OUT_DIR = os.path.join(ROOT, "pdf-exports")

PAGE_W, PAGE_H = landscape(A4)
LEFT_MARGIN = RIGHT_MARGIN = 12 * mm  # ~34pt
TOP_MARGIN = BOTTOM_MARGIN = 12 * mm
USABLE_WIDTH = PAGE_W - LEFT_MARGIN - RIGHT_MARGIN

FONT_NAME = "Courier"
FONT_SIZE = 7
LEADING = 8.5
# Courier advance width = 0.6 * font size
CHAR_WIDTH = 0.6 * FONT_SIZE
MAX_CHARS_PER_VISUAL_LINE = int(USABLE_WIDTH // CHAR_WIDTH) - 2  # safety
GUTTER = " | "  # between line number and code
LINO_WIDTH = 4  # supports up to 9999 lines
CODE_WIDTH = MAX_CHARS_PER_VISUAL_LINE - LINO_WIDTH - len(GUTTER)
# Extra safety margin for Paragraph internal padding
CODE_WIDTH = max(60, CODE_WIDTH - 4)

print(f"Page {PAGE_W:.1f}x{PAGE_H:.1f}pt usable {USABLE_WIDTH:.1f}pt "
      f"=> {MAX_CHARS_PER_VISUAL_LINE} chars/line, code width {CODE_WIDTH}")

# ---------------------------------------------------------------- secrets guard
# These patterns catch *values*, not references like ${{ secrets.FOO }} or
# UI labels like "secret-dialog". Only fail on likely real credentials.
SECRET_PATTERNS = [
    re.compile(r"(?i)(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*[:=]\s*['\"]?[A-Za-z0-9_-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(ghp_|gho_|github_pat_)[A-Za-z0-9_]+"),
    re.compile(r"\bsk-(live|test)-[A-Za-z0-9]+"),
    re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)(password|passwd|pwd)\s*[:=]\s*['\"][^'\"]{4,}['\"]"),
]

ALLOWED_SECRET_REF = re.compile(r"\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}")


def scan_for_secrets(path, text):
    # Strip legitimate GitHub secret references before scanning
    scrubbed = ALLOWED_SECRET_REF.sub("SECRET_REF", text)
    for pat in SECRET_PATTERNS:
        m = pat.search(scrubbed)
        if m:
            # Allow known placeholders
            val = m.group(0)
            if "REPLACE_WITH" in val or "example" in val.lower():
                continue
            if "SECRET_REF" in val:
                # e.g. "CLOUDFLARE_API_TOKEN: SECRET_REF" - a reference, not a value
                continue
            raise SystemExit(
                f"REFUSING to export: possible secret in {path}: {val[:60]!r}"
            )


# ---------------------------------------------------------------- styles
code_style = ParagraphStyle(
    "Code",
    fontName=FONT_NAME,
    fontSize=FONT_SIZE,
    leading=LEADING,
    textColor=colors.black,
    spaceBefore=0,
    spaceAfter=0,
)

header_style = ParagraphStyle(
    "FileHeader",
    fontName="Courier-Bold",
    fontSize=10,
    leading=13,
    textColor=colors.white,
    spaceBefore=0,
    spaceAfter=0,
)

title_style = ParagraphStyle(
    "Title",
    fontName="Courier-Bold",
    fontSize=22,
    leading=26,
    textColor=colors.black,
    alignment=1,  # centered
    spaceAfter=6,
)

subtitle_style = ParagraphStyle(
    "Subtitle",
    fontName=FONT_NAME,
    fontSize=9,
    leading=12,
    textColor=colors.HexColor("#333333"),
    alignment=1,
    spaceAfter=2,
)

meta_style = ParagraphStyle(
    "Meta",
    fontName=FONT_NAME,
    fontSize=8,
    leading=11,
    textColor=colors.HexColor("#333333"),
    alignment=1,
    spaceAfter=8,
)

TOC_STYLE = ParagraphStyle(
    "Toc",
    fontName=FONT_NAME,
    fontSize=8,
    leading=11,
    textColor=colors.black,
    leftIndent=0,
)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT_NAME, 6.5)
    canvas.setFillColor(colors.HexColor("#666666"))
    footer_text = f"{doc._pdf_title}  |  generated {doc._gen_date}  |  page {doc.page}"
    canvas.drawString(LEFT_MARGIN, 8 * mm, footer_text)
    # Right-aligned repo label
    canvas.drawRightString(PAGE_W - RIGHT_MARGIN, 8 * mm, "class-connect-")
    canvas.restoreState()


def file_header_table(rel_path, n_lines, n_bytes):
    header_text = f"=== {rel_path} ===  &nbsp;&nbsp;({n_lines} lines, {n_bytes} bytes)"
    p = Paragraph(escape(header_text).replace("&amp;nbsp;", "&nbsp;"), header_style)
    t = Table([[p]], colWidths=[USABLE_WIDTH])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1a1a2e")),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def code_paragraphs(rel_path, text):
    """Yield Paragraph flowables for one file, ~60 logical lines each."""
    lines = text.splitlines()
    n = len(lines)
    chunk = []
    lino_fmt = f"{{:>{LINO_WIDTH}d}}{GUTTER}"

    def flush():
        if not chunk:
            return None
        html = "<br/>".join(
            escape(v, quote=False).replace("  ", "&nbsp;&nbsp;") or "&nbsp;"
            for v in chunk
        )
        return Paragraph(html, code_style)

    out = []
    for idx, raw in enumerate(lines, start=1):
        expanded = raw.expandtabs(4)
        # Strip trailing whitespace; keep leading indentation
        expanded = expanded.rstrip()
        if expanded == "":
            visual = [f"{idx:>{LINO_WIDTH}d}{GUTTER}"]
        else:
            wrapped = textwrap.wrap(
                expanded,
                width=CODE_WIDTH,
                break_long_words=True,
                break_on_hyphens=False,
                drop_whitespace=False,
            ) or [""]
            visual = []
            for j, part in enumerate(wrapped):
                if j == 0:
                    visual.append(f"{idx:>{LINO_WIDTH}d}{GUTTER}{part}")
                else:
                    visual.append(f"{'':>{LINO_WIDTH}s}{GUTTER}+ {part}")
        chunk.extend(visual)
        if idx % 60 == 0:
            out.append(flush())
            chunk = []
    if chunk:
        out.append(flush())
    return out


def build_pdf(filename, doc_title, files):
    out_path = os.path.join(OUT_DIR, filename)
    os.makedirs(OUT_DIR, exist_ok=True)
    gen_date = datetime.date.today().isoformat()

    doc = SimpleDocTemplate(
        out_path,
        pagesize=landscape(A4),
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=f"class-connect- - {doc_title}",
        author="class-connect- export script",
        subject=doc_title,
    )
    doc._pdf_title = f"class-connect- / {doc_title}"
    doc._gen_date = gen_date

    story = []
    # Cover
    story.append(Spacer(1, 30 * mm))
    story.append(Paragraph(escape(f"class-connect- - {doc_title}"), title_style))
    story.append(Paragraph(escape(f"Source-code export | {gen_date} | landscape A4 | monospace | selectable text"), meta_style))
    story.append(Spacer(1, 6 * mm))
    toc_lines = [f"=== {f} ===" for f in files]
    toc_html = "<br/>".join(escape(t) for t in toc_lines)
    story.append(Paragraph(escape("Contents:"), subtitle_style))
    story.append(Paragraph(toc_html, ParagraphStyle(
        "TocC", parent=TOC_STYLE, alignment=1, spaceAfter=4,
    )))
    story.append(Paragraph(
        escape("Line numbers shown at left; long lines wrap with a '+' continuation marker. No secrets are included."),
        meta_style,
    ))

    first = True
    for rel in files:
        abs_path = os.path.join(ROOT, rel)
        if not os.path.isfile(abs_path):
            raise SystemExit(f"Missing required file: {rel}")
        with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        scan_for_secrets(rel, text)
        n_lines = text.count("\n") + (0 if text.endswith("\n") or text == "" else 1)
        n_bytes = os.path.getsize(abs_path)
        if first:
            story.append(PageBreak())
            first = False
        else:
            story.append(PageBreak())
        story.append(file_header_table(rel, n_lines, n_bytes))
        story.append(Spacer(1, 2 * mm))
        story.extend(code_paragraphs(rel, text))

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    size = os.path.getsize(out_path)
    print(f"Wrote {out_path} ({size} bytes)")
    return out_path


PDFS = [
    ("01-backend.pdf", "PDF 1 - backend", [
        "backend/src/index.js",
        "backend/wrangler.toml",
        "backend/migrations/0001_initial.sql",
    ]),
    ("02-tests-config.pdf", "PDF 2 - tests/config", [
        "backend/test/helpers.js",
        "backend/test/api.test.js",
        "backend/test/validation.test.js",
        "package.json",
        ".github/workflows/ci.yml",
        ".github/workflows/deploy.yml",
    ]),
    ("03-frontend-deploy.pdf", "PDF 3 - frontend/deploy", [
        "frontend/index.html",
        "frontend/app.js",
        "frontend/_worker.js",
        "frontend/sw.js",
        "frontend/wrangler.toml",
        "README.md",
    ]),
]


def main():
    for filename, title, files in PDFS:
        build_pdf(filename, title, files)
    print("All PDFs generated in", OUT_DIR)


if __name__ == "__main__":
    main()
