import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { interpolate, parseFormula, type StateValue } from '../src/home/formula.ts';
import { amountOf, checkFits, initialState, parseWidgetBody } from '../src/home/widgets.ts';

// The same cases the app's FormulaTests run: what the server checks is what the app shows.
const cases = JSON.parse(readFileSync(new URL('../../app/Sunnie/SunnieTests/FormulaCases.json', import.meta.url), 'utf8')) as {
  state: Record<string, StateValue>;
  interpolate: Array<[string, string]>;
  invalid: string[];
};

test('formulas show the same values the app shows', () => {
  for (const [text, expected] of cases.interpolate) {
    assert.equal(interpolate(text, cases.state), expected, text);
  }
  for (const source of cases.invalid) assert.throws(() => parseFormula(source), source);
});

const planner = {
  type: 'stack',
  children: [
    { type: 'stepper', bind: 'people', value: 5, min: 2, max: 16, label: 'People' },
    { type: 'segmented', bind: 'view', options: ['Shopping', { value: 'timeline', label: 'Timeline' }] },
    { type: 'fields', when: "view == 'Shopping'", items: [{ label: 'Lamb', value: '{round(people * 0.4, 1)} kg' }, { label: 'Potatoes', value: '{people * 300} g' }] },
    { type: 'checklist', bind: 'done', when: "view == 'timeline'", items: [{ time: '12:30', title: 'Prepare the lamb' }, { time: '13:30', title: 'Start roasting' }] },
    { type: 'progress', value: '{done / 2}', label: '{done} of 2 done' },
  ],
};

test('a widget with inputs starts from their values and checks every formula against its names', () => {
  const body = parseWidgetBody(planner);
  assert.deepEqual(initialState(body), { people: 5, view: 'Shopping', done: [false, false] });
  assert.equal(amountOf('{done / 2}', { done: [true, false] }), 0.5);
  assert.equal(amountOf('done / 2', { done: [true, true, true] }), 1, 'kept within 0…1, braces optional');

  assert.throws(() => parseWidgetBody({ ...planner, children: [...planner.children, { type: 'text', text: '{guests * 2}' }] }),
    /"guests", which nothing in the widget sets[\s\S]*people, view, done/);
  assert.throws(() => parseWidgetBody({ type: 'text', text: 'x', when: 'tab ==' }), /"tab ==" in a text part's "when" does not read/);
  assert.throws(() => parseWidgetBody({ type: 'stack', children: [{ type: 'stack', state: { a: 1 }, children: [{ type: 'text', text: '{a}' }] }] }),
    /Only the outermost part/);
  // Declared state works for names no input sets; paths and icons are never read as formulas.
  parseWidgetBody({ type: 'stack', state: { rate: 0.2 }, children: [{ type: 'text', text: '{rate * 100}%' }, { type: 'icon', name: '{x}' }] });
  assert.throws(() => checkFits(body, 1), /no .*stepper/);
});
