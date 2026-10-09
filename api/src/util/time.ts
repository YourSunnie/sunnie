/** The zone used when a client has not said where the user is. */
export function serverTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `timeZone` if it is a zone this runtime knows, otherwise the server's own. */
export function knownTimeZone(timeZone?: string | null): string {
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone });
      return timeZone;
    } catch {
      // An unknown IANA zone from the client should not fail the turn.
    }
  }
  return serverTimeZone();
}

/** A moment as the user reads it: "Thursday 1 October 2026 at 14:05 GMT+7". */
export function formatTime(at: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: knownTimeZone(timeZone),
  }).format(at);
}

/** The wall clock of `at` in `timeZone`, read back as if it were UTC. */
function wallClock(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
}

/**
 * Reads "YYYY-MM-DD HH:MM" as a wall-clock time in `timeZone`. Null if the text is not in that
 * form or is not a real date.
 */
export function parseLocalTime(text: string, timeZone?: string | null): Date | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;

  const zone = knownTimeZone(timeZone);
  // The zone's offset depends on the instant, which is what we are solving for: estimate with
  // the offset at the wall time, then correct once with the offset at the estimate (DST edges).
  let at = wall - (wallClock(new Date(wall), zone) - wall);
  at = wall - (wallClock(new Date(at), zone) - at);
  return new Date(at);
}
