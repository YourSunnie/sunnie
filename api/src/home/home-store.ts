import type { Db } from '../db/database.ts';
import { knownTimeZone } from '../util/time.ts';
import { checkCardState } from './cards.ts';
import type { StateValue } from './formula.ts';
import { actionsOf, applyValues, checkFits, parseWidgetBody, withKeys, type WidgetAction, type WidgetBody, type WidgetValues } from './widgets.ts';

/** Who wrote a widget: Sunnie, or a program (the app's editor included) through the API. */
export const WIDGET_SOURCES = ['agent', 'api'] as const;
export type WidgetSource = (typeof WIDGET_SOURCES)[number];

/**
 * One block of the app's Home screen: a small tree of primitives (`widgets.ts`) that the agent
 * or a program wrote. The app has no widgets of its own: what is on Home is Sunnie's to decide.
 */
export interface HomeWidget {
  id: string;
  title: string;
  body: WidgetBody;
  /** What a tap on the widget does. */
  action: WidgetAction | null;
  /** How many of Home's four columns it spans: 4 is the full width, 1 a small tile. */
  columns: WidgetColumns;
  source: WidgetSource;
  hidden: boolean;
  /** When it goes away by itself; null stays until removed. */
  expiresAt: string | null;
  /** What the user set in its interactive parts; null while untouched. */
  state: Record<string, StateValue> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetWidgetInput {
  id: string;
  title?: string;
  /** JSON text or a value; checked against `widgets.ts`. */
  body: unknown;
  action?: WidgetAction | null;
  hours?: number;
  /** The id of the widget to sit above. Unset keeps an existing widget's place; a new one goes last. */
  before?: string;
  /** Unset keeps an existing widget's width; a new one is the full width. */
  columns?: number;
  source: WidgetSource;
}

/** New data for a widget, which keeps its design: see `applyValues`. */
export interface UpdateWidgetInput {
  id: string;
  values: WidgetValues;
  title?: string;
  /** From now; unset keeps when it expires. */
  hours?: number;
  source: WidgetSource;
}

/** Home is four columns across. */
export const HOME_COLUMNS = 4;
export type WidgetColumns = 1 | 2 | 3 | 4;

export interface HomeState {
  /** The user's zone as the app last reported it; the brief needs it to know when morning is. */
  timeZone: string | null;
  lastBriefAt: string | null;
  briefRunId: string | null;
}

const MAX_HOURS = 24 * 365;
const MAX_WIDGETS = 40;
/** A removed or expired widget keeps its row this long, so that writing it again puts it back where it was. */
const KEEP_PLACE_MS = 14 * 86_400_000;
const WIDGET_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function toWidget(r: Record<string, unknown>): HomeWidget {
  return {
    id: r.id as string,
    title: r.title as string,
    body: JSON.parse(r.body as string) as WidgetBody,
    action: r.action ? (JSON.parse(r.action as string) as WidgetAction) : null,
    columns: r.columns as WidgetColumns,
    source: r.source as WidgetSource,
    hidden: r.hidden === 1,
    expiresAt: r.expires_at as string | null,
    state: r.state ? (JSON.parse(r.state as string) as Record<string, StateValue>) : null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function fittingState(body: WidgetBody, state: Record<string, unknown>): Record<string, StateValue> | null {
  try { return checkCardState(body, state); }
  catch { return null; }
}

function expiry(hours: number | undefined, now: Date): string | null {
  return hours === undefined ? null : new Date(now.getTime() + Math.min(Math.max(hours, 0.25), MAX_HOURS) * 3_600_000).toISOString();
}

function cleanTitle(title: string | undefined): string {
  return (title ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function widgetColumns(columns: number): WidgetColumns {
  if (!Number.isInteger(columns) || columns < 1 || columns > HOME_COLUMNS) {
    throw new Error(`A widget is 1 to ${HOME_COLUMNS} columns wide: ${HOME_COLUMNS} is the full width of Home, 1 a small tile.`);
  }
  return columns as WidgetColumns;
}

/** A missing widget, as opposed to one that may not be changed that way. */
export class WidgetNotFound extends Error {
  constructor(id: string) {
    super(`There is no widget "${id}" on Home. home_list shows what is there.`);
  }
}

/** The calendar date and hour of `at` on the user's wall clock. */
export function localDay(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: knownTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** The Home screen's widgets, and when the agent last refreshed them. */
export class HomeStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private row(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM home_widgets WHERE id = ?').get(id);
  }

  private live(id: string, now: Date): Record<string, unknown> {
    const row = this.row(id);
    if (!row || (row.expires_at !== null && (row.expires_at as string) <= now.toISOString())) throw new WidgetNotFound(id);
    return row;
  }

  /** Gives every row a whole-numbered place again, in the order given. */
  private renumber(ids: string[]): void {
    const place = this.db.prepare('UPDATE home_widgets SET position = ? WHERE id = ?');
    ids.forEach((id, i) => place.run(i, id));
  }

  private order(): string[] {
    return this.db.prepare('SELECT id FROM home_widgets ORDER BY position, created_at').all().map((r) => r.id as string);
  }

  /**
   * Writes a widget whole: a new id adds one, a known id replaces its content and keeps its place
   * (and whether the user hid it).
   */
  set(input: SetWidgetInput, now = new Date()): HomeWidget {
    const id = input.id.trim().toLowerCase();
    if (!WIDGET_ID.test(id)) throw new Error('A widget id is a short name of lowercase letters, digits, "-" or "_", such as "steps" or "note-passport".');
    const body = withKeys(parseWidgetBody(input.body));
    if (actionsOf({ body, action: input.action }).some((a) => a.type === 'reply')) {
      throw new Error('A "reply" action sends a message in the chat its card is in, so it works only in a card in a reply. On Home, use "ask": it opens a chat with the words ready for the user to send.');
    }
    const existing = this.row(id);
    const at = now.toISOString();
    // A title is a name, not part of the design: left out, a known widget keeps its own.
    const title = input.title === undefined && existing ? (existing.title as string) : cleanTitle(input.title);
    const expiresAt = expiry(input.hours, now);
    const columns = input.columns === undefined ? null : widgetColumns(input.columns);
    checkFits(body, columns ?? (existing?.columns as number | undefined) ?? HOME_COLUMNS);
    const action = input.action ? JSON.stringify(input.action) : null;
    // What the user set survives a new design only while it still fits it.
    const state = existing?.state ? fittingState(body, JSON.parse(existing.state as string) as Record<string, unknown>) : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM home_widgets WHERE expires_at IS NOT NULL AND expires_at < ? AND id != ?')
        .run(new Date(now.getTime() - KEEP_PLACE_MS).toISOString(), id);
      if (existing) {
        this.db.prepare('UPDATE home_widgets SET title = ?, body = ?, action = ?, source = ?, expires_at = ?, columns = coalesce(?, columns), state = ?, updated_at = ? WHERE id = ?')
          .run(title, JSON.stringify(body), action, input.source, expiresAt, columns, state ? JSON.stringify(state) : null, at, id);
      } else {
        const count = this.db.prepare('SELECT count(*) AS n FROM home_widgets WHERE expires_at IS NULL OR expires_at > ?').get(at)!.n as number;
        if (count >= MAX_WIDGETS) throw new Error(`Home already holds ${MAX_WIDGETS} widgets. Remove one first.`);
        const last = this.db.prepare('SELECT coalesce(max(position), -1) AS p FROM home_widgets').get()!.p as number;
        this.db.prepare(
          'INSERT INTO home_widgets (id, title, body, action, source, position, hidden, expires_at, columns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
        ).run(id, title, JSON.stringify(body), action, input.source, last + 1, expiresAt, columns ?? HOME_COLUMNS, at, at);
      }
      if (input.before) this.place(id, input.before);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return toWidget(this.row(id)!);
  }

  /**
   * Changes what a widget shows and nothing else: its design, place, width, tap and whether it is
   * hidden stay as they are. This is how a widget is refreshed; `set` is for a new look.
   */
  update(input: UpdateWidgetInput, now = new Date()): HomeWidget {
    const id = input.id.trim().toLowerCase();
    const row = this.live(id, now);
    // A widget written before keys gets them now, named as `set` would have named them.
    const body = applyValues(withKeys(toWidget(row).body), input.values);
    checkFits(body, row.columns as number);
    const title = input.title === undefined ? (row.title as string) : cleanTitle(input.title);
    const expiresAt = input.hours === undefined ? (row.expires_at as string | null) : expiry(input.hours, now);
    this.db.prepare('UPDATE home_widgets SET title = ?, body = ?, source = ?, expires_at = ?, updated_at = ? WHERE id = ?')
      .run(title, JSON.stringify(body), input.source, expiresAt, now.toISOString(), id);
    return toWidget(this.row(id)!);
  }

  /** Keeps what the user set in a widget's interactive parts, checked against the widget. */
  setState(id: string, state: Record<string, unknown>, now = new Date()): HomeWidget {
    const row = this.live(id.trim().toLowerCase(), now);
    const checked = checkCardState(toWidget(row).body, state);
    this.db.prepare('UPDATE home_widgets SET state = ? WHERE id = ?').run(JSON.stringify(checked), row.id as string);
    return toWidget(this.row(row.id as string)!);
  }

  /** Puts `id` right above `before`; an unknown `before` leaves it where it is. */
  private place(id: string, before: string): void {
    const order = this.order().filter((other) => other !== id);
    const at = order.indexOf(before.trim().toLowerCase());
    if (at < 0) return;
    order.splice(at, 0, id);
    this.renumber(order);
  }

  /** The widgets still current, top to bottom, hidden ones included (the app's editor shows them). */
  widgets(now = new Date()): HomeWidget[] {
    return this.db
      .prepare('SELECT * FROM home_widgets WHERE expires_at IS NULL OR expires_at > ? ORDER BY position, created_at')
      .all(now.toISOString())
      .map(toWidget);
  }

  /**
   * Takes a widget off Home. Its row stays for a while as an expired one, so the same id written
   * again returns to its place.
   */
  remove(id: string, now = new Date()): void {
    this.live(id, now);
    this.db.prepare('UPDATE home_widgets SET expires_at = ?, updated_at = ? WHERE id = ?').run(now.toISOString(), now.toISOString(), id);
  }

  move(id: string, before: string | undefined, now = new Date()): HomeWidget {
    this.live(id, now);
    if (before) {
      this.live(before, now);
      this.place(id, before);
    } else {
      this.renumber([...this.order().filter((other) => other !== id), id]);
    }
    return toWidget(this.row(id)!);
  }

  /**
   * The width the user picked on Home, at once; `runId` is the run redesigning the widget for it,
   * so the app can show it as resizing until that run is done.
   */
  resize(id: string, columns: number, runId: string | null, now = new Date()): HomeWidget {
    this.live(id, now);
    this.db.prepare('UPDATE home_widgets SET columns = ?, resize_run_id = ? WHERE id = ?').run(widgetColumns(columns), runId, id);
    return toWidget(this.row(id)!);
  }

  /** Each widget's latest resizing run, by widget id. */
  resizeRuns(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, resize_run_id FROM home_widgets WHERE resize_run_id IS NOT NULL').all();
    return new Map(rows.map((r) => [r.id as string, r.resize_run_id as string]));
  }

  setHidden(id: string, hidden: boolean, now = new Date()): HomeWidget {
    this.live(id, now);
    this.db.prepare('UPDATE home_widgets SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
    return toWidget(this.row(id)!);
  }

  /**
   * The user's arrangement, as the app's editor saves it: `order` lists ids top to bottom (ids it
   * leaves out keep their order, below), `hidden` is the full set of hidden ids when given.
   */
  layout(input: { order?: string[]; hidden?: string[] }, now = new Date()): HomeWidget[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.order) {
        const all = this.order();
        const listed = [...new Set(input.order)].filter((id) => all.includes(id));
        this.renumber([...listed, ...all.filter((id) => !listed.includes(id))]);
      }
      if (input.hidden) {
        const hidden = new Set(input.hidden);
        const set = this.db.prepare('UPDATE home_widgets SET hidden = ? WHERE id = ?');
        for (const id of this.order()) set.run(hidden.has(id) ? 1 : 0, id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.widgets(now);
  }

  state(): HomeState {
    const row = this.db.prepare('SELECT * FROM home_state WHERE id = 1').get()!;
    return {
      timeZone: row.time_zone as string | null,
      lastBriefAt: row.last_brief_at as string | null,
      briefRunId: row.brief_run_id as string | null,
    };
  }

  /** Only a zone this runtime knows is kept; anything else would put the brief at a wrong hour. */
  setTimeZone(timeZone: string | undefined | null): void {
    if (!timeZone || knownTimeZone(timeZone) !== timeZone) return;
    this.db.prepare('UPDATE home_state SET time_zone = ? WHERE id = 1 AND time_zone IS NOT ?').run(timeZone, timeZone);
  }

  /** Written in the transaction that creates the run, so a restart cannot start a second brief that day. */
  markBrief(runId: string, at: string): void {
    this.db.prepare('UPDATE home_state SET last_brief_at = ?, brief_run_id = ? WHERE id = 1').run(at, runId);
  }

  /** Whether today's brief is still to come: past `hour` on the user's clock, and none yet today. */
  briefDue(now: Date, hour: number): boolean {
    const { timeZone, lastBriefAt } = this.state();
    if (!timeZone) return false;
    const today = localDay(now, timeZone);
    if (today.hour < hour) return false;
    return !lastBriefAt || localDay(new Date(lastBriefAt), timeZone).date !== today.date;
  }
}
