import { z } from 'zod';
import type { Db } from '../db/database.ts';
import { nowIso } from '../util/ids.ts';

// What the user's iPhone shares with the agent: a copy of a few of its own records, sent by the
// app when it is opened. Each source keeps only its latest snapshot; turning a source off in the
// app deletes it here. The phone decides what is sent; this file decides what is accepted.

export const PHONE_SOURCES = ['health', 'calendar', 'reminders', 'location', 'contacts', 'places', 'music', 'photos'] as const;
export type PhoneSource = (typeof PHONE_SOURCES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.iso.datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day is YYYY-MM-DD');
const amount = z.number().finite().min(0).max(1_000_000);

const value = z.number().finite();
const hours = z.number().finite().min(0).max(48);

/**
 * Everything Health lets the user share, a day at a time. Types are not listed here: the phone
 * sends whichever of HealthKit's types hold data, named and in the user's own units, so a type
 * Apple adds later needs no server change.
 */
const health = z.object({
  profile: z
    .object({
      birthDate: day.optional(),
      sex: text(40).optional(),
      bloodType: text(10).optional(),
      skinType: text(40).optional(),
      wheelchair: z.boolean().optional(),
    })
    .optional(),
  /** Quantities (steps, heart rate, weight, nutrients, …): a day's total, or its average with the range. */
  metrics: z
    .array(z.object({
      type: text(80),
      name: text(80),
      unit: text(30),
      aggregation: z.enum(['sum', 'average']),
      days: z.array(z.object({ date: day, value, min: value.optional(), max: value.optional() })).max(400),
    }))
    .max(200)
    .default([]),
  /** Events and logged states (symptoms, mindful minutes, cycle tracking, …), counted per day. */
  categories: z
    .array(z.object({
      type: text(80),
      name: text(80),
      days: z.array(z.object({
        date: day,
        count: z.number().int().min(0).max(100_000),
        minutes: amount.optional(),
        values: z.array(text(40)).max(12).optional(),
      })).max(400),
    }))
    .max(120)
    .default([]),
  /** One line per night, on the day it ended. */
  sleep: z
    .array(z.object({
      date: day,
      asleepHours: hours,
      inBedHours: hours.optional(),
      coreHours: hours.optional(),
      deepHours: hours.optional(),
      remHours: hours.optional(),
      awakeHours: hours.optional(),
      start: instant.optional(),
      end: instant.optional(),
    }))
    .max(400)
    .default([]),
  /** State of Mind entries logged in Health or the Mindfulness app. */
  moods: z
    .array(z.object({
      at: instant,
      kind: z.enum(['momentary', 'daily']),
      valence: z.number().min(-1).max(1),
      labels: z.array(text(40)).max(20).default([]),
      associations: z.array(text(40)).max(20).default([]),
    }))
    .max(1000)
    .default([]),
  workouts: z
    .array(z.object({ type: text(60), start: instant, minutes: amount, energyKcal: amount.optional(), distanceKm: amount.optional() }))
    .max(500)
    .default([]),
});

const calendar = z.object({
  events: z
    .array(z.object({
      title: text(200),
      start: instant,
      end: instant.optional(),
      allDay: z.boolean().default(false),
      location: text(300).optional(),
      calendar: text(100).optional(),
      notes: text(500).optional(),
    }))
    .max(400),
});

const reminders = z.object({
  items: z
    .array(z.object({
      title: text(300),
      due: instant.optional(),
      /** The due date has no time of day. */
      allDay: z.boolean().optional(),
      list: text(100).optional(),
      /** As Reminders has it: 1 is high, 5 medium, 9 low, 0 none. */
      priority: z.number().int().min(0).max(9).optional(),
      notes: text(500).optional(),
    }))
    .max(400),
});

const location = z.object({
  /** The town or neighbourhood, as the phone names it; never a street address. */
  place: text(120),
  region: text(120).optional(),
  country: text(80).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const labelled = z.object({ label: text(60).optional(), value: text(200) });

/** The address book: who people are to the user, and how to reach them. */
const contacts = z.object({
  contacts: z
    .array(z.object({
      name: text(200),
      nickname: text(100).optional(),
      organization: text(200).optional(),
      jobTitle: text(200).optional(),
      phones: z.array(labelled).max(10).default([]),
      emails: z.array(labelled).max(10).default([]),
      /** "YYYY-MM-DD", or "--MM-DD" when the year is not known. */
      birthday: z.string().regex(/^(\d{4}-|--)\d{2}-\d{2}$/).optional(),
      /** "mother: Rina", as the user labelled the people around this contact. */
      relations: z.array(z.object({ label: text(60), name: text(200) })).max(10).default([]),
      city: text(120).optional(),
    }))
    .max(5000),
});

/** Places the phone stayed at, from iOS's visit log. */
const places = z.object({
  visits: z
    .array(z.object({
      arrival: instant,
      departure: instant.optional(),
      place: text(200).optional(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }))
    .max(1000),
});

const song = z.object({
  title: text(200),
  artist: text(200).optional(),
  album: text(200).optional(),
  genre: text(100).optional(),
  plays: z.number().int().min(0).optional(),
  lastPlayed: instant.optional(),
});
const tally = z.object({ name: text(200), plays: z.number().int().min(0) });

/** The music library on the phone: what is played most and lately. */
const music = z.object({
  recent: z.array(song).max(100).default([]),
  top: z.array(song).max(100).default([]),
  artists: z.array(tally).max(50).default([]),
  genres: z.array(tally).max(30).default([]),
});

/** The photo library, a day at a time: how much was taken and where. No pictures. */
const photos = z.object({
  total: z.number().int().min(0),
  days: z
    .array(z.object({
      date: day,
      photos: z.number().int().min(0),
      videos: z.number().int().min(0),
      favorites: z.number().int().min(0).default(0),
      places: z.array(text(120)).max(10).default([]),
    }))
    .max(400),
});

export const PHONE_SCHEMAS = { health, calendar, reminders, location, contacts, places, music, photos } as const;

export type PhoneData = {
  health: z.infer<typeof health>;
  calendar: z.infer<typeof calendar>;
  reminders: z.infer<typeof reminders>;
  location: z.infer<typeof location>;
  contacts: z.infer<typeof contacts>;
  places: z.infer<typeof places>;
  music: z.infer<typeof music>;
  photos: z.infer<typeof photos>;
};

/** What the app sends for one source. */
export const phoneSnapshot = z.object({
  capturedAt: instant,
  /** The phone's zone, so times read as the user lives them. */
  timeZone: z.string().max(80).optional(),
  data: z.unknown(),
});

export interface PhoneSnapshot<S extends PhoneSource = PhoneSource> {
  source: S;
  capturedAt: string;
  timeZone?: string;
  data: PhoneData[S];
  updatedAt: string;
}

/** A source as the app lists it: when it was last sent and how much it holds. */
export interface PhoneSourceStatus {
  source: PhoneSource;
  capturedAt: string;
  updatedAt: string;
  count: number;
}

export class PhoneStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Replaces the source's snapshot. Throws an `Error` that says what is wrong with the data. */
  put(source: PhoneSource, input: { capturedAt: string; timeZone?: string; data: unknown }): PhoneSourceStatus {
    const parsed = PHONE_SCHEMAS[source].safeParse(input.data);
    if (!parsed.success) throw new Error(`The ${source} data is not right:\n${z.prettifyError(parsed.error)}`);
    const capturedAt = new Date(input.capturedAt).toISOString();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO phone_data (source, data, time_zone, captured_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET data = excluded.data, time_zone = excluded.time_zone,
           captured_at = excluded.captured_at, updated_at = excluded.updated_at`,
      )
      .run(source, JSON.stringify(parsed.data), input.timeZone ?? null, capturedAt, now);
    return status(this.get(source)!);
  }

  get<S extends PhoneSource>(source: S): PhoneSnapshot<S> | null {
    const row = this.db.prepare('SELECT * FROM phone_data WHERE source = ?').get(source);
    if (!row) return null;
    return {
      source,
      data: JSON.parse(row.data as string) as PhoneData[S],
      ...(row.time_zone ? { timeZone: row.time_zone as string } : {}),
      capturedAt: row.captured_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  list(): PhoneSourceStatus[] {
    return PHONE_SOURCES.flatMap((source) => {
      const snapshot = this.get(source);
      return snapshot ? [status(snapshot)] : [];
    });
  }

  remove(source: PhoneSource): boolean {
    return this.db.prepare('DELETE FROM phone_data WHERE source = ?').run(source).changes > 0;
  }
}

function status(s: PhoneSnapshot): PhoneSourceStatus {
  const data = s.data as Partial<PhoneData[PhoneSource]> & Record<string, unknown>;
  const count = s.source === 'health'
    // Kinds of data: each measured type and logged category, and sleep, moods and workouts as one each.
    ? ((data.metrics as unknown[] | undefined)?.length ?? 0) + ((data.categories as unknown[] | undefined)?.length ?? 0)
      + (['sleep', 'moods', 'workouts'] as const).filter((k) => ((data[k] as unknown[] | undefined)?.length ?? 0) > 0).length
    : Array.isArray(data.events) ? data.events.length
    : Array.isArray(data.items) ? data.items.length
    : Array.isArray(data.contacts) ? data.contacts.length
    : Array.isArray(data.visits) ? data.visits.length
    : s.source === 'music' ? ((data.recent as unknown[] | undefined)?.length ?? 0) + ((data.top as unknown[] | undefined)?.length ?? 0)
    : s.source === 'photos' ? (data.total as number)
    : 1;
  return { source: s.source, capturedAt: s.capturedAt, updatedAt: s.updatedAt, count };
}
