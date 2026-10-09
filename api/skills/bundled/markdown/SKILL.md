---
name: markdown
description: "Write a clean, well-structured Markdown document (notes, a README, a report, minutes, a guide) or convert Markdown to and from Word, HTML or PDF with pandoc. Use when the user wants a .md file, a tidy text document they can read anywhere, or Markdown turned into another format."
---

# Markdown

Markdown is the default for anything the user will read in the app, keep as notes, or turn into
another format later. Save it in their Drive (a sensible folder, a descriptive file name such as
`2026-10-08 Team meeting.md`) and show it with a drive card.

## Writing

- One `#` title at the top, then `##` sections and `###` subsections. Never skip a level.
- Short paragraphs. A list when the order or the items matter, prose when the reasoning does.
- Numbered lists only for steps or rankings. Keep list items parallel in form.
- Tables need a header row and work best with 2–5 short columns; put long text in prose instead.
- Code, commands and file contents go in fenced blocks with a language (` ```python `).
- Links carry readable text: `[the booking page](https://…)`, never a bare "here".
- Bold for the few words a skimming reader must not miss; no bold whole sentences.
- Dates in an unambiguous form (8 October 2026, or 2026-10-08).
- No front matter (`---` YAML) unless the user or a tool that reads the file needs it.
- Plain characters: straight lists, no HTML unless Markdown cannot express it.

For a report or summary, lead with the answer or the outcome, then the detail behind it.

## Converting with pandoc

Pandoc comes from conda-forge. Check first: `micromamba env list`, then
`micromamba run -n docs pandoc --version`. If the `docs` environment is missing, create it:

```bash
micromamba create -y -n docs --override-channels -c conda-forge pandoc
```

(Add `pandoc` to an existing `docs` environment with `micromamba install` instead.)

| From → to | Command |
| --- | --- |
| Markdown → Word | `micromamba run -n docs pandoc in.md -o out.docx` |
| Markdown → Word in a house style | add `--reference-doc=style.docx` (a .docx whose styles are used) |
| Markdown → web page | `micromamba run -n docs pandoc in.md -s --metadata title="Title" -o out.html` |
| Markdown → PDF | `micromamba run -n docs pandoc in.md -o out.pdf --pdf-engine=tectonic` (needs `tectonic` in the environment; see the latex skill) |
| Word → Markdown | `micromamba run -n docs pandoc in.docx -t gfm --extract-media=media -o out.md` |
| Web page → Markdown | `micromamba run -n docs pandoc in.html -t gfm -o out.md` |

Add `--toc` for a table of contents and `-V geometry:margin=2.5cm` to set PDF margins. The first PDF
on a computer downloads Tectonic's TeX bundle and takes a few minutes: give that shell call a long
timeout (600 s); later ones take seconds.

## Check before reporting

- Read the file back. Headings in order, no stray `**` or broken tables.
- After a conversion, look at the result rather than trusting the exit code: for Word,
  `micromamba run -n docs pandoc out.docx -t plain | head -50`; for a PDF, `pdftotext out.pdf - | head -50`.
- Say what was converted and anything that did not carry over (comments, tracked changes,
  complex layouts are lost when going through Markdown).
