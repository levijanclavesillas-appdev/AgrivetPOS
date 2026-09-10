'use strict';

// FT-307 — the sales return. POS-301 to POS-307, INV-103, CR-108, AUD-601.
//
// v1.0 sells and cannot unsell. There are two corrections and they are different
// operations: a **void** says the sale never happened (TASK-021, the same shift, the
// whole sale), and a **return** says the goods came back. This is the second, and the
// difference is why the original sale is never edited here — POS-107 holds, the return
// is a new document that cites the sale, and the only two columns on the sale that
// move are the ones 006_sales.sql put there for it.
//
// Three rules carry most of the weight, and each is easy to get quietly wrong.
//
//   POS-304 — **a medicine defaults to write-off, not restock.** A customer who has
//   had a bottle of antibiotic in their motorcycle box for two days has not returned a
//   saleable bottle, and a system that puts it back on the shelf sells it to the next
//   farm. The default is computed server-side and the *rule's* answer is stored beside
//   the chosen one, so "restocked, as normal" and "restocked against the default, and
//   here is who authorised it" are distinguishable for ever.
//
//   POS-305 / POS-306 — the refund precedence, and the cash that is not paid out.
//   Credit first: a customer who still owes the store is not handed money. The three
//   destinations are separate columns because one refund can split between them.
//
//   POS-303 — a write-off posts **two** movements, not none and not one. The goods
//   came back (CUSTOMER_RETURN in) and they are not saleable (DAMAGE out). Netting to
//   zero in the ledger is the point: a return that posted nothing would be a return
//   the stock figure cannot explain.
//
// Requirement 8 is why this is one function: the return rows, the movements, any
// credit transaction and the sale's new status commit together or not at all
// (INV-107). The drawer pulse and the acknowledgement are outside it (INT-1) — the
// customer is standing there with the goods, and a printer fault must not undo it.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const quantity = require('./quantity');
const permissions = require('./permissions');
const authService = require('./authService');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const sequenceService = require('./sequenceService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const shiftService = require('./shiftService');
const drawerService = require('./drawerService');
const documentService = require('./documentService');
const storeProfileService = require('./storeProfileService');
const saleRepository = require('../repositories/saleRepository');
const returnRepository = require('../repositories/returnRepository');
const productRepository = require('../repositories/productRepository');
const customerRepository = require('../repositories/customerRepository');
const creditRepository = require('../repositories/creditRepository');

/** POS-303's two answers. */
const DISPOSITIONS = Object.freeze(['RESTOCK', 'WRITE_OFF']);

/** Who may authorise POS-304's restock and POS-307's late return. */
const AUTHORISING_ROLES = Object.freeze(['MANAGER', 'OWNER']);

/** The statuses a sale can still give something back from (POS-301). */
const RETURNABLE_STATUSES = Object.freeze(['COMPLETED', 'PARTIALLY_RETURNED']);

const MS_PER_DAY = 86400000;

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textOrNull = (value, opts) => text(value, opts) || null;

// ── POS-302 — the reason ────────────────────────────────────────────────────

function returnReasons() {
  return settingsService.get('return_reasons');
}

/**
 * INV-108's shape, applied to POS-302.
 *
 * The listed spelling is returned rather than the caller's, so the reported figures
 * group. "Damaged on arrival" and "damaged on arrival" are one reason to a person and
 * two rows to a GROUP BY, and the report is the only place anybody ever counts them.
 */
function assertReasonListed(reason) {
  const listed = returnReasons();
  const value = textOrNull(reason);

  if (!value) {
    throw errors.badRequest(
      `A return needs a reason. Choose one of: ${listed.join(', ')}.`,
      { ruleId: 'POS-302' }
    );
  }
  const match = listed.find((entry) => entry.toLowerCase() === value.toLowerCase());
  if (!match) {
    throw errors.badRequest(
      `"${value}" is not one of the configured return reasons. Choose one of: ${listed.join(', ')}. `
      + 'Free text belongs in the notes, alongside a listed reason.',
      { ruleId: 'POS-302' }
    );
  }
  return match;
}

// ── POS-304 — what defaults to write-off ────────────────────────────────────

/**
 * The disposition the rule chooses before anybody does.
 *
 * Two tests, and they are deliberately independent. `is_batch_tracked` is the column
 * the rule names outright; the category list is how "veterinary medicines and
 * vaccines" is expressed in a system that has no medicine flag and should not grow one
 * — the store has already categorised its stock, and `categories.name` is UNIQUE
 * NOCASE (VR-209), so the name is a handle rather than a guess.
 *
 * Returns the disposition **and the sentence explaining it**, because a screen that
 * defaults a line to write-off without saying why is a screen whose default gets
 * overridden out of irritation.
 */
function defaultDispositionFor(product) {
  const categories = settingsService.get('return_write_off_categories') || [];
  const listed = categories.some(
    (name) => String(name).toLowerCase() === String(product.category_name || '').toLowerCase()
  );

  if (product.is_batch_tracked) {
    return {
      disposition: 'WRITE_OFF',
      why: `${product.name} is batch-tracked, so the store cannot attest to how it was stored `
        + 'while it was out (POS-304).',
    };
  }
  if (listed) {
    return {
      disposition: 'WRITE_OFF',
      why: `${product.name} is a ${product.category_name} line, so the store cannot attest to how `
        + 'it was stored while it was out (POS-304).',
    };
  }
  return { disposition: 'RESTOCK', why: null };
}

// ── POS-307 — the window ────────────────────────────────────────────────────

/**
 * Whether this return is late, in whole Manila days.
 *
 * Manila days rather than elapsed hours, for the same reason CR-107's ageing is: a
 * sale at 6 pm on Monday and a return at 9 am the following Monday is seven days to
 * everybody standing at the counter, and an hours-based window would make it eight on
 * some clocks and seven on others.
 */
function windowState(sale, at) {
  const days = settingsService.get('return_window_days');
  const soldOn = Date.parse(`${clock.manilaDate(sale.occurred_at)}T00:00:00.000Z`);
  const returnedOn = Date.parse(`${clock.manilaDate(at)}T00:00:00.000Z`);
  const elapsed = Math.round((returnedOn - soldOn) / MS_PER_DAY);

  return { windowDays: days, elapsedDays: elapsed, beyond: elapsed > days };
}

// ── Resolving the lines (POS-301, POS-303, POS-304) ─────────────────────────

/**
 * What was sold, what has come back already, and what this return is taking.
 *
 * The already-returned figure is summed from `sale_return_items` rather than read from
 * `sale_items.returned_qty_milli`. The stored column is what the screens read and it
 * is maintained below, but a limit checked against a materialised counter is a limit
 * that fails open the moment the counter drifts — INV-101's reasoning applied to a
 * third table. TC-INT-81 asserts the two agree after repeated partial returns.
 */
function resolveLines({ input, sale, saleItems }) {
  const lines = Array.isArray(input) ? input : [];
  if (lines.length === 0) {
    throw errors.badRequest('A return needs at least one line', { ruleId: 'POS-301' });
  }

  const byId = new Map(saleItems.map((item) => [item.id, item]));
  const seen = new Set();

  return lines.map((line, index) => {
    const item = byId.get(line.saleItemId);
    if (!item) {
      throw errors.badRequest(
        `Line ${index + 1} is not a line on ${sale.sale_no}`,
        { ruleId: 'POS-301' }
      );
    }
    if (seen.has(item.id)) {
      throw errors.badRequest(
        `${item.product_name_snapshot} is on this return twice. Put the whole quantity on one line.`,
        { ruleId: 'POS-301' }
      );
    }
    seen.add(item.id);

    const qtyMilli = Number.parseInt(line.qtyMilli, 10);
    if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) {
      throw errors.badRequest(
        `Line ${index + 1} needs a quantity greater than zero. A line that is not coming back is `
        + 'left off the return.',
        { ruleId: 'MON-002' }
      );
    }
    quantity.assertMilli(qtyMilli, 'returned quantity');

    const product = productRepository.findById(item.product_id);
    if (!product) throw errors.notFound(`No such product on line ${index + 1}`);

    // ── POS-301 — never beyond what was sold, counting earlier returns ──
    const alreadyReturned = returnRepository.returnedQtyFor(item.id);
    const remaining = item.qty_milli - alreadyReturned;
    if (qtyMilli > remaining) {
      throw errors.conflict(
        `${item.product_name_snapshot}: ${quantity.format(item.qty_milli, product.base_unit_code)} was sold`
        + (alreadyReturned > 0
          ? ` and ${quantity.format(alreadyReturned, product.base_unit_code)} has already come back, `
            + `so ${quantity.format(Math.max(remaining, 0), product.base_unit_code)} is left to return.`
          : `, so ${quantity.format(remaining, product.base_unit_code)} is the most that can come back.`),
        { ruleId: 'POS-301' }
      );
    }

    // ── POS-304 — the rule's answer, and the one the counter gave ──
    const declared = defaultDispositionFor(product);
    const chosen = line.disposition === undefined || line.disposition === null || line.disposition === ''
      ? declared.disposition
      : String(line.disposition).toUpperCase();

    if (!DISPOSITIONS.includes(chosen)) {
      throw errors.badRequest(
        `Line ${index + 1} must be ${DISPOSITIONS.join(' or ')}`,
        { ruleId: 'POS-303' }
      );
    }

    const { refundCentavos, taxCentavos, isFinalPortion } = refundFor({ item, qtyMilli, alreadyReturned });

    return {
      item,
      product,
      line_no: index + 1,
      sale_item_id: item.id,
      product_id: item.product_id,
      product_name_snapshot: item.product_name_snapshot,
      qty_milli: qtyMilli,
      already_returned_milli: alreadyReturned,
      cumulative_returned_milli: alreadyReturned + qtyMilli,
      // MON-005: measured against what was actually charged and what it actually cost,
      // both of which are frozen on the sale line and neither of which is the
      // product's figure today.
      unit_price_centavos: item.unit_price_centavos,
      unit_cost_centavos: item.unit_cost_centavos,
      tax_centavos: taxCentavos,
      line_total_centavos: refundCentavos,
      disposition: chosen,
      default_disposition: declared.disposition,
      default_reason: declared.why,
      // The exception POS-304 exists to make visible.
      overrides_default: chosen === 'RESTOCK' && declared.disposition === 'WRITE_OFF',
      is_final_portion: isFinalPortion,
    };
  });
}

/**
 * What one returned quantity is worth, apportioned from the sale line.
 *
 * Not `unit_price × qty`. The sale line's total is net of its share of every discount
 * and rounded once (MON-003, MON-006), so recomputing from the unit price refunds a
 * customer more than they paid on any discounted line. The refund is the line's total
 * in proportion to the quantity — **and the portion that finishes the line takes the
 * remainder**, so returning a line in three parts refunds exactly what it charged
 * rather than three roundings of a third.
 *
 * The tax is apportioned the same way and by the same method, so `tax` and `total`
 * cannot disagree about which of them absorbed the rounding.
 */
function refundFor({ item, qtyMilli, alreadyReturned }) {
  const isFinalPortion = alreadyReturned + qtyMilli === item.qty_milli;
  const refunded = returnRepository.refundedFor(item.id);

  if (isFinalPortion) {
    return {
      refundCentavos: item.line_total_centavos - refunded.line_total_centavos,
      taxCentavos: item.tax_centavos - refunded.tax_centavos,
      isFinalPortion,
    };
  }

  const share = (whole) => money.toSafeNumber(
    money.divRoundHalfUp(BigInt(whole) * BigInt(qtyMilli), BigInt(item.qty_milli)),
    'return apportionment'
  );

  return {
    refundCentavos: share(item.line_total_centavos),
    taxCentavos: share(item.tax_centavos),
    isFinalPortion,
  };
}

// ── POS-305 / POS-306 — where the money goes ────────────────────────────────

/**
 * Split the refund between the three destinations, in POS-305's precedence.
 *
 * **The credit ledger first, and by the same means as the original tender.** Where the
 * sale was on credit, that part of the refund goes back onto the account whether or
 * not the customer still owes anything — POS-306 says a return against a credit sale
 * "reduces the customer's outstanding balance and writes a credit transaction", and
 * the customer never handed the store money for those goods, so there is none to hand
 * back. A farm already in credit gets more credit, not cash out of the drawer.
 *
 * How much may go there is bounded by what the sale put there: the CREDIT tenders on
 * it, less whatever earlier returns of the same sale have already sent back. Without
 * that bound a half-cash, half-credit sale returned in full would refund the whole of
 * it to the account, which is the same means only by coincidence.
 *
 * `credit` and `store_credit` are that one movement split by where the balance was
 * when it landed: the part that reduces what is owed, and the part that goes past zero
 * (CR-108). They are one `RETURN_CREDIT` row; the two columns exist so a report can
 * say which of the two happened without re-deriving it from a balance that has since
 * moved on.
 *
 * What is left is the cash part of the sale, and it is paid in cash — unless a balance
 * still stands, in which case POS-306 holds it as store credit rather than handing
 * money to somebody who still owes it. GCash and QR Ph are absent by design: POS-305
 * says the system moves no funds, so a GCash sale refunds as cash or store credit and
 * the acknowledgement says which. Recording a "GCash refund" the store then has to
 * send by hand is a report that reconciles against money nobody moved.
 *
 * The three parts sum to the total by construction, and the schema's CHECK is what
 * makes that a property of the table rather than a promise made here.
 */
function splitRefund({ totalCentavos, sale, customer, account }) {
  const creditTendered = saleRepository.tendersFor(sale.id)
    .filter((t) => t.method === 'CREDIT')
    .reduce((sum, t) => sum + t.amount_centavos, 0);
  const soldOnCredit = creditTendered > 0;

  const outstanding = account ? Math.max(account.balance_centavos, 0) : 0;

  // POS-305's "same means", as a ceiling rather than an intention.
  const alreadyToCredit = returnRepository.creditRefundedForSale(sale.id);
  const toLedger = account
    ? Math.min(totalCentavos, Math.max(creditTendered - alreadyToCredit, 0))
    : 0;

  const credit = Math.min(toLedger, outstanding);
  let storeCredit = toLedger - credit;

  let remaining = totalCentavos - toLedger;
  const balanceAfter = outstanding - toLedger;
  let withheldReason = null;

  // POS-306's second clause, and it is scoped as the rule is scoped: **a return
  // against a credit sale** never pays out cash while a balance remains. A cash sale
  // returned by a customer who happens to owe on a different sale is refunded in cash
  // — POS-305 says "the same means as the original tender", and the store took notes
  // for those goods. Reading the prohibition wider than the rule would mean confiscating
  // a refund to settle an unrelated debt, which is not a thing a shop may do.
  //
  // So this is reachable only on a mixed-tender credit sale: the part of it that was
  // paid in cash, returned while the credit part is still outstanding.
  if (remaining > 0 && balanceAfter > 0 && soldOnCredit) {
    withheldReason = `${customer.name} still owes ${money.toDisplay(balanceAfter)}, so the balance `
      + 'of this refund is held as store credit rather than paid out (POS-306).';
    storeCredit += remaining;
    remaining = 0;
  }

  return {
    creditCentavos: credit,
    cashCentavos: remaining,
    storeCreditCentavos: storeCredit,
    soldOnCredit,
    balanceBeforeCentavos: outstanding,
    withheldReason,
  };
}

// ── Authorisation (POS-304, POS-307, AUD-603) ───────────────────────────────

/** The exceptions on a return, as sentences the authorisation panel can show. */
function exceptionsFor({ resolved, window: state }) {
  const out = [];

  const restocked = resolved.filter((line) => line.overrides_default);
  if (restocked.length > 0) {
    out.push({
      ruleId: 'POS-304',
      kind: 'RESTOCK_AGAINST_DEFAULT',
      message: restocked.map((line) => line.default_reason).join(' ')
        + ' Restocking it needs a manager or owner.',
      lines: restocked.map((line) => line.line_no),
    });
  }

  if (state.beyond) {
    out.push({
      ruleId: 'POS-307',
      kind: 'BEYOND_WINDOW',
      message: `This sale was ${state.elapsedDays} days ago and the return window is `
        + `${state.windowDays} days. A manager or owner must authorise a late return.`,
      lines: [],
    });
  }

  return out;
}

/**
 * Whether the exceptions are authorised, and by whom.
 *
 * The same carve-out goodsReceiptService makes, for the same reason: a manager
 * standing at the counter **is** the authority POS-304 and POS-307 ask for, and
 * requiring a second person would make a late return impossible in a store where the
 * manager works the till — which is most of them. The trail says `self_authorised`
 * explicitly, because "a manager did this himself" and "no authorisation was needed"
 * read identically otherwise.
 */
function authorisationFor({ actor, approver, exceptions }) {
  if (exceptions.length === 0) {
    return { required: false, selfAuthorised: false, approver: null };
  }

  if (AUTHORISING_ROLES.includes(actor.role)) {
    return { required: true, selfAuthorised: true, approver: null };
  }

  const resolved = authService.resolveApprover(approver, { roles: null });
  if (!resolved) {
    throw errors.forbidden(
      `${exceptions.map((e) => e.message).join(' ')}`,
      { ruleId: exceptions[0].ruleId, requiresRole: AUTHORISING_ROLES.join(' or ') }
    );
  }
  if (!AUTHORISING_ROLES.includes(resolved.role)) {
    throw errors.forbidden(
      `${resolved.username} is a ${resolved.role.toLowerCase()} and cannot authorise this return.`,
      { ruleId: exceptions[0].ruleId, requiresRole: AUTHORISING_ROLES.join(' or ') }
    );
  }
  if (resolved.id && actor.id && resolved.id === actor.id) {
    throw errors.forbidden('A return must be authorised by a different user.', { ruleId: 'AUD-603' });
  }

  return { required: true, selfAuthorised: false, approver: resolved };
}

// ── Posting ─────────────────────────────────────────────────────────────────

/**
 * Take goods back against the sale they came from.
 *
 * One transaction (requirement 8): the return, its lines, both kinds of movement, the
 * credit transaction, the sale's `returned_qty_milli` and the sale's new status commit
 * together or not at all.
 */
function post(input, actor) {
  if (!permissions.can(actor, 'TX-406')) {
    throw errors.forbidden(
      'You do not have permission to process a return.',
      { ruleId: 'TX-406', requiresRole: permissions.rolesHolding('TX-406').join(' or ') }
    );
  }

  const sale = saleRepository.findById(input.saleId);
  if (!sale) throw errors.notFound('No such sale');

  // POS-301: against an original sale. A voided sale was never a sale (POS-404), and a
  // fully returned one has nothing left to give back.
  if (!RETURNABLE_STATUSES.includes(sale.status)) {
    throw errors.conflict(
      sale.status === 'VOIDED'
        ? `${sale.sale_no} was voided, so there is nothing to return against it. A void has already `
          + 'reversed the stock and the money.'
        : `${sale.sale_no} has already been returned in full.`,
      { ruleId: 'POS-301' }
    );
  }

  const reason = assertReasonListed(input.reason);
  const notes = textOrNull(input.notes, { max: 500 });
  const at = textOrNull(input.occurredAt, { max: 40 }) || clock.nowUtc();

  const saleItems = saleRepository.itemsFor(sale.id);
  const resolved = resolveLines({ input: input.lines, sale, saleItems });

  const state = windowState(sale, at);
  const exceptions = exceptionsFor({ resolved, window: state });
  const authorisation = authorisationFor({ actor, approver: input.approver, exceptions });
  const approvalReason = textOrNull(input.approvalReason, { max: 200 });

  const customer = sale.customer_id ? customerRepository.findById(sale.customer_id) : null;
  const account = customer ? creditRepository.findAccountByCustomer(customer.id) : null;

  const totalCentavos = resolved.reduce((sum, line) => sum + line.line_total_centavos, 0);
  if (totalCentavos <= 0) {
    // The CHECK on the table refuses it too. Refused here so the sentence names the
    // sale rather than a constraint: a line whose whole value was discounted away is
    // the real case, and it needs an explanation, not a stack trace.
    throw errors.conflict(
      'This return comes to nothing. There is no refund to make and no document to issue.',
      { ruleId: 'POS-301' }
    );
  }

  const refund = splitRefund({ totalCentavos, sale, customer, account });

  const result = db.transaction(() => {
    // POS-501 — no shift, no money, and no stock movement either. Inside the
    // transaction with everything else, so a shift closed between the screen loading
    // and the confirm cannot slip through.
    const shift = shiftService.requireOpenShift(actor, { action: 'process a return' });

    // Allocated after every validation, so a rollback consumes no number (POS-108's
    // reasoning, VR-103's format).
    const returnNo = sequenceService.next('RETURN', { at });
    const returnId = ids.uuidv7();

    // ── POS-306 — the credit transaction, before the header cites it ──
    //
    // Both destinations are one transaction: CR-108 represents store credit as a
    // negative balance, so "reduce what they owe" and "put them in credit" are the
    // same ledger row seen either side of zero.
    let creditTransaction = null;
    const creditMovement = refund.creditCentavos + refund.storeCreditCentavos;
    if (creditMovement > 0) {
      creditTransaction = creditService.post({
        accountId: account.id,
        type: 'RETURN_CREDIT',
        amountCentavos: creditMovement,
        actor,
        documentNo: returnNo,
        saleId: sale.id,
        shiftId: shift.id,
        reason: `${reason} — return against ${sale.sale_no}`,
        occurredAt: at,
      });

      // CR-203, which this rule needed all along: the part of the refund that reduces
      // what they owe is applied to the open invoices, oldest first, exactly as a
      // payment is. Without it the returned sale stayed "open" on the statement and
      // aged towards OVERDUE on money nobody owed — a collection letter for a debt the
      // store itself had cancelled. Anything beyond what is owed allocates to nothing,
      // because it settles nothing: that is the store credit half of CR-108.
      creditService.allocateToDebits({
        accountId: account.id,
        creditTxnId: creditTransaction.transaction.id,
        amountCentavos: creditMovement,
        at,
      });
    }

    returnRepository.insert({
      id: returnId,
      return_no: returnNo,
      sale_id: sale.id,
      customer_id: customer ? customer.id : null,
      shift_id: shift.id,
      status: 'POSTED',
      reason,
      notes,
      total_centavos: totalCentavos,
      refund_credit_centavos: refund.creditCentavos,
      refund_cash_centavos: refund.cashCentavos,
      refund_store_credit_centavos: refund.storeCreditCentavos,
      credit_txn_id: creditTransaction ? creditTransaction.transaction.id : null,
      beyond_window: state.beyond ? 1 : 0,
      approved_by: authorisation.approver ? authorisation.approver.id : null,
      approval_reason: exceptions.length > 0
        ? approvalReason || exceptions.map((e) => e.message).join(' ')
        : null,
      occurred_at: at,
      created_at: clock.nowUtc(),
      created_by: actor.id,
    });

    const posted = [];

    for (const line of resolved) {
      // ── POS-303 — the movement that says the goods came back ──
      //
      // Posted for both dispositions. A write-off that posted only the DAMAGE out
      // would show stock leaving a shelf it never returned to, and the ledger would
      // have no row saying the customer brought anything back at all.
      const back = inventoryService.post({
        productId: line.product_id,
        type: 'CUSTOMER_RETURN',
        qtyMilli: line.qty_milli,
        actor,
        reason: `${reason} — ${returnNo} against ${sale.sale_no}`,
        referenceType: 'sale_return',
        referenceId: returnId,
        referenceNo: returnNo,
        occurredAt: at,
      });

      // ── POS-303 / POS-304 — and the one that says they are not saleable ──
      //
      // Two rows, netting to zero, rather than one movement of nothing. INV-102 is
      // why: what actually happened is that goods came back and were condemned, and
      // both halves of that are things somebody will later need to count.
      let writeOff = null;
      if (line.disposition === 'WRITE_OFF') {
        writeOff = inventoryService.post({
          productId: line.product_id,
          type: 'DAMAGE',
          qtyMilli: line.qty_milli,
          actor,
          reason: line.default_reason
            || `Returned goods not fit for resale — ${returnNo} (POS-303)`,
          referenceType: 'sale_return',
          referenceId: returnId,
          referenceNo: returnNo,
          occurredAt: at,
        });
      }

      returnRepository.insertItem({
        id: ids.uuidv7(),
        return_id: returnId,
        line_no: line.line_no,
        sale_item_id: line.sale_item_id,
        product_id: line.product_id,
        product_name_snapshot: line.product_name_snapshot,
        qty_milli: line.qty_milli,
        unit_price_centavos: line.unit_price_centavos,
        unit_cost_centavos: line.unit_cost_centavos,
        tax_centavos: line.tax_centavos,
        line_total_centavos: line.line_total_centavos,
        disposition: line.disposition,
        default_disposition: line.default_disposition,
        restock_approved_by: line.overrides_default && authorisation.approver
          ? authorisation.approver.id
          : (line.overrides_default ? actor.id : null),
        return_movement_id: back.movement.id,
        write_off_movement_id: writeOff ? writeOff.movement.id : null,
      });

      // ── POS-301's running total on the sale ──
      //
      // Set to the absolute figure the check above already computed, not incremented:
      // an increment is a second route to a number we already have, and two routes to
      // one number is one of them being wrong eventually.
      saleRepository.setReturnedQty(line.sale_item_id, line.cumulative_returned_milli);

      posted.push({
        product: line.product_name_snapshot,
        qty_milli: line.qty_milli,
        disposition: line.disposition,
        default_disposition: line.default_disposition,
        restocked_against_default: line.overrides_default,
        line_total_centavos: line.line_total_centavos,
        return_movement_id: back.movement.id,
        write_off_movement_id: writeOff ? writeOff.movement.id : null,
        // POS-303's net effect, said out loud: a restock adds, a write-off nets zero.
        net_stock_milli: line.disposition === 'RESTOCK' ? line.qty_milli : 0,
      });
    }

    // ── POS-107, the one status move a return is allowed to make ──
    const status = saleStatusAfter(sale.id);
    if (status !== sale.status) saleRepository.setStatus(sale.id, status);

    auditService.write({
      actor,
      approver: authorisation.approver,
      action: 'SALE_RETURNED',
      entityType: 'sale_returns',
      entityId: returnId,
      before: { sale_no: sale.sale_no, sale_status: sale.status },
      after: {
        return_no: returnNo,
        sale_no: sale.sale_no,
        sale_status: status,
        customer: customer ? customer.name : null,
        total_centavos: totalCentavos,
        refund_credit_centavos: refund.creditCentavos,
        refund_cash_centavos: refund.cashCentavos,
        refund_store_credit_centavos: refund.storeCreditCentavos,
        beyond_window: state.beyond,
        days_since_sale: state.elapsedDays,
        lines: posted,
        authorisation_required: authorisation.required,
        self_authorised: authorisation.selfAuthorised,
      },
      reason: `${reason} — return against ${sale.sale_no}`,
      shiftId: shift.id,
    });

    // AUD-603's own row, one per override, and only where a second person actually
    // authorised it — `recordOverride` refuses an approver who is the actor.
    if (authorisation.approver) {
      for (const exception of exceptions) {
        auditService.recordOverride({
          action: exception.kind === 'RESTOCK_AGAINST_DEFAULT'
            ? 'OVERRIDE_RESTOCK_AGAINST_DEFAULT'
            : 'OVERRIDE_LATE_RETURN',
          actor,
          approver: authorisation.approver,
          reason: approvalReason || exception.message,
          entityType: 'sale_returns',
          entityId: returnId,
          after: { return_no: returnNo, rule_id: exception.ruleId, lines: exception.lines },
          shiftId: shift.id,
        });
      }
    }

    return { returnId, returnNo, shift, creditTransaction, status };
  }, { immediate: true });

  // ── Outside the transaction (INT-1, POS-507) ──────────────────────────────
  //
  // The drawer is hardware. A pulse cannot be rolled back, and a stuck drawer must
  // never undo a return whose goods are already back on the counter.
  //
  // No till movement is written for the cash: POS-509 subtracts
  // `sale_returns.refund_cash_centavos` as its own term, and has since TASK-013. A
  // till row as well would take the refund off the expected cash twice.
  const drawer = refund.cashCentavos > 0
    ? drawerService.pulse({
      reason: 'CASH_REFUND', shiftId: result.shift.id, actor, amountCentavos: refund.cashCentavos,
    })
    : null;

  // Requirement 9 — the acknowledgement, in CR-206's shape and carrying TAX-006.
  const view = get(result.returnId);
  const acknowledgement = buildAcknowledgement({ view, actor });
  const printed = documentService.print(acknowledgement);

  return {
    ...view,
    authorisation: {
      required: authorisation.required,
      self_authorised: authorisation.selfAuthorised,
      authorised_by: authorisation.approver ? authorisation.approver.username : null,
      exceptions,
    },
    sale_status: result.status,
    credit_balance_centavos: result.creditTransaction ? result.creditTransaction.balanceCentavos : null,
    store_credit_centavos: result.creditTransaction && result.creditTransaction.balanceCentavos < 0
      ? -result.creditTransaction.balanceCentavos
      : 0,
    withheld_reason: refund.withheldReason,
    acknowledgement,
    printed,
    drawer,
    expected: shiftService.computeExpected(result.shift.id),
  };
}

/**
 * POS-301's status, derived from the lines rather than tracked alongside them.
 *
 * Every line fully back is `RETURNED`; anything back at all is `PARTIALLY_RETURNED`.
 * Derived because the alternative is a second counter to keep in step with the first,
 * and this one is read once per return.
 */
function saleStatusAfter(saleId) {
  const items = saleRepository.itemsFor(saleId);
  const returned = items.map((item) => returnRepository.returnedQtyFor(item.id));

  if (returned.every((qty, index) => qty >= items[index].qty_milli)) return 'RETURNED';
  if (returned.some((qty) => qty > 0)) return 'PARTIALLY_RETURNED';
  return 'COMPLETED';
}

// ── Requirement 9 — the acknowledgement ─────────────────────────────────────

/**
 * The document the customer is handed.
 *
 * CR-206's shape, applied to a refund: what came back, what it was worth, where the
 * money went, and the number. TASK-014 owns the 58 mm and 80 mm layouts; the content
 * is decided here so the printed paper and the stored row cannot disagree.
 *
 * TAX-006 applies exactly as it does to every other document — documentService refuses
 * to print one whose required notice is missing or whose text has grown a forbidden
 * phrase, and a refund slip is the document most likely to be mistaken for an official
 * one.
 */
function buildAcknowledgement({ view, actor }) {
  const printService = require('./printService');
  const rendered = printService.renderReturnAcknowledgement({
    profile: storeProfileService.profile(),
    document: view.sale_return,
    lines: view.lines,
    receivedBy: actor.username,
  });

  return {
    kind: 'RETURN_ACKNOWLEDGEMENT',
    document_no: view.sale_return.return_no,
    sale_no: view.sale_return.sale_no,
    customer: view.sale_return.customer,
    total_centavos: view.sale_return.total_centavos,
    refund: view.sale_return.refund,
    received_by: actor.username,
    occurred_at: view.sale_return.occurred_at,
    occurred_at_manila: view.sale_return.occurred_at_manila,
    text: rendered.text,
    columns: rendered.columns,
  };
}

// ── The public shape ────────────────────────────────────────────────────────

function presentLine(row) {
  return {
    id: row.id,
    line_no: row.line_no,
    sale_item_id: row.sale_item_id,
    product_id: row.product_id,
    sku: row.sku,
    product_name: row.product_name_snapshot,
    base_unit_code: row.base_unit_code,
    qty_milli: row.qty_milli,
    qty_display: quantity.format(row.qty_milli, row.base_unit_code),
    unit_price_centavos: row.unit_price_centavos,
    unit_cost_centavos: row.unit_cost_centavos,
    tax_centavos: row.tax_centavos,
    line_total_centavos: row.line_total_centavos,
    disposition: row.disposition,
    // POS-304, in the payload: "restocked" and "restocked against the rule" are
    // different facts, and a screen that cannot tell them apart cannot show the
    // second one differently.
    default_disposition: row.default_disposition,
    restocked_against_default: row.disposition === 'RESTOCK' && row.default_disposition === 'WRITE_OFF',
    return_movement_id: row.return_movement_id,
    write_off_movement_id: row.write_off_movement_id,
    net_stock_milli: row.disposition === 'RESTOCK' ? row.qty_milli : 0,
  };
}

function toPublic(row, { lines = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    return_no: row.return_no,
    sale_id: row.sale_id,
    sale_no: row.sale_no,
    sale_occurred_at: row.sale_occurred_at,
    customer: row.customer_id
      ? { id: row.customer_id, name: row.customer_name, code: row.customer_code }
      : null,
    shift_id: row.shift_id,
    status: row.status,
    // POS-206's reasoning: there is one status and no edit path, said in the payload so
    // a screen never offers a button it would then have to explain away.
    is_immutable: true,
    reason: row.reason,
    notes: row.notes,
    total_centavos: row.total_centavos,
    refund: {
      credit_centavos: row.refund_credit_centavos,
      cash_centavos: row.refund_cash_centavos,
      store_credit_centavos: row.refund_store_credit_centavos,
    },
    credit_txn_id: row.credit_txn_id,
    beyond_window: Boolean(row.beyond_window),
    approved_by: row.approved_by_username || null,
    approval_reason: row.approval_reason,
    occurred_at: row.occurred_at,
    occurred_at_manila: clock.toManila(row.occurred_at),
    created_by: row.created_by_username || row.created_by,
    line_count: row.line_count ?? (lines ? lines.length : null),
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function get(id) {
  const row = returnRepository.findById(id);
  if (!row) throw errors.notFound('No such return');
  const lines = returnRepository.itemsFor(id);
  return { sale_return: toPublic(row, { lines }), lines: lines.map(presentLine) };
}

function search(opts = {}) {
  const filters = {
    saleId: textOrNull(opts.saleId, { max: 40 }),
    customerId: textOrNull(opts.customerId, { max: 40 }),
    shiftId: textOrNull(opts.shiftId, { max: 40 }),
    from: textOrNull(opts.from, { max: 40 }),
    to: textOrNull(opts.to, { max: 40 }),
    q: textOrNull(opts.q, { max: 60 }),
  };
  const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0);

  return {
    total: returnRepository.countSearch(filters),
    limit,
    offset,
    returns: returnRepository.search({ ...filters, limit, offset }).map((row) => toPublic(row)),
  };
}

/**
 * One sale, with what is left to return on each line — SCR-305's opening question.
 *
 * The remaining quantity and the default disposition are computed here rather than in
 * the renderer. Both are rules: POS-301's arithmetic and POS-304's list, and a screen
 * that kept its own copy of either would be a screen that disagreed with the refusal
 * it then got.
 */
function returnableFor(saleId) {
  const sale = saleRepository.findById(saleId);
  if (!sale) throw errors.notFound('No such sale');

  const at = clock.nowUtc();
  const state = windowState(sale, at);
  const tenders = saleRepository.tendersFor(sale.id);
  const customer = sale.customer_id ? customerRepository.findById(sale.customer_id) : null;
  const account = customer ? creditRepository.findAccountByCustomer(customer.id) : null;

  const lines = saleRepository.itemsFor(sale.id).map((item) => {
    const product = productRepository.findById(item.product_id);
    const alreadyReturned = returnRepository.returnedQtyFor(item.id);
    const remaining = item.qty_milli - alreadyReturned;
    const declared = defaultDispositionFor(product);

    return {
      sale_item_id: item.id,
      line_no: item.line_no,
      product_id: item.product_id,
      sku: item.product_sku,
      product_name: item.product_name_snapshot,
      base_unit_code: product.base_unit_code,
      sold_qty_milli: item.qty_milli,
      sold_display: quantity.format(item.qty_milli, product.base_unit_code),
      returned_qty_milli: alreadyReturned,
      remaining_qty_milli: Math.max(remaining, 0),
      remaining_display: quantity.format(Math.max(remaining, 0), product.base_unit_code),
      unit_price_centavos: item.unit_price_centavos,
      line_total_centavos: item.line_total_centavos,
      tax_centavos: item.tax_centavos,
      default_disposition: declared.disposition,
      // POS-304: the screen defaults that way **and says why**.
      default_reason: declared.why,
      is_fully_returned: remaining <= 0,
    };
  });

  return {
    sale: {
      id: sale.id,
      sale_no: sale.sale_no,
      status: sale.status,
      occurred_at: sale.occurred_at,
      occurred_at_manila: clock.toManila(sale.occurred_at),
      total_centavos: sale.total_centavos,
      customer: customer ? { id: customer.id, name: customer.name, code: customer.code } : null,
      tenders: tenders.map((t) => ({ method: t.method, amount_centavos: t.amount_centavos })),
      is_returnable: RETURNABLE_STATUSES.includes(sale.status),
    },
    // POS-307, answered before the counter starts typing rather than as a refusal at
    // the end: the panel it opens asks somebody to walk over, and that is a thing to
    // find out at the beginning of a conversation with a customer.
    window: {
      window_days: state.windowDays,
      elapsed_days: state.elapsedDays,
      beyond: state.beyond,
      rule_id: 'POS-307',
    },
    // POS-305, previewed: what the refund would be paid by, before anything is chosen.
    credit: account
      ? {
        account_id: account.id,
        balance_centavos: account.balance_centavos,
        sold_on_credit: tenders.some((t) => t.method === 'CREDIT'),
      }
      : null,
    reasons: returnReasons(),
    lines,
  };
}

/** RPT-101's fourth term, and POS-509's sixth. */
function totals(opts = {}) {
  return returnRepository.returnTotals({
    from: textOrNull(opts.from, { max: 40 }),
    to: textOrNull(opts.to, { max: 40 }),
    shiftId: textOrNull(opts.shiftId, { max: 40 }),
  });
}

module.exports = {
  DISPOSITIONS, AUTHORISING_ROLES, RETURNABLE_STATUSES,
  returnReasons, assertReasonListed, defaultDispositionFor, windowState,
  resolveLines, refundFor, splitRefund, exceptionsFor, authorisationFor,
  saleStatusAfter, buildAcknowledgement,
  presentLine, toPublic, post, get, search, returnableFor, totals,
};
