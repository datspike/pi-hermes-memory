/** Invalid lower bounds are request failures, never evidence of an empty archive. */
export class SessionSearchSinceError extends Error {
  constructor(public readonly code: 'INVALID_SINCE' | 'SINCE_IN_FUTURE', message: string) {
    super(message);
    this.name = 'SessionSearchSinceError';
  }
}

/** Validate a calendar date or timezone-qualified ISO instant, then normalize to UTC milliseconds. */
export function normalizeSessionSearchSince(value: string | undefined, now = Date.now()): string | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new SessionSearchSinceError('INVALID_SINCE', 'since must be a valid YYYY-MM-DD date or ISO timestamp with Z or a timezone offset; omit it to search without a date filter.');
  if (typeof value !== 'string') throw invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) throw invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw invalid();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) throw invalid();
    const zone = match[8];
    if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) throw invalid();
  }
  const instant = Date.parse(match[4] === undefined ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(instant)) throw invalid();
  if (instant > now) throw new SessionSearchSinceError('SINCE_IN_FUTURE', 'since is later than the current time. Future lower bounds are not supported for past-session search; use a past date or omit since.');
  const utc = new Date(instant).toISOString();
  if (!/^\d{4}-/.test(utc)) throw invalid();
  return utc;
}

/** Compare canonical timestamps as instants, not lexicographic timezone spellings. */
export function matchesSessionSearchSince(timestamp: string | null, since: string | undefined): boolean {
  if (since === undefined) return true;
  return timestamp !== null && Date.parse(timestamp) >= Date.parse(since);
}
