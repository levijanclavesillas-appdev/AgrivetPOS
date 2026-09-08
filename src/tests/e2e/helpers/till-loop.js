'use strict';

// A child process that rings sales in a loop until it is killed.
//
// Driven by TC-E2E-09. It writes one line per committed sale to stdout and flushes
// before returning, so the parent knows exactly which sales the child believed were
// committed at the moment it died — which is the only way to tell "lost a committed
// sale" apart from "never committed it".

const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
process.env.NODE_ENV = 'test';
process.env.AGRIVET_BCRYPT_COST = process.env.AGRIVET_BCRYPT_COST || '4';

const db = require(path.join(ROOT, 'src/config/database'));
const authService = require(path.join(ROOT, 'src/services/authService'));
const saleService = require(path.join(ROOT, 'src/services/saleService'));

const dbPath = process.env.LOOP_DB;
const username = process.env.LOOP_USER;
const password = process.env.LOOP_PASSWORD;
const productId = process.env.LOOP_PRODUCT;
const shiftId = process.env.LOOP_SHIFT;

db.open({ path: dbPath });

const session = { ...authService.verifyToken(authService.login({ username, password }).token), shiftId };

// One line per committed sale, written synchronously so a SIGKILL between the commit
// and the write cannot lose the record of it.
const say = (line) => require('fs').writeSync(1, `${line}\n`);

say('READY');

for (;;) {
  const result = saleService.complete({
    lines: [{ productId, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 6000 }],
  }, session);
  say(`SALE ${result.sale.sale_no} ${result.sale.id}`);
}
