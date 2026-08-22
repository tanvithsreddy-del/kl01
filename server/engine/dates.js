function failure(code, message, extra = {}) { return { error: { code, message, ...extra } }; }

export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function validCivil(parts) {
  return Number.isInteger(parts.year) && Number.isInteger(parts.month) && Number.isInteger(parts.day)
    && parts.month >= 1 && parts.month <= 12 && parts.day >= 1 && parts.day <= daysInMonth(parts.year, parts.month)
    && Number.isInteger(parts.hour) && parts.hour >= 0 && parts.hour <= 23
    && Number.isInteger(parts.minute) && parts.minute >= 0 && parts.minute <= 59
    && Number.isInteger(parts.second) && parts.second >= 0 && parts.second <= 59
    && Number.isInteger(parts.millisecond) && parts.millisecond >= 0 && parts.millisecond <= 999;
}

function utcMs(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function parseOffset(raw) {
  if (!raw) return null;
  if (raw === 'Z' || raw === 'z') return 0;
  const match = raw.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[2]), minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  const total = hours * 60 + minutes;
  return match[1] === '-' ? -total : total;
}

export function parseDateInput(input) {
  const source = String(input ?? '').trim();
  const match = source.match(/^([+-]?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i);
  if (!match) return failure('DATE_SYNTAX', `cannot read date or time "${source}"`);
  const dateOnly = match[4] == null;
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: dateOnly ? 0 : Number(match[4]), minute: dateOnly ? 0 : Number(match[5]),
    second: match[6] == null ? 0 : Number(match[6]),
    millisecond: match[7] == null ? 0 : Number(match[7].padEnd(3, '0')),
  };
  if (!validCivil(parts)) return failure('DATE_INVALID', `invalid calendar date or time: ${source}`);
  const offsetMinutes = match[8] == null ? null : parseOffset(match[8]);
  if (match[8] != null && offsetMinutes == null) return failure('DATE_OFFSET', `invalid UTC offset in ${source}`);
  return { source, parts, dateOnly, offsetMinutes, explicitOffset: match[8] || null };
}

function formatterFor(tz, offset = false) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
      ...(offset ? { timeZoneName: 'longOffset' } : {}),
    });
  } catch {
    return null;
  }
}

function partsAt(ms, tz) {
  const formatter = formatterFor(tz);
  if (!formatter) throw Object.assign(new Error(`unknown time zone: ${tz}`), { code: 'DATE_TIME_ZONE' });
  const values = {};
  for (const item of formatter.formatToParts(new Date(ms))) if (item.type !== 'literal') values[item.type] = item.value;
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second), millisecond: new Date(ms).getUTCMilliseconds(),
  };
}

function offsetAt(ms, tz) {
  const formatter = formatterFor(tz, true);
  if (!formatter) throw Object.assign(new Error(`unknown time zone: ${tz}`), { code: 'DATE_TIME_ZONE' });
  const zone = formatter.formatToParts(new Date(ms)).find(part => part.type === 'timeZoneName')?.value || 'GMT';
  if (zone === 'GMT' || zone === 'UTC') return 0;
  const match = zone.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) throw Object.assign(new Error(`could not determine UTC offset for ${tz}`), { code: 'DATE_TIME_ZONE_OFFSET' });
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function sameWall(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function resolveLocal(parts, tz) {
  const rough = utcMs(parts);
  const offsets = new Set();
  for (let delta = -48; delta <= 48; delta += 6) offsets.add(offsetAt(rough + delta * 3600000, tz));
  const matches = [];
  for (const offset of offsets) {
    const candidate = rough - offset * 60000;
    const projected = partsAt(candidate, tz);
    if (sameWall(projected, parts) && projected.millisecond === parts.millisecond) matches.push(candidate);
  }
  const unique = [...new Set(matches)].sort((a, b) => a - b);
  if (!unique.length) throw Object.assign(new Error(`local time does not exist in ${tz} because of a clock change`), { code: 'DATE_NONEXISTENT_LOCAL_TIME' });
  if (unique.length > 1) throw Object.assign(new Error(`local time occurs twice in ${tz}; include an explicit UTC offset to disambiguate it`), { code: 'DATE_AMBIGUOUS_LOCAL_TIME' });
  return unique[0];
}

function instantFor(parsed, tz) {
  if (parsed.offsetMinutes != null) return utcMs(parsed.parts) - parsed.offsetMinutes * 60000;
  if (parsed.dateOnly) return null;
  return resolveLocal(parsed.parts, tz);
}

function civilDayNumber(parts) {
  return Math.floor(utcMs({ ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 }) / 86400000);
}

function signedDurationParts(deltaMs) {
  const sign = deltaMs < 0 ? -1 : deltaMs > 0 ? 1 : 0;
  let rest = Math.abs(deltaMs);
  const days = Math.floor(rest / 86400000); rest -= days * 86400000;
  const hours = Math.floor(rest / 3600000); rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000); rest -= minutes * 60000;
  const seconds = Math.floor(rest / 1000); rest -= seconds * 1000;
  return { sign, days, hours, minutes, seconds, milliseconds: rest, totalMilliseconds: deltaMs, totalHours: deltaMs / 3600000 };
}

function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const n = Math.abs(minutes);
  return `${sign}${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function between(a, b, tz = 'UTC') {
  const first = parseDateInput(a); if (first.error) return first;
  const second = parseDateInput(b); if (second.error) return second;
  try {
    // Validate the zone even when explicit offsets make the arithmetic independent of it.
    offsetAt(0, tz);
    if (first.dateOnly && second.dateOnly) {
      const deltaDays = civilDayNumber(second.parts) - civilDayNumber(first.parts);
      return {
        parts: { sign: Math.sign(deltaDays), days: Math.abs(deltaDays), hours: 0, minutes: 0, seconds: 0, milliseconds: 0, totalDays: deltaDays, totalMilliseconds: deltaDays * 86400000 },
        steps: [`Validate both dates in the Gregorian calendar.`, `Count calendar-day boundaries from ${first.source} to ${second.source}: ${deltaDays} day${Math.abs(deltaDays) === 1 ? '' : 's'}.`],
      };
    }
    if (first.dateOnly !== second.dateOnly) return failure('DATE_KIND_MISMATCH', 'compare two dates or two date-times; do not mix a date-only value with a time value');
    const firstMs = instantFor(first, tz), secondMs = instantFor(second, tz);
    const delta = secondMs - firstMs;
    const parts = signedDurationParts(delta);
    const firstOffset = offsetAt(firstMs, tz), secondOffset = offsetAt(secondMs, tz);
    return {
      parts,
      steps: [
        `Resolve the first time to an instant; ${tz} is UTC${offsetLabel(firstOffset)} at that instant.`,
        `Resolve the second time to an instant; ${tz} is UTC${offsetLabel(secondOffset)} at that instant.`,
        `Subtract the instants: ${parts.sign < 0 ? '-' : ''}${parts.days}d ${parts.hours}h ${parts.minutes}m ${parts.seconds}s ${parts.milliseconds}ms elapsed.`,
      ],
    };
  } catch (cause) {
    return failure(cause.code || 'DATE_TIME_ZONE', cause.message || 'date calculation failed');
  }
}

export function addDate(input, duration = {}, tz = 'UTC') {
  const parsed = parseDateInput(input); if (parsed.error) return parsed;
  if (!parsed.dateOnly && parsed.offsetMinutes == null) {
    try { resolveLocal(parsed.parts, tz); } catch (cause) { return failure(cause.code || 'DATE_TIME_ZONE', cause.message); }
  }
  const months = Number(duration.months || 0), days = Number(duration.days || 0);
  if (!Number.isInteger(months) || !Number.isInteger(days)) return failure('DATE_DURATION', 'months and days must be whole numbers');
  let year = parsed.parts.year;
  let monthIndex = parsed.parts.month - 1 + months;
  year += Math.floor(monthIndex / 12);
  monthIndex %= 12;
  if (monthIndex < 0) { monthIndex += 12; year -= 1; }
  const month = monthIndex + 1;
  const targetDay = Math.min(parsed.parts.day, daysInMonth(year, month));
  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, targetDay);
  base.setUTCHours(parsed.parts.hour, parsed.parts.minute, parsed.parts.second, parsed.parts.millisecond);
  base.setUTCDate(base.getUTCDate() + days);
  const output = {
    year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(),
    hour: parsed.parts.hour, minute: parsed.parts.minute, second: parsed.parts.second, millisecond: parsed.parts.millisecond,
  };
  const dateText = `${String(output.year).padStart(4, '0')}-${String(output.month).padStart(2, '0')}-${String(output.day).padStart(2, '0')}`;
  const wallText = `${dateText}T${String(output.hour).padStart(2, '0')}:${String(output.minute).padStart(2, '0')}:${String(output.second).padStart(2, '0')}`;
  if (!parsed.dateOnly && parsed.offsetMinutes == null) {
    try { resolveLocal(output, tz); }
    catch (cause) { return failure(cause.code || 'DATE_TIME_ZONE', cause.message || 'target local time could not be resolved'); }
  }
  const value = parsed.dateOnly ? dateText : `${wallText}${parsed.explicitOffset || ''}`;
  const clamped = targetDay !== parsed.parts.day;
  return {
    value,
    steps: [
      `Move ${months} month${Math.abs(months) === 1 ? '' : 's'} from ${parsed.source}.`,
      ...(clamped ? [`The target month has only ${daysInMonth(year, month)} days, so clamp day ${parsed.parts.day} to ${targetDay}.`] : []),
      ...(days ? [`Then move ${days} calendar day${Math.abs(days) === 1 ? '' : 's'}.`] : []),
      ...(!parsed.dateOnly && parsed.offsetMinutes == null ? [`Confirm that ${wallText} occurs exactly once in ${tz}.`] : []),
      `Result: ${value}.`,
    ],
  };
}

export const add = addDate;

export function weekday(input, tz = 'UTC') {
  const parsed = parseDateInput(input); if (parsed.error) return parsed;
  try {
    let ms;
    if (parsed.dateOnly) ms = utcMs(parsed.parts);
    else ms = instantFor(parsed, tz);
    const name = new Intl.DateTimeFormat('en-IN', { timeZone: parsed.dateOnly ? 'UTC' : tz, weekday: 'long' }).format(new Date(ms));
    return { value: name, steps: [`Validate ${parsed.source} in the Gregorian calendar.`, `Its weekday is ${name}.`] };
  } catch (cause) {
    return failure(cause.code || 'DATE_TIME_ZONE', cause.message || 'weekday calculation failed');
  }
}

export function zoneOffset(input, tz) {
  const parsed = parseDateInput(input); if (parsed.error) return parsed;
  try {
    const ms = parsed.dateOnly ? utcMs(parsed.parts) : instantFor(parsed, tz);
    const minutes = offsetAt(ms, tz);
    return { value: offsetLabel(minutes), steps: [`At ${parsed.source}, ${tz} is UTC${offsetLabel(minutes)}.`] };
  } catch (cause) {
    return failure(cause.code || 'DATE_TIME_ZONE', cause.message || 'time-zone offset calculation failed');
  }
}

export const dateInternals = Object.freeze({ validCivil, utcMs, offsetAt, resolveLocal, civilDayNumber, signedDurationParts, partsAt });
