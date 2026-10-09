---
name: excel
description: "Create, read, clean and analyse spreadsheets (.xlsx, .csv): budgets, trackers, lists, invoices, data exports. Use when the user asks for a spreadsheet or Excel file, shares one to read, total, chart or tidy up, or wants data put into a table they can open in Excel, Numbers or Google Sheets."
---

# Spreadsheets

Use `pandas` to read and analyse data and `openpyxl` to write a workbook a person will use
(formatting, formulas, frozen headers). Save the result in the user's Drive and show it with a drive card.

## Setup

Check `micromamba env list` first. If there is no `docs` environment:

```bash
micromamba create -y -n docs --override-channels -c conda-forge python=3.12 pandas openpyxl
```

If it exists but lacks a package, `micromamba install -y -n docs --override-channels -c conda-forge pandas openpyxl`.
Run scripts with `micromamba run -n docs python script.py`.

## Reading

```python
import pandas as pd
sheets = pd.read_excel('in.xlsx', sheet_name=None)      # {sheet name: DataFrame}
for name, df in sheets.items():
    print(name, df.shape); print(df.head(10).to_string())
```

- A CSV: `pd.read_csv(path)`; if the text looks garbled try `encoding='latin-1'`, and `sep=';'`
  for European exports.
- Header rows that are not on the first line: look at the raw rows first (`header=None`), then
  pass `header=<row>` or `skiprows`.
- Formulas: `openpyxl.load_workbook(path)` shows them; `load_workbook(path, data_only=True)`
  shows the values Excel last saved (None when the file was never opened in a spreadsheet app).

Before answering a question about the data, say what you looked at (sheet, rows, columns) and
check totals another way when the answer matters.

## Writing a workbook for a person

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = 'Budget'
ws.append(['Item', 'Category', 'Amount'])
rows = [('Rent', 'Home', 950), ('Groceries', 'Food', 320.5)]
for row in rows:
    ws.append(row)
last = ws.max_row
ws.append(['Total', None, f'=SUM(C2:C{last})'])          # a formula, so edits update it

for cell in ws[1]:
    cell.font = Font(bold=True)
    cell.fill = PatternFill('solid', fgColor='DDEBF7')
ws[f'A{last + 1}'].font = Font(bold=True)
for row in ws.iter_rows(min_row=2, min_col=3, max_col=3):
    for cell in row:
        cell.number_format = '#,##0.00 [$€-x-euro2]'     # or '#,##0.00' / '"$"#,##0.00'
ws.freeze_panes = 'A2'
ws.auto_filter.ref = f'A1:C{last}'
for column, width in zip('ABC', (24, 16, 14)):
    ws.column_dimensions[column].width = width

wb.save('Budget.xlsx')
```

Guidelines:
- One table per sheet, starting at A1, one header row, no blank rows or merged cells inside it.
- Totals and derived columns as formulas (`=SUM`, `=B2*C2`), not typed numbers, so the sheet stays
  right when the user edits it. openpyxl does not calculate them; when you need the value yourself,
  compute it in Python too.
- Dates as real dates (`datetime.date`) with `number_format = 'yyyy-mm-dd'` or the user's style,
  money with a currency format, percentages as fractions with `'0.0%'`.
- A sheet named for what it holds; a short `Notes` sheet when assumptions need explaining.
- A quick table of data with no formatting needs: `df.to_excel('out.xlsx', index=False)`.
- CSV for another program: `df.to_csv('out.csv', index=False, encoding='utf-8-sig')` (the BOM makes
  Excel read accents correctly).

Charts: `openpyxl.chart` (`BarChart`, `LineChart`, `PieChart` with `Reference` ranges) puts a live
chart in the workbook; place it beside the table (`ws.add_chart(chart, 'E2')`).

## Check before reporting

Reopen the saved file and print it:

```bash
micromamba run -n docs python -c "import openpyxl,sys; ws=openpyxl.load_workbook(sys.argv[1]).active; [print(r) for r in ws.iter_rows(values_only=True)]" Budget.xlsx
```

Confirm the formulas point at the right ranges and the headers and numbers are where they belong,
then tell the user what each sheet holds.
