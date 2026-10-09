---
name: latex
description: "Write and compile LaTeX into PDF: papers, theses, maths homework, CVs, letters, anything with formulas or citations. Use when the user asks for LaTeX or a .tex file, shares one to fix or compile, or needs typeset mathematics."
---

# LaTeX

Compile with Tectonic: one self-contained program that fetches the packages a document needs on
first use, needs no root and reruns itself until references settle. Save the .tex and the PDF
in the user's Drive (one folder per document) and show the PDF with a drive card.

## Setup

Check `micromamba env list` first. If there is no `docs` environment:

```bash
micromamba create -y -n docs --override-channels -c conda-forge tectonic
```

If it exists but lacks it, `micromamba install -y -n docs --override-channels -c conda-forge tectonic`.
The first compile downloads the TeX bundle (a few hundred MB, cached afterwards): use a long shell
timeout (600 s) the first time.

## Compiling

```bash
cd ~/Drive/Papers/my-paper
micromamba run -n docs tectonic main.tex          # writes main.pdf beside it
```

Add `--keep-logs` to keep `main.log` for a hard error, and `-Z continue-on-errors` only to see how
far a broken document gets. Bibliographies with BibTeX (`\bibliography{refs}`) work without extra
steps; biblatex needs `backend=bibtex`, because `biber` is not part of Tectonic.

## A starting point

```latex
\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}

\title{Title}
\author{Name}
\date{8 October 2026}

\begin{document}
\maketitle

\section{Introduction}
Inline maths $e^{i\pi} + 1 = 0$, and a numbered equation:
\begin{equation}
  \int_0^1 x^2 \, dx = \frac{1}{3}
  \label{eq:area}
\end{equation}
Equation~\eqref{eq:area} is referred to by its label.

\end{document}
```

Use `letterpaper` in the US and Canada. Pick the class for the job: `article` for short pieces,
`report` or `book` for chapters, `beamer` for slides, `letter` or `scrlttr2` for letters.
A university or journal template overrides all of this: ask for it, and use it as given.

## Fixing errors

Read the first error, not the last: later ones are usually consequences. The common ones:

| Message | Usual cause |
| --- | --- |
| `Undefined control sequence` | a typo in a command, or its package is not loaded |
| `Missing $ inserted` | `_`, `^` or a maths command outside maths mode; or an unescaped `_` in text (`\_`) |
| `Missing } inserted` / `Runaway argument` | an unbalanced brace earlier on that line or paragraph |
| `File 'x.sty' not found` | a package name typo (Tectonic fetches real ones by itself) |
| `Citation … undefined` | the key is missing from the .bib file or misspelled |

Escape `& % $ # _ { } ~ ^ \` in ordinary text. Fix one error, compile again, repeat.

## Check before reporting

The compile ends without `error:` and the PDF is new. Then `pdfinfo main.pdf` for the page count and
`pdftotext main.pdf - | head -40` to see the text came out right (no `??` for missing references).
For maths-heavy pages render one with `pdftoppm -png -r 80 -f 1 -l 1 main.pdf page` and look at it.
