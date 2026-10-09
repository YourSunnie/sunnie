---
name: slides
description: "Create, read and edit slide decks as PowerPoint files (.pptx): talks, pitches, lessons, status updates. Use when the user asks for slides, a deck or a presentation to open in PowerPoint, Keynote or Google Slides, or shares a .pptx to read or change."
---

# Slide decks

Build decks with `python-pptx`. Save the result in the user's Drive and show it with a drive card.

## Setup

Check `micromamba env list` first. If there is no `docs` environment:

```bash
micromamba create -y -n docs --override-channels -c conda-forge python=3.12 python-pptx
```

If it exists but lacks the package, `micromamba install -y -n docs --override-channels -c conda-forge python-pptx`.
Run scripts with `micromamba run -n docs python make_deck.py`, and keep the script (for example in a
`.build/` folder) so a later "change slide 4" is a small edit and a rerun.

## Plan before building

Write the outline first: one sentence per slide saying what the audience should take from it.
A 10-minute talk is about 8–12 slides. Then build.

- One idea per slide; the title states it ("Sales grew 18% in Q3", not "Sales").
- At most about 6 bullets, each under a line and a half. Detail goes in the speaker notes.
- Body text 20 pt or larger, titles 32–40 pt. One font family, two or three colours.
- Numbers belong in a chart or a short table, not a paragraph.
- Open with a title slide; close with the ask, the decision or the next steps.

## Building

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)     # 16:9
TITLE, TITLE_AND_CONTENT, TITLE_ONLY, BLANK = (prs.slide_layouts[i] for i in (0, 1, 5, 6))

s = prs.slides.add_slide(TITLE)
s.shapes.title.text = 'Q3 review'
s.placeholders[1].text = 'Team update · 8 October 2026'

s = prs.slides.add_slide(TITLE_AND_CONTENT)
s.shapes.title.text = 'Sales grew 18% in Q3'
body = s.placeholders[1].text_frame
body.text = 'Two new markets opened'
for line in ['Returning customers up a third', 'Costs flat']:
    body.add_paragraph().text = line
for p in body.paragraphs:
    p.font.size = Pt(24)
s.notes_slide.notes_text_frame.text = 'Mention the Lisbon launch.'

s = prs.slides.add_slide(TITLE_ONLY)
s.shapes.title.text = 'Revenue by month'
data = CategoryChartData()
data.categories = ['Jul', 'Aug', 'Sep']
data.add_series('Revenue (k€)', (120, 135, 151))
s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.6), Inches(11.3), Inches(5.4), data)

# s.shapes.add_picture('photo.jpg', Inches(1), Inches(1.6), height=Inches(5.4))
prs.save('Q3 review.pptx')
```

The default template's layouts are plain. When the user has a template or an earlier deck, start
from it instead (`Presentation('their.pptx')`) and use its layouts, so their colours and fonts carry over.

## Reading and editing an existing deck

```python
from pptx import Presentation

prs = Presentation('deck.pptx')
for n, slide in enumerate(prs.slides, 1):
    texts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text]
    print(n, slide.slide_layout.name, texts)
```

Change text through the existing shapes' runs (as for Word documents) so formatting survives, and
save under a new name unless asked to overwrite. python-pptx cannot delete or reorder slides
directly; to drop one, remove its id from `prs.slides._sldIdLst` and say that is what you did.

## Check before reporting

Reopen the saved deck with the reading loop above and confirm the slide count, titles and that no
placeholder still shows template text ("Click to add title"). Long text does not shrink by itself:
if a bullet list exceeds about 6 lines at 24 pt, split the slide. There is no renderer here to look at
the slides, so say that the layout was checked by content, not by eye.
