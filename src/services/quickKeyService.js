'use strict';

// POS-113 — quick keys: the store's own buttons at the counter, for goods with no barcode
// (TASK-070). Pressing one is scanning that product, or that pack of it.
//
// The set is written whole, like PR-104's quantity breaks: positions are a property of
// the arrangement, not of one key, and a screen that moves a key moves two.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const productRepository = require('../repositories/productRepository');
const quickKeyRepository = require('../repositories/quickKeyRepository');

const MAX_KEYS = 24;
const LABEL_MAX = 24;

const present = (row) => ({
  id: row.id,
  position: row.position,
  product_id: row.product_id,
  pack_unit_id: row.pack_unit_id,
  pack_unit_code: row.pack_unit_code,
  pack_factor_milli: row.pack_factor_milli,
  label: row.label || row.product_name,
  product_name: row.product_name,
  sku: row.sku,
  base_unit_code: row.base_unit_code,
  // A key whose product was withdrawn, or whose pack was removed, is shown and refused.
  usable: Boolean(row.is_active) && (!row.pack_unit_id || row.pack_factor_milli !== null),
  image_version: row.image_sha256 ? row.image_sha256.slice(0, 16) : null,
});

function list() {
  return {
    enabled: Boolean(settingsService.get('quick_keys_enabled')),
    max: MAX_KEYS,
    keys: quickKeyRepository.list().map(present),
  };
}

/**
 * The whole arrangement: `[{ productId, packUnitId?, label? }]`, first is position 1.
 * An empty list clears the keys.
 */
function replace(keys, actor) {
  if (!Array.isArray(keys)) throw errors.badRequest('Quick keys are a list', { ruleId: 'POS-113' });
  if (keys.length > MAX_KEYS) {
    throw errors.badRequest(`There are at most ${MAX_KEYS} quick keys.`, { ruleId: 'POS-113' });
  }
  const at = clock.nowUtc();
  const seen = new Set();
  const rows = keys.map((key, index) => {
    const product = key && key.productId ? productRepository.findById(key.productId) : null;
    if (!product) throw errors.badRequest(`Quick key ${index + 1} has no product.`, { ruleId: 'POS-113' });
    if (!product.is_active) {
      throw errors.conflict(`${product.name} is withdrawn and cannot be a quick key.`, { ruleId: 'INV-105' });
    }
    const packUnitId = key.packUnitId || null;
    if (packUnitId && packUnitId !== product.base_unit_id
        && !productRepository.packsFor(product.id).some((p) => p.unit_id === packUnitId)) {
      throw errors.badRequest(`${product.name} has no such pack.`, { ruleId: 'UOM-002' });
    }
    const unit = packUnitId === product.base_unit_id ? null : packUnitId;
    const identity = `${product.id}:${unit || ''}`;
    if (seen.has(identity)) {
      throw errors.badRequest(`${product.name} is already a quick key.`, { ruleId: 'POS-113' });
    }
    seen.add(identity);
    const label = typeof key.label === 'string' ? key.label.trim().slice(0, LABEL_MAX) : '';
    return {
      id: ids.uuidv7(), position: index + 1, product_id: product.id, pack_unit_id: unit,
      label: label || null, created_at: at, created_by: actor.id || null,
    };
  });

  return db.transaction(() => {
    const before = quickKeyRepository.list().map((k) => k.product_name + (k.pack_unit_code ? ` (${k.pack_unit_code})` : ''));
    quickKeyRepository.replaceAll(rows);
    const after = list();
    auditService.write({
      actor,
      action: 'QUICK_KEYS_CHANGED',
      entityType: 'quick_keys',
      entityId: 'counter',
      before: { keys: before },
      after: { keys: after.keys.map((k) => k.product_name + (k.pack_unit_code ? ` (${k.pack_unit_code})` : '')) },
    });
    return after;
  });
}

/**
 * A new store's first keys: up to 8 of its products with no barcode, in name order, so
 * the counter has something to press on day one. Only where there are none yet.
 */
function suggest(actor) {
  if (quickKeyRepository.list().length > 0) return list();
  const picks = db.get().prepare(`
    SELECT p.id FROM products p
     WHERE p.is_active = 1
       AND NOT EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id)
     ORDER BY p.name COLLATE NOCASE
     LIMIT 8
  `).all();
  if (picks.length === 0) return list();
  return replace(picks.map((p) => ({ productId: p.id })), actor);
}

module.exports = { MAX_KEYS, list, replace, suggest };
