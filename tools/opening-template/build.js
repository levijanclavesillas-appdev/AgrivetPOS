'use strict';

// The opening-load workbook, written to disk — for emailing to a client before the
// store has a system to download it from.
//
//   node tools/opening-template/build.js [path]
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
  const out = process.argv[2] || OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, workbook());
  process.stdout.write(`${out}\n`);
}
