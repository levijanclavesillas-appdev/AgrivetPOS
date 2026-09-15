'use strict';

// TASK-057 — a backup file, arriving as the request body.
//
// The rest of the API is JSON, and the data import sends its archive base64-encoded in
// it (routes/data.js). A backup does not fit that: it carries every product picture, so
// a store's backup can be hundreds of megabytes, and base64 in a JSON string holds it in
// memory a third larger, twice over. So this one body is the file's own bytes, streamed
// to a temporary file as they arrive — no parser, no new dependency — and the route is
// handed its path. The file is removed when the response is done, whatever happened.

const fs = require('fs');
const os = require('os');
const path = require('path');
const errors = require('../services/errors');

/** Larger than any store's backup this product is sized for, with pictures (NFR_2.2). */
const BACKUP_LIMIT_BYTES = 512 * 1024 * 1024;

function tooBig(limitBytes) {
  return errors.badRequest(
    `That file is larger than ${Math.round(limitBytes / 1048576)} MB, which no Chachi POS backup is.`,
    { ruleId: 'OPS-004' }
  );
}

/**
 * Receive the body into a temporary file, as `req.file = { path, bytes }`.
 *
 * A JSON body is refused rather than read: express.json has already consumed it, and a
 * route written for bytes should say so instead of receiving nothing.
 */
function receiveFile({ limitBytes = BACKUP_LIMIT_BYTES } = {}) {
  return (req, res, next) => {
    if (req.is('application/json')) {
      return next(errors.badRequest('Send the backup file itself, not JSON.', { ruleId: 'OPS-004' }));
    }
    if (Number(req.headers['content-length']) > limitBytes) return next(tooBig(limitBytes));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-upload-'));
    const filePath = path.join(dir, 'upload.zip');
    const out = fs.createWriteStream(filePath, { mode: 0o600 });
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* a temp file is not worth a second failure */ }
    };
    res.on('close', cleanup);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      req.resume();                                    // let the rest arrive and drop it
      next(err);
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) fail(tooBig(limitBytes));
    });
    req.on('aborted', () => fail(errors.badRequest('The upload stopped before the whole file arrived.')));
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      if (bytes === 0) return next(errors.badRequest('No file arrived. Choose the backup file again.', { ruleId: 'OPS-004' }));
      req.file = { path: filePath, bytes };
      return next();
    });
    req.pipe(out);
    return undefined;
  };
}

module.exports = { BACKUP_LIMIT_BYTES, receiveFile };
