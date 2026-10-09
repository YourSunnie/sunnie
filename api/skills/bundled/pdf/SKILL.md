---
name: pdf
description: "Read, extract from, create, combine, split, rotate, fill in and protect PDF files. Use when the user shares a PDF to read, summarise or pull tables from, asks for a PDF (a letter, an invoice, a printable page), wants pages merged, split or reordered, a form filled, or a scan made searchable."
---

# PDF files

`pdftotext`, `pdfinfo` and `pdftoppm` (poppler) are usually installed already; check with
`command -v pdftotext`. Everything else comes from conda-forge. Save results in the user's Drive
and show them with a drive card.

## Setup

Check `micromamba env list` first. If there is no `docs` environment:

```bash
micromamba create -y -n docs --override-channels -c conda-forge python=3.12 pypdf pdfplumber reportlab
```

If it exists but lacks a package, add it with `micromamba install -y -n docs --override-channels -c conda-forge <package>`.

## Reading

- Text in reading order: `pdftotext -layout in.pdf -` (add `-f 3 -l 5` for pages 3–5).
- Page count, size, title: `pdfinfo in.pdf`.
- Tables: pdfplumber.
  ```python
  import pdfplumber
  with pdfplumber.open('in.pdf') as pdf:
      for n, page in enumerate(pdf.pages, 1):
          for table in page.extract_tables():
              print(n, table)
  ```
- A page as a picture, to look at its layout: `pdftoppm -png -r 80 -f 1 -l 1 in.pdf page`.
- No text comes out: it is a scan. Make it searchable with OCR
  (`micromamba install -y -n docs --override-channels -c conda-forge ocrmypdf`, then
  `micromamba run -n docs ocrmypdf -l eng in.pdf out.pdf`; other languages need their tesseract data).

Quote page numbers when reporting what a document says.

## Combining, splitting, rotating

```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ['a.pdf', 'b.pdf']:
    writer.append(path)                       # merge; writer.append(path, pages=(0, 3)) for a range
writer.write('merged.pdf')

reader = PdfReader('in.pdf')
for i, page in enumerate(reader.pages, 1):    # one file per page
    single = PdfWriter(); single.add_page(page); single.write(f'page-{i}.pdf')

writer = PdfWriter(clone_from='in.pdf')
writer.pages[0].rotate(90)                    # clockwise, in multiples of 90
writer.write('rotated.pdf')
```

Keep the original; write the result under a new name.

## Filling in a form

```python
from pypdf import PdfReader, PdfWriter
reader = PdfReader('form.pdf')
print({name: field.get('/V') for name, field in (reader.get_fields() or {}).items()})

writer = PdfWriter(clone_from='form.pdf')
writer.update_page_form_field_values(writer.pages[0], {'Full name': 'Alex Example'}, auto_regenerate=False)
writer.set_need_appearances_writer(True)
writer.write('form (filled).pdf')
```

A form without fields (`get_fields()` is empty) is a flat page: say so, and offer to place text on it
with reportlab or to fill it another way. Fill in only what the user gave you; never guess personal
details, and ask before signing anything in their name.

## Creating a PDF

- From prose: write Markdown and convert it (see the markdown skill):
  `micromamba run -n docs pandoc in.md -o out.pdf --pdf-engine=tectonic`.
- With a designed layout (an invoice, a flyer): write HTML and CSS, then print it with Chrome:
  `google-chrome-stable --headless=new --no-sandbox --disable-dev-shm-usage --no-pdf-header-footer --print-to-pdf=out.pdf file://$PWD/in.html`
  (in a container Chrome will not start without the first two flags). Set the page in CSS:
  `@page { size: A4; margin: 2cm }`.
- Drawn from code (labels, certificates, many similar pages): reportlab's `canvas.Canvas('out.pdf', pagesize=A4)`.

## Protecting

```python
writer = PdfWriter(clone_from='in.pdf')
writer.encrypt(user_password='…', algorithm='AES-256')
writer.write('protected.pdf')
```

Never put the password in a file name, a note or memory; tell the user to keep it themselves.
(`pdfinfo` then needs `-upw <password>` to open the file.)

## Check before reporting

`pdfinfo out.pdf` for the page count, `pdftotext out.pdf - | head -40` for the content, and for
anything visual render the first page with `pdftoppm` and look at it.
