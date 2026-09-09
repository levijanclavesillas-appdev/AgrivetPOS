'use strict';

// 05_TECH_SPEC.md §4, the rows this task adds:
//
//   POST /data/export           TX-426   OPS-101 — the archive, as a download
//   POST /data/import/validate  TX-427   OPS-102 — the summary, writing nothing
//   POST /data/import           TX-427   OPS-102 – OPS-104 — backup, then one transaction
//
// **Export is `TX-426` and import is `TX-427`, which is the restore grant.** §10 gives
// `TX-427` to the owner alone, and that is right: importing an archive over a trading
// store replaces data the same way a restore does, and the difference between them is
// the file format rather than the consequence.
//
// `/data/import/validate` exists as its own endpoint because `OPS-102` asks for a
// summary the operator confirms **before** anything is written. A single endpoint with
// a `dryRun` flag would put the safety of the rule inside a boolean somebody can
// forget to send.
//
// The archive arrives base64-encoded in JSON rather than as multipart. The whole API
// is JSON in, JSON out (§4), the renderer is vanilla with no build step, and an export
// of a store this product is sized for is a few megabytes — a multipart parser would
// be the fifth runtime dependency for one route.

const express = require('express');
const exportService = require('../services/exportService');
const importService = require('../services/importService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

/**
 * A body limit of its own, for the two routes that carry an archive.
 *
 * `app.js` parses JSON at 1 MB, which is generous for every other route in this API
 * and far too small for an export of a trading store. Raising it globally would widen
 * the surface of every endpoint to make two of them work, so the larger parser is
 * mounted here and nowhere else.
 *
 * 64 MB is roughly a store at `NFR_2.2`'s five-year ceiling, exported and compressed,
 * with room to spare. It is a limit rather than none at all because an unbounded body
 * on an authenticated endpoint is still a way to exhaust a store PC's memory.
 */
const archiveBody = express.json({ limit: '64mb' });

const exportData = [authenticate, requirePermission('TX-426')];
const importData = [authenticate, requirePermission('TX-427'), archiveBody];

/** The upload, as bytes. Refused with a sentence rather than a stack trace. */
function archiveFrom(body) {
  const encoded = body && body.archive;
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw errors.badRequest(
      'Send the archive as base64 in an "archive" field.',
      { ruleId: 'OPS-102' }
    );
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0) {
    throw errors.badRequest('That archive is empty.', { ruleId: 'OPS-102' });
  }
  return buffer;
}

/**
 * `OPS-101` — the whole store as one archive.
 *
 * Sent as a file download rather than as JSON carrying base64: the operator is saving
 * it to a USB stick, and a browser saving a `.zip` is a thing that already works.
 */
router.post('/data/export', exportData, (req, res, next) => {
  try {
    const result = exportService.run(req.session);

    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${result.file_name}"`);
    // The manifest's own figures, in headers, so a caller that only wants to know what
    // it got does not have to unzip the body to find out.
    res.setHeader('x-export-checksum', result.manifest.checksum);
    res.setHeader('x-export-rows', String(result.manifest.total_rows));
    res.send(result.archive);
  } catch (err) {
    next(err);
  }
});

/**
 * `OPS-102` — the complete validation pass, writing nothing.
 *
 * Answers `200` with `ok: false` and the problems rather than a `400`, because this
 * endpoint succeeding means "the check ran", not "the archive is good". A screen
 * showing an operator what is wrong with an archive is doing exactly what the rule
 * asks for, and it should not have to read that out of an error body.
 */
router.post('/data/import/validate', importData, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = importService.validate(archiveFrom(body), {
      collisionMode: body.collisionMode || 'SKIP',
    });
    // `_parsed` is the archive's rows, kept for `run()`. It is not the caller's.
    const { _parsed, ...response } = result;
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * `OPS-102`–`OPS-104` — validate, back up, then one transaction.
 *
 * The service revalidates rather than trusting a prior call to `/validate`: between the
 * two requests somebody may have traded, and a summary the operator confirmed five
 * minutes ago is not a fact about the database now.
 */
router.post('/data/import', importData, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(importService.run(archiveFrom(body), {
      collisionMode: body.collisionMode || 'SKIP',
      reason: body.reason || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
