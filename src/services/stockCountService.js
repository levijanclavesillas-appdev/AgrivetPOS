'use strict';

// FT-209 — the stocktake. INV-110 to INV-113, INV-101, INV-103, AUD-601.
//
// v1.0 corrects stock one product at a time through SCR-203, which is right for a
// miscount and wrong for a stocktake: counting four hundred products means four
// hundred adjustments, each against a figure that has moved since the last one was
// posted.
//
// ## The two things in this file that are easy to get wrong
//
// **INV-110 — the variance is `counted − expected`, and `expected` is frozen.** Not
// `counted − live`. The difference matters enormously and is the whole reason the
// session exists. Suppose the shelf held 10 sacks at 09:00, the counter counts 9 at
// 09:30, and the shop sells 2 at 11:00 before anybody posts:
//
//   • `counted − expected` = 9 − 10 = **−1**. One sack is missing. Posting −1 leaves
//     on hand at 8 − 1 = 7, which is exactly right: 9 were really there at 09:30 and
//     2 have since been sold.
//   • `counted − live` = 9 − 8 = **+1**. The count would *add* a sack, erasing one of
//     the two legitimate sales and reporting a surplus where there was a shortage.
//
// So **after posting, on hand is not the counted figure** — it is the counted figure
// plus whatever traded since the freeze. A store that expects the count to "set" stock
// will think the system is wrong, so `present()` says this out loud and SCR-205 prints
// the sentence.
//
// **A blank is not a zero.** `counted_milli` is NULL until somebody counts, and a NULL
// line posts nothing. Defaulting it to zero would write off the entire uncounted
// remainder of the shop as shrinkage the moment somebody posted a half-finished
// session — which is the single most expensive mistake this feature could make, and it
// is one keystroke away for anybody who treats the two as the same.
//
// INV-107 is why posting is one function: every COUNT_VARIANCE movement, every
// on-hand update, the session's new status and its totals commit together or not at
// all.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const quantity = require('./quantity');
const costing = require('./costing');
const permissions = require('./permissions');
const authService = require('./authService');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const sequenceService = require('./sequenceService');
const inventoryService = require('./inventoryService');
const stockCountRepository = require('../repositories/stockCountRepository');
const productRepository = require('../repositories/productRepository');
const referenceRepository = require('../repositories/referenceRepository');
const userRepository = require('../repositories/userRepository');

/** The statuses whose lines may still be typed into. */
const EDITABLE_STATUSES = Object.freeze(['OPEN']);

/** Who may approve a count. §10's TX-408 names exactly these. */
const APPROVING_ROLES = Object.freeze(['MANAGER', 'OWNER']);

const MS_PER_DAY = 86400000;

const textOrNull = (value, { max = 500 } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, max) : '';
  return trimmed || null;
};

// ── INV-113 — staleness ─────────────────────────────────────────────────────

/**
 * How old this session is, in whole Manila days, and whether that is too old.
 *
 * Manila days rather than elapsed hours, for the same reason POS-307's return window
 * is: a count opened at 4 pm on Monday and posted at 9 am the following Monday is
 * seven days to everybody in the shop, and an hours-based window would make it eight
 * on some clocks and seven on others.
 */
function staleness(session, at = clock.nowUtc()) {
  const days = settingsService.get('stock_count_stale_days');
  const openedOn = Date.parse(`${clock.manilaDate(session.opened_at)}T00:00:00.000Z`);
  const now = Date.parse(`${clock.manilaDate(at)}T00:00:00.000Z`);
  const elapsed = Math.round((now - openedOn) / MS_PER_DAY);

  return { staleDays: days, elapsedDays: elapsed, stale: elapsed > days };
}

// ── INV-112 — the second pair of eyes ───────────────────────────────────────

/**
 * How many people could possibly approve a count that this person took.
 *
 * INV-112 asks for "a user other than the counter, where the store has more than one
 * active user". The second clause is not a courtesy: a one-person shop cannot meet the
 * rule, and a system that refused to post would stop it counting at all — which is
 * worse for the store's stock figures than the control is worth.
 *
 * Counted as *active users who are not the counter*, not as "users > 1": a store whose
 * only other account is deactivated is a one-person store this week, whatever the
 * table says.
 */
function approverPool(counterId) {
  return userRepository.list({ includeInactive: false }).filter((user) => user.id !== counterId);
}

// ── Opening a session (INV-110) ─────────────────────────────────────────────

/**
 * Open a count, freezing the expected quantity and average cost of everything in scope.
 *
 * The sequence number, the session row and every line are written in one transaction,
 * so a session that exists is a session with a complete freeze behind it — and a
 * rollback consumes no number (POS-108's reasoning, VR-103's format).
 */
function open({ scope = 'ALL', categoryId = null, notes = null }, actor) {
  if (!permissions.can(actor, 'TX-407')) {
    throw errors.forbidden(
      'You do not have permission to count stock.',
      { ruleId: 'TX-407', requiresRole: permissions.rolesHolding('TX-407').join(' or ') }
    );
  }

  const wanted = String(scope || 'ALL').toUpperCase();
  if (!['ALL', 'CATEGORY'].includes(wanted)) {
    throw errors.badRequest('A count covers all products or one category', { ruleId: 'INV-110' });
  }

  let category = null;
  if (wanted === 'CATEGORY') {
    if (!categoryId) {
      throw errors.badRequest('Choose the category to count', { ruleId: 'INV-110' });
    }
    category = referenceRepository.findById('categories', categoryId);
    if (!category) throw errors.notFound('No such category');
  }

  const at = clock.nowUtc();

  return db.transaction(() => {
    const countNo = sequenceService.next('STOCK_COUNT', { at });
    const sessionId = ids.uuidv7();

    stockCountRepository.insert({
      id: sessionId,
      count_no: countNo,
      scope: wanted,
      category_id: category ? category.id : null,
      status: 'OPEN',
      notes: textOrNull(notes),
      opened_at: at,
      opened_by: actor.id,
      approved_at: null,
      approved_by: null,
      approval_waived: 0,
      posted_at: null,
      posted_by: null,
      was_stale: 0,
      stale_approved_by: null,
      cancelled_at: null,
      cancelled_by: null,
      cancel_reason: null,
      counted_products: null,
      varying_products: null,
      variance_value_centavos: null,
      created_at: at,
    });

    // INV-110's freeze, in one statement inside this transaction.
    const frozen = stockCountRepository.snapshotLines({
      sessionId,
      categoryId: category ? category.id : null,
      at,
      idFor: () => ids.uuidv7(),
    });

    if (frozen.lines === 0) {
      // A scope that holds only batch-tracked products is a different problem from an
      // empty one, and saying "there is nothing to count" about a fridge full of
      // vaccines would be a lie the counter can see through the door.
      if (frozen.batch_tracked_excluded > 0) {
        throw errors.conflict(
          `Everything in ${category ? category.name : 'the catalogue'} is batch-tracked, and `
          + 'batch-tracked stock is counted by batch rather than by product (INV-201). '
          + 'There is nothing on a product-level sheet to count.',
          { ruleId: 'INV-201' }
        );
      }
      throw errors.conflict(
        category
          ? `There are no products in ${category.name} to count.`
          : 'There are no products to count yet.',
        { ruleId: 'INV-110' }
      );
    }

    auditService.write({
      actor,
      action: 'STOCK_COUNT_OPENED',
      entityType: 'stock_count_sessions',
      entityId: sessionId,
      after: {
        count_no: countNo,
        scope: wanted,
        category: category ? category.name : null,
        products_frozen: frozen.lines,
        // INV-201: what the sheet does not cover, on the row that says what it does.
        batch_tracked_excluded: frozen.batch_tracked_excluded,
        // INV-110: the instant the expected figures were taken. Everything this count
        // ever says about a variance is relative to this moment.
        frozen_at: at,
      },
      reason: `Stock count ${countNo} opened`,
    });

    return get(sessionId);
  }, { immediate: true });
}

// ── Counting (requirement 2) ────────────────────────────────────────────────

/**
 * Record what was actually on the shelf, for one product or many.
 *
 * Saveable in progress and repeatedly: a stocktake spans a lunch break, and a counter
 * who has to finish in one sitting is a counter who guesses the last aisle.
 *
 * A `countedMilli` of `null` clears the line back to uncounted. That is a real need —
 * somebody types into the wrong row — and it is why the field cannot simply be
 * "blank means zero": there would be no way back.
 */
function record(sessionId, { lines = [] }, actor) {
  if (!permissions.can(actor, 'TX-407')) {
    throw errors.forbidden(
      'You do not have permission to count stock.',
      { ruleId: 'TX-407', requiresRole: permissions.rolesHolding('TX-407').join(' or ') }
    );
  }

  const session = requireSession(sessionId);
  if (!EDITABLE_STATUSES.includes(session.status)) {
    throw errors.conflict(
      session.status === 'POSTED'
        ? `${session.count_no} has been posted and cannot be changed (INV-102).`
        : `${session.count_no} is ${session.status.toLowerCase()} and is no longer being counted. `
          + 'Reopening is not offered — open a new count.',
      { ruleId: 'INV-110' }
    );
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    throw errors.badRequest('Send at least one counted line', { ruleId: 'INV-110' });
  }

  const at = clock.nowUtc();

  return db.transaction(() => {
    const written = [];

    for (const [index, entry] of lines.entries()) {
      const line = stockCountRepository.findLine(sessionId, entry.productId);
      if (!line) {
        throw errors.badRequest(
          `Line ${index + 1} is not a product in ${session.count_no}'s scope. `
          + 'A count measures what it froze at the start, and nothing else (INV-110).',
          { ruleId: 'INV-110' }
        );
      }

      // Cleared back to uncounted, which is not the same as counted-as-zero.
      const cleared = entry.countedMilli === null || entry.countedMilli === undefined;
      let counted = null;
      if (!cleared) {
        counted = Number.parseInt(entry.countedMilli, 10);
        if (!Number.isInteger(counted) || counted < 0) {
          throw errors.badRequest(
            `Line ${index + 1} needs a counted quantity of zero or more. An empty shelf is `
            + 'counted as 0; a shelf nobody reached is left blank.',
            { ruleId: 'MON-002' }
          );
        }
        quantity.assertMilli(counted, 'counted quantity');
      }

      written.push(stockCountRepository.setCounted({
        sessionId,
        productId: entry.productId,
        countedMilli: counted,
        countedAt: at,
        countedBy: actor.id,
        note: textOrNull(entry.note, { max: 200 }),
      }));
    }

    return { ...get(sessionId), updated: written.length };
  });
}

// ── INV-112 — approval ──────────────────────────────────────────────────────

/**
 * Approve a count, by somebody other than the person who took it.
 *
 * A stocktake is where shrinkage is written off, and one person counting and approving
 * their own is the shape of the problem the rule names. So the refusal is on identity,
 * not on role: an owner who counted the shelves themselves cannot approve their own
 * count while anybody else is active to do it.
 */
function approve(sessionId, { approver = null } = {}, actor) {
  const session = requireSession(sessionId);

  if (session.status !== 'OPEN') {
    throw errors.conflict(
      session.status === 'APPROVED'
        ? `${session.count_no} has already been approved.`
        : `${session.count_no} is ${session.status.toLowerCase()} and cannot be approved.`,
      { ruleId: 'INV-112' }
    );
  }

  const pool = approverPool(session.opened_by);
  const at = clock.nowUtc();

  // Requirement 5's waiver, and it is stated rather than silently skipped.
  if (pool.length === 0) {
    const waived = stockCountRepository.approve(sessionId, {
      approvedAt: at, approvedBy: session.opened_by, waived: true,
    });
    writeApprovalAudit({ session, actor, approver: null, waived: true, at });
    return {
      ...present(waived),
      approval: {
        waived: true,
        rule_id: 'INV-112',
        // The sentence the screen shows, so a single-user store is told why the
        // control it has read about is not there.
        message: 'There is no second active user in this store, so INV-112\'s second pair of '
          + 'eyes could not be obtained. The count is approved by the person who took it, and '
          + 'the trail says so.',
      },
    };
  }

  // The person approving is whoever authenticated in the panel, or the actor
  // themselves where they already hold TX-408 and did not take the count.
  const resolved = approver && approver.username
    ? authService.resolveApprover(approver, { roles: null })
    : { id: actor.id, username: actor.username, role: actor.role };

  if (!APPROVING_ROLES.includes(resolved.role)) {
    throw errors.forbidden(
      `${resolved.username} is a ${resolved.role.toLowerCase()} and cannot approve a stock count.`,
      { ruleId: 'TX-408', requiresRole: permissions.rolesHolding('TX-408').join(' or ') }
    );
  }

  if (resolved.id === session.opened_by) {
    throw errors.forbidden(
      `${session.count_no} was counted by ${session.opened_by_username}, so somebody else has to `
      + 'approve it. A stocktake is where shrinkage is written off, and one person counting and '
      + 'approving their own is the shape of the problem.',
      { ruleId: 'INV-112', requiresRole: permissions.rolesHolding('TX-408').join(' or ') }
    );
  }

  const approved = stockCountRepository.approve(sessionId, {
    approvedAt: at, approvedBy: resolved.id, waived: false,
  });
  writeApprovalAudit({ session, actor, approver: resolved, waived: false, at });

  return { ...present(approved), approval: { waived: false, rule_id: 'INV-112', message: null } };
}

function writeApprovalAudit({ session, actor, approver, waived, at }) {
  auditService.write({
    actor,
    approver: approver && approver.id !== actor.id ? approver : null,
    action: 'STOCK_COUNT_APPROVED',
    entityType: 'stock_count_sessions',
    entityId: session.id,
    before: { status: session.status },
    after: {
      status: 'APPROVED',
      count_no: session.count_no,
      counted_by: session.opened_by_username,
      approved_by: waived ? session.opened_by_username : approver.username,
      // INV-112's waiver, written down. "Nobody else was available" and "nobody
      // bothered" read identically otherwise.
      approval_waived: waived,
      approved_at: at,
    },
    reason: waived
      ? `${session.count_no} approved with no second user available (INV-112 waived)`
      : `${session.count_no} approved`,
  });
}

// ── Posting (INV-111, INV-113, INV-107) ─────────────────────────────────────

/**
 * What this session would post, computed from the frozen figures and nothing else.
 *
 * Shared by the preview the screen shows and by the posting itself, so the figure an
 * owner authorises is the figure that lands. Two routes to one number is one of them
 * being wrong eventually.
 */
function plan(sessionId) {
  const lines = stockCountRepository.linesFor(sessionId, { limit: 100000 });

  const varying = [];
  let countedProducts = 0;
  let uncounted = 0;
  let varianceValue = 0;

  for (const line of lines) {
    if (line.counted_milli === null) { uncounted += 1; continue; }
    countedProducts += 1;

    // INV-110: against the frozen figure, never against live on-hand. See the note at
    // the head of this file for what the other subtraction would do.
    const varianceMilli = line.counted_milli - line.expected_milli;
    if (varianceMilli === 0) continue;

    // MON-004 at the frozen cost, so the value is what the difference was worth when
    // it was found rather than what a delivery has since made it worth.
    const value = costing.valuation(Math.abs(varianceMilli), line.avg_cost_centavos);
    varianceValue += varianceMilli < 0 ? -value : value;

    varying.push({ line, varianceMilli, valueCentavos: varianceMilli < 0 ? -value : value });
  }

  return {
    lines: lines.length,
    countedProducts,
    uncountedProducts: uncounted,
    varyingProducts: varying.length,
    // INV-111, stated as a figure: this many products matched and will post nothing.
    matchedProducts: countedProducts - varying.length,
    varianceValueCentavos: varianceValue,
    varying,
  };
}

/**
 * Post the count.
 *
 * One transaction (requirement 7): every COUNT_VARIANCE movement, every on-hand
 * update, the session's status and its totals commit together or not at all (INV-107).
 */
function post(sessionId, { approver = null, reason = null } = {}, actor) {
  if (!permissions.can(actor, 'TX-407')) {
    throw errors.forbidden(
      'You do not have permission to post a stock count.',
      { ruleId: 'TX-407', requiresRole: permissions.rolesHolding('TX-407').join(' or ') }
    );
  }

  const session = requireSession(sessionId);

  if (session.status !== 'APPROVED') {
    throw errors.conflict(
      session.status === 'POSTED'
        ? `${session.count_no} has already been posted.`
        : `${session.count_no} has not been approved yet. INV-112 asks for a second pair of eyes `
          + 'before a count writes anything off.',
      { ruleId: session.status === 'POSTED' ? 'INV-102' : 'INV-112' }
    );
  }

  const at = clock.nowUtc();
  const state = staleness(session, at);

  // ── INV-113 — a fortnight-old count is a measurement of a fortnight ago ──
  let staleApprover = null;
  if (state.stale) {
    const resolved = approver && approver.username
      ? authService.resolveApprover(approver, { roles: null })
      : (actor.role === 'OWNER' ? { id: actor.id, username: actor.username, role: actor.role } : null);

    if (!resolved) {
      throw errors.forbidden(
        `${session.count_no} was opened ${state.elapsedDays} days ago and the window is `
        + `${state.staleDays} days. What it froze is a measurement of ${state.elapsedDays} days `
        + 'ago, and everything sold since is not shrinkage. An owner must authorise posting it.',
        { ruleId: 'INV-113', requiresRole: 'OWNER' }
      );
    }
    if (resolved.role !== 'OWNER') {
      throw errors.forbidden(
        `${resolved.username} is a ${resolved.role.toLowerCase()}; only an owner may post a stale count.`,
        { ruleId: 'INV-113', requiresRole: 'OWNER' }
      );
    }
    staleApprover = resolved;
  }

  const planned = plan(sessionId);
  const why = textOrNull(reason, { max: 200 }) || `Stock count ${session.count_no}`;

  const result = db.transaction(() => {
    const posted = [];

    for (const { line, varianceMilli, valueCentavos } of planned.varying) {
      // ── INV-111 — one movement per varying product ──
      //
      // The quantity is the variance, not the counted figure. Posting the counted
      // figure would overwrite whatever traded since the freeze and erase real sales;
      // posting the difference records what the count actually discovered. See the
      // worked example at the head of this file.
      const movement = inventoryService.post({
        productId: line.product_id,
        type: 'COUNT_VARIANCE',
        qtyMilli: varianceMilli,
        actor,
        reason: `${why} — counted ${quantity.format(line.counted_milli, line.base_unit_code)} `
          + `against ${quantity.format(line.expected_milli, line.base_unit_code)} expected`,
        referenceType: 'stock_count',
        referenceId: session.id,
        referenceNo: session.count_no,
        occurredAt: at,
        // A count is how a store discovers its figure was wrong, including wrong in
        // the direction that makes on-hand negative. Flagged, not refused — the same
        // carve-out INV-108's adjustment already makes.
        allowNegative: true,
      });

      stockCountRepository.setMovement(line.id, movement.movement.id);

      posted.push({
        product: line.product_name_snapshot,
        expected_milli: line.expected_milli,
        counted_milli: line.counted_milli,
        variance_milli: varianceMilli,
        value_centavos: valueCentavos,
        movement_id: movement.movement.id,
        balance_after_milli: movement.balanceMilli,
      });
    }

    const closed = stockCountRepository.post(sessionId, {
      postedAt: at,
      postedBy: actor.id,
      wasStale: state.stale,
      staleApprovedBy: staleApprover ? staleApprover.id : null,
      countedProducts: planned.countedProducts,
      varyingProducts: planned.varyingProducts,
      varianceValueCentavos: planned.varianceValueCentavos,
    });

    auditService.write({
      actor,
      approver: staleApprover && staleApprover.id !== actor.id ? staleApprover : null,
      action: 'STOCK_COUNT_POSTED',
      entityType: 'stock_count_sessions',
      entityId: session.id,
      before: { status: 'APPROVED', frozen_at: session.opened_at },
      after: {
        status: 'POSTED',
        count_no: session.count_no,
        counted_products: planned.countedProducts,
        // INV-111 as a pair of figures, because the second is the one somebody has to
        // be able to check: this many were counted and correct, and wrote nothing.
        matched_products: planned.matchedProducts,
        varying_products: planned.varyingProducts,
        // The number nobody should discover later: products in scope that were never
        // counted, and therefore wrote nothing either.
        uncounted_products: planned.uncountedProducts,
        variance_value_centavos: planned.varianceValueCentavos,
        was_stale: state.stale,
        days_since_opened: state.elapsedDays,
        movements: posted,
      },
      reason: why,
    });

    // INV-113's own override row, where a second person released it.
    if (staleApprover && staleApprover.id !== actor.id) {
      auditService.recordOverride({
        action: 'OVERRIDE_STALE_STOCK_COUNT',
        actor,
        approver: staleApprover,
        reason: `${session.count_no} opened ${state.elapsedDays} days ago; ${why}`,
        entityType: 'stock_count_sessions',
        entityId: session.id,
        after: { rule_id: 'INV-113', days_since_opened: state.elapsedDays },
      });
    }

    return { closed, posted };
  }, { immediate: true });

  return {
    ...present(result.closed),
    posting: {
      counted_products: planned.countedProducts,
      matched_products: planned.matchedProducts,
      varying_products: planned.varyingProducts,
      uncounted_products: planned.uncountedProducts,
      variance_value_centavos: planned.varianceValueCentavos,
      movements: result.posted,
      was_stale: state.stale,
      stale_authorised_by: staleApprover ? staleApprover.username : null,
    },
  };
}

/** A count abandoned rather than posted. Nothing moves; the session records that it did not. */
function cancel(sessionId, { reason }, actor) {
  const session = requireSession(sessionId);
  if (!['OPEN', 'APPROVED'].includes(session.status)) {
    throw errors.conflict(
      `${session.count_no} is ${session.status.toLowerCase()} and cannot be cancelled.`,
      { ruleId: 'INV-110' }
    );
  }
  if (session.opened_by !== actor.id && !permissions.can(actor, 'TX-408')) {
    throw errors.forbidden(
      `${session.count_no} is ${session.opened_by_username}'s count. A manager or owner may `
      + 'cancel it for them.',
      { ruleId: 'TX-408', requiresRole: permissions.rolesHolding('TX-408').join(' or ') }
    );
  }

  const why = textOrNull(reason, { max: 200 });
  if (!why) {
    throw errors.badRequest('Say why the count is being abandoned', { ruleId: 'AUD-601' });
  }

  const at = clock.nowUtc();
  return db.transaction(() => {
    const cancelled = stockCountRepository.cancel(sessionId, {
      cancelledAt: at, cancelledBy: actor.id, reason: why,
    });
    auditService.write({
      actor,
      action: 'STOCK_COUNT_CANCELLED',
      entityType: 'stock_count_sessions',
      entityId: sessionId,
      before: { status: session.status, counted_count: session.counted_count },
      after: { status: 'CANCELLED', count_no: session.count_no },
      reason: why,
    });
    return present(cancelled);
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

function requireSession(id) {
  const session = stockCountRepository.findById(id);
  if (!session) throw errors.notFound('No such stock count');
  return session;
}

function presentLine(row) {
  const counted = row.counted_milli !== null;
  const varianceMilli = counted ? row.counted_milli - row.expected_milli : null;

  return {
    id: row.id,
    product_id: row.product_id,
    sku: row.sku,
    product_name: row.product_name_snapshot,
    base_unit_code: row.base_unit_code,
    // INV-110's frozen figure, labelled as frozen wherever it is shown.
    expected_milli: row.expected_milli,
    expected_display: quantity.format(row.expected_milli, row.base_unit_code),
    avg_cost_centavos: row.avg_cost_centavos,
    counted_milli: row.counted_milli,
    counted_display: counted ? quantity.format(row.counted_milli, row.base_unit_code) : null,
    // The distinction the whole feature turns on, in the payload so a screen cannot
    // render a blank and a zero the same way.
    is_counted: counted,
    counted_at: row.counted_at,
    counted_by: row.counted_by_username || null,
    variance_milli: varianceMilli,
    variance_display: counted ? quantity.format(varianceMilli, row.base_unit_code) : null,
    variance_value_centavos: counted
      ? (varianceMilli < 0 ? -1 : 1) * costing.valuation(Math.abs(varianceMilli), row.avg_cost_centavos)
      : null,
    note: row.note,
    movement_id: row.movement_id,
    // INV-111: counted, correct, and it wrote nothing — which is a different fact from
    // never having been counted, and both look like "no movement" on their own.
    matched: counted && varianceMilli === 0,
  };
}

/**
 * Products in a count's scope whose stock is held as batches (`INV-201`).
 *
 * They are not on a product-level sheet: which batch is short is not something one
 * counted figure can say, and the variance movement would be refused at posting —
 * after the shelf had been counted and the count approved. Counting them by batch is
 * `TASK-042`; until it lands they are named as absent rather than quietly missing.
 */
function batchTrackedInScope(categoryId = null) {
  return productRepository.countBatchTracked({ categoryId });
}

function present(session, { lines = null } = {}) {
  if (!session) return null;
  const state = session.status === 'POSTED'
    ? { staleDays: settingsService.get('stock_count_stale_days'), elapsedDays: null, stale: Boolean(session.was_stale) }
    : staleness(session);

  return {
    session: {
      id: session.id,
      count_no: session.count_no,
      scope: session.scope,
      category: session.category_id ? { id: session.category_id, name: session.category_name } : null,
      status: session.status,
      notes: session.notes,
      // INV-110, named as what it is: everything this count says is relative to here.
      frozen_at: session.opened_at,
      frozen_at_manila: clock.toManila(session.opened_at),
      opened_by: session.opened_by_username || session.opened_by,
      approved_at: session.approved_at,
      approved_by: session.approved_by_username || null,
      approval_waived: Boolean(session.approval_waived),
      posted_at: session.posted_at,
      posted_at_manila: session.posted_at ? clock.toManila(session.posted_at) : null,
      posted_by: session.posted_by_username || null,
      was_stale: Boolean(session.was_stale),
      stale_approved_by: session.stale_approved_by_username || null,
      cancelled_at: session.cancelled_at,
      cancel_reason: session.cancel_reason,
      is_editable: EDITABLE_STATUSES.includes(session.status),
      is_immutable: session.status === 'POSTED',
      line_count: session.line_count,
      // TASK-029: how many products in this scope are **not** on the sheet because
      // their stock is held as batches. Stated rather than silently left off — a sheet
      // that claims to cover the whole shop and quietly omits the vaccine fridge is a
      // sheet somebody signs off believing they counted everything. Derived, not
      // stored, so it stays true if a product is switched to batch tracking later.
      batch_tracked_excluded: batchTrackedInScope(session.category_id),
      counted_count: session.counted_count,
      uncounted_count: session.line_count - session.counted_count,
      varying_count: session.varying_count,
      // Written at posting; null while the count is still being taken, because the
      // figure moves with every keystroke and a stored one would be stale by a second.
      counted_products: session.counted_products,
      varying_products: session.varying_products,
      variance_value_centavos: session.variance_value_centavos,
      stale: state.stale,
      stale_days: state.staleDays,
      days_open: state.elapsedDays,
      // **The sentence a store will otherwise think is a bug.** After posting, on hand
      // is the counted figure *plus whatever traded since the freeze* — because the
      // variance posted is counted − expected, and the trading in between is already
      // on the ledger. See the worked example at the head of this file.
      variance_basis: 'Variance is measured against what the system held when this count was '
        + `opened (${clock.toManila(session.opened_at)}), not against stock now (INV-110). `
        + 'Posting adjusts by the difference, so anything sold since the count began stays sold.',
    },
    ...(lines ? { lines: lines.map(presentLine) } : {}),
  };
}

function get(id, { varyingOnly = false, uncountedOnly = false, limit = 1000, offset = 0 } = {}) {
  const session = requireSession(id);
  return present(session, {
    lines: stockCountRepository.linesFor(id, { varyingOnly, uncountedOnly, limit, offset }),
  });
}

function search(opts = {}) {
  const filters = {
    status: textOrNull(opts.status, { max: 20 }),
    openOnly: opts.openOnly === true || opts.openOnly === 'true',
    categoryId: textOrNull(opts.categoryId, { max: 40 }),
    from: textOrNull(opts.from, { max: 40 }),
    to: textOrNull(opts.to, { max: 40 }),
  };
  const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0);

  return {
    total: stockCountRepository.countSearch(filters),
    limit,
    offset,
    stock_counts: stockCountRepository.search({ ...filters, limit, offset })
      .map((row) => present(row).session),
  };
}

/**
 * Requirement 8 — the variance report: by product, valued at average cost, and a total.
 *
 * Valued at the cost **frozen with the line**, not at the product's cost today. A
 * count read a month later must say what the difference was worth when it was found;
 * a delivery since then has moved the average, and revaluing an old count against it
 * would restate a loss the store already took.
 */
function varianceReport(id) {
  const session = requireSession(id);
  const lines = stockCountRepository.linesFor(id, { varyingOnly: true, limit: 100000 })
    .map(presentLine);

  const shortages = lines.filter((line) => line.variance_milli < 0);
  const surpluses = lines.filter((line) => line.variance_milli > 0);
  const sum = (rows) => rows.reduce((total, row) => total + row.variance_value_centavos, 0);

  return {
    ...present(session),
    variance: {
      rule_id: 'INV-111',
      varying_products: lines.length,
      // Both sides separately, because they are different problems: a shortage is
      // shrinkage and a surplus is usually a receipt nobody posted, and a net figure
      // hides one behind the other.
      shortage_products: shortages.length,
      shortage_value_centavos: sum(shortages),
      surplus_products: surpluses.length,
      surplus_value_centavos: sum(surpluses),
      net_value_centavos: sum(lines),
      net_display: money.toDisplay(sum(lines)),
      basis: 'Valued at each product’s average cost as it stood when the count was opened '
        + '(MON-004, INV-110).',
    },
    lines,
    // The figure an owner should see beside the variance, because a count of 400
    // products that reached 180 of them is not a stocktake of the shop.
    coverage: {
      products_in_scope: session.line_count,
      counted: session.counted_count,
      uncounted: session.line_count - session.counted_count,
    },
  };
}

module.exports = {
  EDITABLE_STATUSES, APPROVING_ROLES,
  staleness, approverPool, plan,
  open, record, approve, post, cancel,
  get, search, present, presentLine, varianceReport,
};
