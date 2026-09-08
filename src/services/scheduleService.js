'use strict';

// OPS-001's other half — the backup at the configured daily hour.
//
// TASK-017's constraint says the daily backup is "scheduled in the Electron main
// process and must survive the renderer being closed". The server already runs *in*
// the Electron main process (main.js calls server.ensureStarted), so scheduling it
// here satisfies both halves of that and keeps main.js as the only file in the product
// that knows Electron exists (05_TECH_SPEC.md §1). It also means the schedule runs
// under `npm start` and inside the test suite, which a timer in main.js would not.
//
// ## Why a one-minute tick and not a timer to the hour
//
// A `setTimeout` of eleven hours does not survive the machine sleeping, and a store PC
// is switched off every night. On waking, a long timer fires late or not at all, and
// the backup that should have run at 21:00 silently does not. A short tick that asks
// "has the hour passed and have we not run today" is dull and correct: the answer
// after a sleep is yes, and it runs immediately.
//
// The check is against the **backup log**, not against a variable, for the same
// reason. A process restarted at 21:05 must not run a second backup because its
// in-memory "last run" was lost, and must run one if the process that should have done
// it at 21:00 was not running.

const clock = require('../config/clock');
const settingsService = require('./settingsService');
const auditService = require('./auditService');
const backupService = require('./backupService');

const TICK_MS = 60000;

let timer = null;
let lastTickAt = null;
let runs = 0;

/**
 * Is a scheduled backup due?
 *
 * Due when the configured hour has passed in Manila today and no backup has verified
 * since that hour. Manila because the hour is one a shopkeeper set, meaning their
 * evening — a UTC comparison would run it at five in the morning.
 */
function due({ now = clock.nowUtc() } = {}) {
  const hour = settingsService.get('backup_hour');
  const manilaDate = clock.manilaDate(now);
  const scheduledAt = new Date(`${manilaDate}T${String(hour).padStart(2, '0')}:00:00.000+08:00`).toISOString();

  if (Date.parse(now) < Date.parse(scheduledAt)) {
    return { due: false, reason: 'the scheduled hour has not come round yet', scheduled_at: scheduledAt };
  }

  const last = backupService.lastVerified();
  if (last && Date.parse(last.taken_at) >= Date.parse(scheduledAt)) {
    return {
      due: false,
      reason: 'a backup has already verified since the scheduled hour',
      scheduled_at: scheduledAt,
      last_verified_at: last.taken_at,
    };
  }

  return {
    due: true,
    scheduled_at: scheduledAt,
    last_verified_at: last ? last.taken_at : null,
    // A shift close backs up too (OPS-001), so a busy store usually satisfies the
    // schedule without it ever firing. That is the intended outcome, not a gap.
    reason: last ? 'nothing has verified since the scheduled hour' : 'nothing has ever verified',
  };
}

/** One tick. Never throws — a scheduler that dies takes the daily backup with it. */
function tick({ now = clock.nowUtc() } = {}) {
  lastTickAt = now;
  try {
    const check = due({ now });
    if (!check.due) return { ran: false, ...check };

    runs += 1;
    const result = backupService.run({ trigger: 'SCHEDULED', actor: auditService.SYSTEM_ACTOR, now });
    return { ran: true, scheduled_at: check.scheduled_at, result };
  } catch (err) {
    return { ran: false, error: err.message };
  }
}

function start({ intervalMs = TICK_MS } = {}) {
  if (timer) return timer;
  timer = setInterval(() => tick(), intervalMs);
  // The store PC's only job is this application, but a timer that pins the event loop
  // open stops `npm test` from ever exiting.
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function state() {
  return { running: timer !== null, last_tick_at: lastTickAt, runs, tick_ms: TICK_MS };
}

module.exports = { TICK_MS, due, tick, start, stop, state };
