'use strict';

// VR-102: timestamps are stored as ISO-8601 UTC text and rendered in Asia/Manila.
// There is no local-time write path anywhere in the application — every _at column
// is fed from nowUtc(), and the Manila conversion happens at read time only.

const DISPLAY_ZONE = 'Asia/Manila';

/** The only timestamp source for anything persisted. Always UTC, always 'Z'. */
function nowUtc() {
  return new Date().toISOString();
}

/** True when a value is the ISO-8601 UTC form this system stores. */
function isUtcTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

// ## Philippine time by arithmetic, not by Intl
//
// Philippine Standard Time is UTC+8 all year: the country last observed daylight saving
// in 1990 (21 May – 28 July), so for every instant since — and every timestamp this
// product has stored or ever will — Manila time is the UTC instant plus eight hours. It used to come from `Intl.DateTimeFormat` with
// `timeZone: 'Asia/Manila'`, which needs ICU's time-zone data — and the Node that runs
// inside the Android app (nodejs-mobile) ships with **no ICU data at all**. There,
// the first date a screen asked for threw, which was the red error after sign-in on
// the phone (TASK-049). Arithmetic needs no data, gives the same answer on every
// platform, and `clock.test.js` holds it to Intl's own answer wherever Intl has one.
//
// It also fixes a quirk the Intl version had: `hour12: false` in `en-PH` picks a
// 1–24 clock, so a minute past midnight printed as "24:01". It prints "00:01" now.

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (n) => String(n).padStart(2, '0');

/** The Manila wall-clock fields of a stored UTC timestamp. */
function manilaFields(utcIso) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a timestamp: ${utcIso}`);
  const m = new Date(d.getTime() + MANILA_OFFSET_MS);
  return {
    year: String(m.getUTCFullYear()).padStart(4, '0'),
    month: two(m.getUTCMonth() + 1),
    day: two(m.getUTCDate()),
    hour: two(m.getUTCHours()),
    minute: two(m.getUTCMinutes()),
    second: two(m.getUTCSeconds()),
  };
}

/** Render a stored UTC timestamp for a human, in Philippine time (NFR_4.2): MM/DD/YYYY, HH:MM:SS. */
function toManila(utcIso) {
  const f = manilaFields(utcIso);
  return `${f.month}/${f.day}/${f.year}, ${f.hour}:${f.minute}:${f.second}`;
}

/** The Manila calendar date (YYYY-MM-DD) a stored UTC timestamp falls on. */
function manilaDate(utcIso) {
  const f = manilaFields(utcIso);
  return `${f.year}-${f.month}-${f.day}`;
}

module.exports = { DISPLAY_ZONE, nowUtc, isUtcTimestamp, toManila, manilaDate };
