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

/** Render a stored UTC timestamp for a human, in Philippine time (NFR_4.2). */
function toManila(utcIso, opts = {}) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a timestamp: ${utcIso}`);
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: DISPLAY_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    ...opts,
  }).format(d);
}

/** The Manila calendar date (YYYY-MM-DD) a stored UTC timestamp falls on. */
function manilaDate(utcIso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utcIso));
  return parts;
}

module.exports = { DISPLAY_ZONE, nowUtc, isUtcTimestamp, toManila, manilaDate };
