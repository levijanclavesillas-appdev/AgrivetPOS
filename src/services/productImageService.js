'use strict';

// A product's picture — TASK-052, IMG-001 – IMG-002 (docs/PHARMACY_EDITION.md §7).
//
// ## What arrives (IMG-001)
//
// Two pictures, as base64 in the JSON body: `image`, at most 640 px on its long side, for
// the editor, and `thumb`, at most 128 px, for every list. The renderer makes both on a
// canvas from whatever the camera or the file gave it, so a 12-megapixel phone photo
// never crosses the API. This service does not trust that it did: each is checked to be
// a JPEG, PNG or WebP by its first bytes — never by a name or a type somebody declared —
// and to be inside its size. SVG is not among them, because an SVG is a document that
// can carry script, and a picture here is only ever a picture.
//
// ## Who (IMG-002)
//
// Whoever may edit the product (TX-410). Setting and removing are audited, with the
// picture's hash rather than the picture: the trail says which picture, not what it was.

const crypto = require('crypto');
const db = require('../config/database');
const clock = require('../config/clock');
const errors = require('./errors');
const permissions = require('./permissions');
const auditService = require('./auditService');
const productRepository = require('../repositories/productRepository');
const productImageRepository = require('../repositories/productImageRepository');

const LIMITS = Object.freeze({ image: 600 * 1024, thumb: 64 * 1024 });

/** The format, by magic number. Null for anything that is not one of the three. */
function sniff(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decode(value, label, limit) {
  if (typeof value !== 'string' || value.length === 0) {
    throw errors.badRequest(`The ${label} is missing.`, { ruleId: 'IMG-001' });
  }
  const base64 = value.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw errors.badRequest(`The ${label} is not base64.`, { ruleId: 'IMG-001' });
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > limit) {
    throw errors.badRequest(
      `The ${label} is ${Math.ceil(bytes.length / 1024)} KB; the most is ${limit / 1024} KB. `
      + 'The POS shrinks a photo before sending it — choose the photo again.',
      { ruleId: 'IMG-001' }
    );
  }
  const mime = sniff(bytes);
  if (!mime) {
    throw errors.badRequest(`The ${label} is not a JPEG, PNG or WebP picture.`, { ruleId: 'IMG-001' });
  }
  return { bytes, mime };
}

function assertMayEdit(actor) {
  if (!permissions.can(actor, 'TX-410')) {
    throw errors.forbidden('You do not have permission to change a product’s picture.', {
      ruleId: 'IMG-002', requiresRole: permissions.rolesHolding('TX-410').join(' or '),
    });
  }
}

function productOrThrow(productId) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  return product;
}

const version = (sha256) => (sha256 ? sha256.slice(0, 16) : null);

const describe = (meta) => (meta ? {
  version: version(meta.sha256),
  mime: meta.mime,
  image_bytes: meta.image_bytes,
  thumb_bytes: meta.thumb_bytes,
  updated_at: meta.updated_at,
} : null);

/** IMG-001, IMG-002: set or replace the picture. */
function set(productId, { image, thumb } = {}, actor) {
  assertMayEdit(actor);
  const product = productOrThrow(productId);
  const full = decode(image, 'picture', LIMITS.image);
  const small = decode(thumb, 'thumbnail', LIMITS.thumb);
  if (full.mime !== small.mime) {
    throw errors.badRequest('The picture and its thumbnail are different formats.', { ruleId: 'IMG-001' });
  }

  const before = productImageRepository.meta(productId);
  const sha256 = crypto.createHash('sha256').update(full.bytes).digest('hex');
  if (before && before.sha256 === sha256) return describe(before);

  const at = clock.nowUtc();
  return db.transaction(() => {
    const meta = productImageRepository.upsert({
      product_id: productId, sha256, mime: full.mime,
      image_bytes: full.bytes.length, thumb_bytes: small.bytes.length,
      updated_at: at, updated_by: actor.id || null,
      thumb: small.bytes, image: full.bytes,
    });
    auditService.write({
      actor,
      action: 'PRODUCT_IMAGE_SET',
      entityType: 'products',
      entityId: productId,
      before: before ? { image: version(before.sha256) } : null,
      after: { sku: product.sku, image: version(sha256), bytes: full.bytes.length },
    });
    return describe(meta);
  });
}

/** IMG-002: take the picture off. Nothing references it, so it goes rather than being hidden. */
function remove(productId, actor) {
  assertMayEdit(actor);
  const product = productOrThrow(productId);
  const before = productImageRepository.meta(productId);
  if (!before) return null;
  return db.transaction(() => {
    productImageRepository.remove(productId);
    auditService.write({
      actor,
      action: 'PRODUCT_IMAGE_REMOVED',
      entityType: 'products',
      entityId: productId,
      before: { sku: product.sku, image: version(before.sha256) },
    });
    return null;
  });
}

/** The bytes of one size, for the route that serves them. */
function read(productId, size) {
  const found = productImageRepository.picture(productId, size === 'thumb' ? 'thumb' : 'image');
  if (!found) throw errors.notFound('This product has no picture');
  return { bytes: found.bytes, mime: found.mime, version: version(found.sha256) };
}

module.exports = { LIMITS, sniff, version, set, remove, read };
