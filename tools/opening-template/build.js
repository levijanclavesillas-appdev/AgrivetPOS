'use strict';

// The opening-load workbook, written to disk — for emailing to a client before the
// store has a system to download it from.
//
//   node tools/opening-template/build.js [--industry pharmacy|agrivet] [path]
//
// TASK-053: the examples beside each column are the industry's — paracetamol for a
// pharmacy, hog feed for an agrivet. Without --industry, the declared ones.
//
// The workbook itself is `src/services/openingWorkbookService.js`, which the
// application also serves (GET /data/opening/workbook) and reads back on upload. This
// file only puts the same bytes in a file.

const fs = require('fs');
const path = require('path');
const { workbook, SHEETS, FILE_NAME } = require('../../src/services/openingWorkbookService');

const OUT = path.join(__dirname, '..', '..', 'dist', FILE_NAME);

module.exports = { workbook, SHEETS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--industry');
  const industry = flag === -1 ? null : String(args.splice(flag, 2)[1] || '').toUpperCase();
  const out = args[0] || OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, workbook({ industry }));
  process.stdout.write(`${out}\n`);
}
