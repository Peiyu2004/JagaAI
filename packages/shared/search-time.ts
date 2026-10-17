const HOUR = 3_600_000, DAY = 24 * HOUR;
function number(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const match = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (match) return (match[1] ? digits[match[1]] : 1) * 10 + (match[2] ? digits[match[2]] : 0);
  return digits[value];
}
export function parseSearchTime(query: string, at = Date.now()) {
  const lower = query.toLowerCase(), local = new Date(at + 8 * HOUR);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * HOUR;
  let start: number | undefined, end: number | undefined, label = '', relative = false;
  if (/last night|yesterday evening|昨晚|昨天晚上/.test(lower)) { start = midnight - 6 * HOUR; end = midnight + 6 * HOUR; label = 'Yesterday evening'; relative = true; }
  else if (/yesterday|昨天/.test(lower)) { start = midnight - DAY; end = midnight; label = 'Yesterday'; relative = true; }
  else if (/this morning|今早|今天早上/.test(lower)) { start = midnight; end = midnight + 12 * HOUR; label = 'This morning'; relative = true; }
  else if (/today|今天/.test(lower)) { start = midnight; end = midnight + DAY; label = 'Today'; relative = true; }
  else if (/last week|上周|上星期/.test(lower)) { start = midnight - 7 * DAY; end = midnight; label = 'Previous seven days'; relative = true; }
  const explicit = lower.match(/\b(20\d\d)-(\d{2})-(\d{2})\b/);
  if (explicit) {
    const iso = `${explicit[1]}-${explicit[2]}-${explicit[3]}T00:00:00+08:00`, candidate = Date.parse(iso);
    if (!Number.isFinite(candidate) || new Date(candidate + 8 * HOUR).toISOString().slice(0, 10) !== iso.slice(0, 10)) throw new Error('The query contains an invalid calendar date.');
    start = candidate; end = start + DAY; label = explicit[0];
  }
  const clock = lower.replace(explicit?.[0] || /$^/, ' ').match(/([\d零一二两三四五六七八九十]{1,3})(?::(\d{2}))?\s*(?:点|時|时|h)?\s*(am|pm)?\s*(?:到|至|\s+to\s+|\s*[-–]\s*)([\d零一二两三四五六七八九十]{1,3})(?::(\d{2}))?\s*(?:点|時|时|h)?\s*(am|pm)?/);
  let clockText = '';
  if (clock && !/^20\d\d-/.test(clock[0])) {
    let h1 = number(clock[1]), h2 = number(clock[4]); const m1 = Number(clock[2] || 0), m2 = Number(clock[5] || 0);
    const morning = /凌晨|早上|morning/.test(lower);
    const evening = !morning && /昨晚|晚上|傍晚|last night|evening/.test(lower), ampm1 = clock[3] || clock[6], ampm2 = clock[6] || clock[3];
    if (ampm1 === 'pm' || (!ampm1 && evening)) { if (h1 < 12) h1 += 12; }
    if (ampm2 === 'pm' || (!ampm2 && evening)) { if (h2 < 12) h2 += 12; }
    if (ampm1 === 'am' && h1 === 12) h1 = 0;
    if (ampm2 === 'am' && h2 === 12) h2 = 0;
    if (![h1, h2].every(h => Number.isInteger(h) && h >= 0 && h < 24) || m1 > 59 || m2 > 59) throw new Error('The query contains an invalid clock range.');
    let day = explicit ? start! : /last night|yesterday|昨晚|昨天/.test(lower) ? midnight - DAY : start;
    if (!explicit && /last night|yesterday evening|昨晚|昨天晚上/.test(lower) && h1 < 6) day = midnight;
    if (day === undefined) { day = midnight; relative = true; label = 'Assumed today; confirm the date'; }
    if (/last week|上周|上星期/.test(lower)) throw new Error('Choose a specific calendar date for the clock range.');
    start = day + h1 * HOUR + m1 * 60_000; end = day + h2 * HOUR + m2 * 60_000;
    if (end <= start) end += DAY;
    clockText = clock[0];
  }
  if (start === undefined || end === undefined) return undefined;
  return { timeFrom: new Date(start).toISOString(), timeTo: new Date(end).toISOString(), timeZone: 'Asia/Kuala_Lumpur', label, relative,
    visualQuery: query.replace(clockText ? new RegExp(clockText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : /$^/, ' ').replace(explicit?.[0] || /$^/, ' ').replace(/last night|yesterday evening|yesterday|this morning|today|last week|昨晚|昨天晚上|今天早上|昨天|今天|今早|上周|上星期/gi, ' ').trim() };
}
