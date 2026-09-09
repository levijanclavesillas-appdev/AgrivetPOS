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
const discountRuleService = require('../services/discountRuleService');
const taxService = require('../services/taxService');
const storeProfileService = require('../services/storeProfileService');
const customerService = require('../services/customerService');
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
      lines: lines.map((line) => ({
        productId: line.productId,
        qtyMilli: line.qtyMilli,
        discountCentavos: line.discountCentavos || 0,
        // PR-204 records the reason against a manual discount; PR-206 needs it to say
        // what was suppressed when an automatic one beats it.
        discountReason: line.discountReason || null,
      })),
      customer,
      // TAX-001: the mode is the store's, read at the moment of pricing. A client that
      // sent one would be choosing its own tax treatment.
      taxMode: storeProfileService.taxMode(),
      actorRole: req.session.role,
      approverRole: body.approverRole || null,
      transactionDiscountCentavos: body.transactionDiscountCentavos || 0,
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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
