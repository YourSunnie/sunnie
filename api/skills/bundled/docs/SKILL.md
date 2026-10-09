---
name: docs
description: "Create, read and edit Word documents (.docx): letters, reports, CVs, proposals, forms, handouts. Use when the user asks for a Word file or a document to print, send or edit in Word, Pages or Google Docs, or shares a .docx to read or change."
---

# Word documents

Build documents with `python-docx`; use pandoc when the content starts as Markdown and needs no
special layout. Save the result in the user's Drive and show it with a drive card.

## Setup

Check `micromamba env list` first. If there is no `docs` environment:

```bash
micromamba create -y -n docs --override-channels -c conda-forge python=3.12 python-docx pandoc
```

If it exists but lacks a package, `micromamba install -y -n docs --override-channels -c conda-forge python-docx`.
Run scripts with `micromamba run -n docs python make_doc.py`. Keep the script beside the output
(for example in a `.build/` folder) so the document can be regenerated after a change.

## Reading a .docx

- Quick text: `micromamba run -n docs pandoc in.docx -t gfm` (keeps headings, lists, tables;
  a paragraph in the `Title` style is left out).
- Structure: open it with `docx.Document(path)` and walk `doc.paragraphs` (`p.style.name`,
  `p.text`) and `doc.tables` (`cell.text`).

## Writing a new document

```python
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

doc = Document()
section = doc.sections[0]
section.page_width, section.page_height = Cm(21), Cm(29.7)   # A4; Letter is 21.59 × 27.94 cm
for side in ('left_margin', 'right_margin', 'top_margin', 'bottom_margin'):
    setattr(section, side, Cm(2.5))

normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(11)

doc.add_heading('Quarterly report', level=0)          # the title
doc.add_paragraph('Prepared for … on 8 October 2026.')
doc.add_heading('Summary', level=1)
doc.add_paragraph('First point', style='List Bullet')
doc.add_paragraph('First step', style='List Number')

table = doc.add_table(rows=1, cols=3, style='Table Grid')
for cell, text in zip(table.rows[0].cells, ['Item', 'Qty', 'Price']):
    cell.text = text
    cell.paragraphs[0].runs[0].bold = True
row = table.add_row().cells
row[0].text, row[1].text, row[2].text = 'Paper', '2', '€4.00'

# doc.add_picture('chart.png', width=Cm(15))
# doc.add_page_break()

footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
field = OxmlElement('w:fldSimple')
field.set(qn('w:instr'), 'PAGE')                         # page number, filled in by Word
run = OxmlElement('w:r'); text = OxmlElement('w:t'); text.text = '1'
run.append(text); field.append(run); footer._p.append(field)

doc.save('Quarterly report.docx')
```

Guidelines:
- Use the built-in styles (`Title`, `Heading 1–3`, `List Bullet`, `List Number`) rather than
  bold body text, so the navigation pane and a table of contents work.
- Page size follows the user's country: A4 almost everywhere, Letter in the US and Canada.
- Letters: sender, date, recipient, subject line, body, sign-off — each its own paragraph.
- Keep fonts to one or two; 10.5–12 pt for body text.
- Never invent facts to fill a template; leave a clearly marked placeholder and say so.

## Editing an existing document

Open it, change it, save under a new name unless the user asked to overwrite (`Report (edited).docx`).
Replace text run by run so formatting survives:

```python
for p in doc.paragraphs:
    for r in p.runs:
        if 'OLD' in r.text:
            r.text = r.text.replace('OLD', 'NEW')
```

Text split across runs (common after manual edits in Word) will not match; join `p.text` to find
it, then rewrite that paragraph's runs. Tracked changes and comments are not supported by
python-docx: say so instead of silently dropping them.

## Check before reporting

Reopen the saved file and print what a reader would see:

```bash
micromamba run -n docs python -c "import docx,sys; d=docx.Document(sys.argv[1]); [print(p.style.name, '|', p.text) for p in d.paragraphs]" "Quarterly report.docx"
```

Confirm headings, lists, tables and placeholders are where they belong, then tell the user what is
in the document and anything they still need to fill in.
