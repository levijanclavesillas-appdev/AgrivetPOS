'use strict';

// POST /sales/price-check — resolve a whole cart without committing anything
// (05_TECH_SPEC.md §4, TX-401).
//
// The POS screen calls this on every change, and TASK-011's POST /sales runs the same
// computation inside its transaction. One implementation, two callers: what the screen
// previews and what the till charges cannot drift, which is the only way step 2 of
// §4.1 — "re-resolve every line price server-side, never trust the client" — is
// actually true rather than merely stated.

const express = require('express');
const pricingService = require('../services/pricingService');
const saleService = require('../services/saleService');
const discountRuleService = require('../services/discountRuleService');
const printService = require('../services/printService');
const taxService = require('../services/taxService');
const storeProfileService = require('../services/storeProfileService');
const customerService = require('../services/customerService');
const settingsService = require('../services/settingsService');
const openOrderService = require('../services/openOrderService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission('TX-401')];

router.post('/sales/price-check', atTheCounter, (req, res, next) => {
  try {
    const body = req.body || {};
    const lines = Array.isArray(body.lines) ? body.lines : [];

    if (lines.length === 0) {
      throw errors.badRequest('A cart needs at least one line', { ruleId: 'POS-101' });
    }

    // The customer decides the price level (PR-101 level 3) and nothing else here.
    // A walk-in is null, which resolves at retail.
    const customer = body.customerId ? customerService.find(body.customerId) : null;
    if (body.customerId && !customer) throw errors.notFound('No such customer');

    const result = pricingService.priceCart({
      // POS-102: a line may be entered in a pack, and a price is per base unit — so the
      // quantity is resolved to base before it is multiplied by one, through the **same
      // function POST /sales uses**. Priced raw, two sacks would preview as two kilos and
      // be charged as a hundred, which is exactly the drift the head of this file says
      // cannot happen. PR-204's reason travels with a manual discount, because PR-206
      // needs it to say what was suppressed when an automatic one beats it.
      lines: saleService.pricingLinesOf(lines),
      customer,
      // PR-107: a walk-in's cart switched to wholesale.
      priceLevel: body.priceLevel || null,
      // TAX-001: the mode is the store's, read at the moment of pricing. A client that
      // sent one would be choosing its own tax treatment.
      taxMode: storeProfileService.taxMode(),
      actorRole: req.session.role,
      // Who approved is proved in middleware/auth.js, never taken from the body.
      approverRole: body.approver ? body.approver.role : null,
      transactionDiscountCentavos: body.transactionDiscountCentavos || 0,
      // TAX-004, previewed on the same terms it is sold on: the cashier sees the
      // refusal — the store does not grant it, no line is eligible, the ID is
      // incomplete — before the customer is at the payment screen.
      statutory: body.statutory || null,
      // POS-112: the dine-in service charge, previewed as it will be charged.
      serviceChargeBp: openOrderService.serviceChargeBpFor(
        openOrderService.orderTypeOf(body.orderType, { required: false })
      ),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * What the POS screen needs to render a discount field: the acting user's ceiling, who
 * can approve above it, and — since TASK-023 — the rules an owner has configured.
 *
 * Served rather than hard-coded, because every figure here is operator-owned
 * (`OPS-005`) and a screen with its own copy of "2%" or of a tier band is a screen
 * that is wrong the day an owner changes it. `TC-UI-07` enforces exactly this for the
 * settings screen; requirement 7 extends the obligation to the counter.
 */
router.get('/sales/pricing-policy', atTheCounter, (req, res, next) => {
  try {
    res.json({
      tax_mode: storeProfileService.taxMode(),
      computes_tax: taxService.computesTax(storeProfileService.taxMode()),
      vat_rate: taxService.VAT_RATE_LABEL,
      tax_classes: taxService.CLASSES,
      price_levels: pricingService.PRICE_LEVELS,
      precedence: pricingService.precedenceLevels(),
      discount_ceiling_bp: pricingService.roleCeilingBp(req.session.role),
      approving_roles: pricingService.rolesAbove(10000),
      // PR-106's bands, PR-202's capped categories and PR-206's "these do not add".
      // The screen renders them; it decides none of them.
      discount_rules: discountRuleService.policy(),
      // TAX-004 — whether this store grants the statutory discount, at what rate, and
      // on which IDs. The counter needs all three to offer it at all, and a screen
      // carrying its own copy of "20%" is a screen that is wrong the day the statute
      // moves (OPS-005's obligation, applied to a figure the statute owns).
      statutory: {
        rule_id: 'TAX-004',
        enabled: settingsService.get('statutory_discount_enabled'),
        discount_bp: taxService.STATUTORY_DISCOUNT_BP,
        rate_label: taxService.STATUTORY_RATE_LABEL,
        id_types: Object.entries(taxService.STATUTORY_ID_TYPES)
          .map(([id, declared]) => ({ id, label: declared.label, statute: declared.statute })),
        note: 'The 20% is computed before any voluntary discount and the two never add '
          + 'together: the customer receives the larger (TAX-005). In VAT mode the line '
          + 'is exempt and the 20% is taken on the VAT-exclusive amount.',
      },
      // TASK-066: a café's counter — whether orders are taken before payment, how they
      // may be served, the dine-in service charge and whether a kitchen ticket prints.
      orders: {
        rule_id: 'POS-109',
        enabled: openOrderService.enabled(),
        order_types: openOrderService.ORDER_TYPES.map((code) => ({ code, label: printService.ORDER_TYPE_LABELS[code] })),
        service_charge_bp: settingsService.get('service_charge_bp'),
        kitchen_printer: settingsService.get('kitchen_printer'),
        table_max: openOrderService.TABLE_MAX,
        note_max: require('../services/cartService').NOTE_MAX,
      },
      // TASK-070: a sari-sari store's counter — the wholesale switch, quick keys, and
      // who may add a customer from the counter.
      retail: {
        wholesale_switch: { rule_id: 'PR-107', enabled: settingsService.get('wholesale_switch_enabled'), levels: pricingService.CART_LEVELS },
        quick_keys: { rule_id: 'POS-113', enabled: settingsService.get('quick_keys_enabled') },
        counter_customer: {
          may_add: require('../services/permissions').can(req.session, 'TX-413'),
          credit_limit_centavos: settingsService.get('counter_customer_credit_limit_centavos'),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
