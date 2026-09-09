'use strict';

// 05_TECH_SPEC.md §4, the rows this task adds:
//
//   POST /data/export           TX-426   OPS-101 — the archive, as a download
//   POST /data/import/validate  TX-427   OPS-102 — the summary, writing nothing
//   POST /data/import           TX-427   OPS-102 – OPS-104 — backup, then one transaction
//   GET  /data/opening/template/:kind  TX-427   OPS-105 — the blank spreadsheet
//   POST /data/opening/validate TX-427   OPS-105 — every row checked, writing nothing
//   POST /data/opening          TX-427   OPS-105 – OPS-107 — backup, then one transaction
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
const openingDataService = require('../services/openingDataService');
const errors = require('../services/errors');
const csvConfig = require('../config/csv');
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

// The opening load is `TX-427` too, and for the reason §10 gives that grant: it writes
// another source's data into this store in one irreversible act. It is milder than a
// restore in that it adds rather than replaces, and worse in that it happens on the one
// day nobody has a second copy of the notebook.
const openingData = [authenticate, requirePermission('TX-427'), archiveBody];

/**
 * The three CSVs off the request body.
 *
 * Sent as text rather than base64, unlike the archive: these are files a person made in
 * a spreadsheet and may well want to see in a request they are debugging. Absent and
 * empty are the same thing — a store loading only balances sends only balances, and it
 * should not have to send two empty strings to say so.
 */
function filesFrom(body) {
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
  return {
    products: pick(body.products),
    stock: pick(body.stock),
    balances: pick(body.balances),
  };
}

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

/**
 * Requirement 2 — the blank spreadsheet, with its columns named as a store would name
 * them and two rows showing what belongs in each.
 *
 * A download rather than JSON, for the same reason the export is: the operator is about
 * to open it in a spreadsheet. It is generated from the validator's own column list, so
 * a template that fails its own validation is not a state this can reach.
 */
router.get('/data/opening/template/:kind', [authenticate, requirePermission('TX-427')], (req, res, next) => {
  try {
    const declared = openingDataService.template(req.params.kind);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${declared.file_name}"`);
    // Excel on a Philippine desktop reads a CSV as the system code page unless the file
    // says otherwise, and a peso sign in a note column comes out as mojibake. The BOM
    // is three bytes that make it open correctly on the machine this will be opened on.
    res.send(csvConfig.BOM + declared.csv);
  } catch (err) {
    next(err);
  }
});

/**
 * `OPS-105` — every row of every file checked, writing nothing.
 *
 * Answers `200` with `ok: false` and the rejected rows, as `/data/import/validate` does
 * and for the same reason: this endpoint succeeding means the check ran. Requirement 7
 * is the whole point of it — an owner rehearses the load, fixes the spreadsheet, and
 * rehearses it again, and none of that should look like a failure.
 */
router.post('/data/opening/validate', openingData, (req, res, next) => {
  try {
    const result = openingDataService.validate(filesFrom(req.body || {}));
    // `parsed` is the rows, kept for `run()`. It is not the caller's, and for a 500-row
    // catalogue it is most of the response.
    const { parsed, ...response } = result;
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * `OPS-105`–`OPS-107` — validate, back up, then one transaction.
 *
 * The service revalidates rather than trusting the call to `/validate`, exactly as the
 * import does: a SKU that was free five minutes ago may have been keyed in by hand
 * since, and the operator's confirmation was about a database that no longer exists.
 */
router.post('/data/opening', openingData, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(openingDataService.run({
      ...filesFrom(body),
      cutoverAt: body.cutoverAt || null,
      reason: body.reason || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
