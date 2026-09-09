'use strict';

// The audit service's pure parts: the action table, redaction, and the two integrity
// guards that cannot be expressed as a runtime check.
//
// TC-UT-07 is the SEC-11 guard. "audit_logs has no UPDATE or DELETE path in any
// repository" is a property of the source, not of a running system — a test that
// inserts a row and tries to delete it can only prove the method it happens to know
// about is absent. This reads the repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const auditService = require('../../services/auditService');

const root = path.join(__dirname, '..', '..', '..');

// ── AUD-601: the action table is the rule's list ────────────────────────────

/**
 * AUD-601 names its audited mutations in prose. This maps each phrase to the constants
 * implementing it, and the rule's own text is parsed below — so a mutation added to
 * 03_BUSINESS_RULES.md without a constant here fails the build.
 */
const AUD_601_MUTATIONS = {
  'price change': ['PRICE_CHANGED'],
  'cost change': ['COST_CHANGED'],
  'discount rule change': ['DISCOUNT_RULE_CHANGED'],
  'credit limit change': ['CREDIT_LIMIT_CHANGED'],
  'inventory adjustment': ['INVENTORY_ADJUSTED'],
  'stock count posting': ['STOCK_COUNT_POSTED'],
  'sale void': ['SALE_VOIDED'],
  return: ['SALE_RETURNED'],
  'receipt reprint': ['RECEIPT_REPRINTED'],
  'user create/modify/deactivate': ['USER_CREATED', 'USER_MODIFIED', 'USER_DEACTIVATED'],
  'role change': ['ROLE_CHANGED'],
  'permission change': ['PERMISSION_CHANGED'],
  'tax mode change': ['TAX_MODE_CHANGED'],
  'settings change': ['SETTING_CHANGED'],
  'data import': ['DATA_IMPORTED'],
  'data export': ['DATA_EXPORTED', 'AUDIT_EXPORTED'],
  'backup restore': ['BACKUP_RESTORED'],
  'password reset': ['PASSWORD_RESET', 'OWNER_PASSWORD_RECOVERED'],
  'login failure beyond threshold': ['LOGIN_LOCKED'],
};

/** The six overrides AUD-603 names, each of which needs two actors. */
const AUD_603_OVERRIDES = {
  'discount above ceiling': 'OVERRIDE_DISCOUNT_ABOVE_CEILING',
  'over-limit credit': 'OVERRIDE_CREDIT_OVER_LIMIT',
  'below-cost sale': 'OVERRIDE_BELOW_COST_SALE',
  'expired-stock sale': 'OVERRIDE_EXPIRED_STOCK_SALE',
  'over-receipt': 'OVERRIDE_OVER_RECEIPT',
  'cost variance': 'OVERRIDE_COST_VARIANCE',
  // POS-304 and POS-307, added by TASK-020. The first is the override worth having a
  // row of its own: it is the one that says a medicine went back on the shelf.
  'restock against default': 'OVERRIDE_RESTOCK_AGAINST_DEFAULT',
  'late return': 'OVERRIDE_LATE_RETURN',
};

/**
 * The rule's own definition row, not a cross-reference to it.
 *
 * Anchoring on the start of the table row matters: `AUD-603` is cited by PR-105,
 * PR-204 and CR-104 long before its own row, and a first-match search reads one of
 * those instead — a guard that then checks the wrong sentence and passes for the
 * wrong reason.
 */
const ruleLine = (id) => {
  const rules = fs.readFileSync(path.join(root, 'docs', '03_BUSINESS_RULES.md'), 'utf8');
  const line = rules.split('\n').find((l) => l.startsWith(`| \`${id}\` |`));
  assert.ok(line, `${id} has no definition row in 03_BUSINESS_RULES.md`);
  return line;
};

test('TC-UT-07: every mutation AUD-601 names has a registered action', () => {
  const text = ruleLine('AUD-601');

  for (const [mutation, actions] of Object.entries(AUD_601_MUTATIONS)) {
    assert.ok(text.includes(mutation), `AUD-601 no longer names "${mutation}" — update the mapping`);
    for (const action of actions) {
      assert.ok(auditService.isKnownAction(action), `AUD-601 names "${mutation}" but ${action} is not registered`);
    }
  }

  // The rule's list is the comma-separated tail after the colon. Counting it catches a
  // mutation added to the document that nobody added to ACTIONS.
  const listed = text.split('without exception:')[1].split('.')[0].split(',').map((s) => s.trim());
  assert.equal(listed.length, Object.keys(AUD_601_MUTATIONS).length,
    `AUD-601 lists ${listed.length} mutations; the mapping covers ${Object.keys(AUD_601_MUTATIONS).length}: ${listed.join(' | ')}`);
});

test('TC-UT-07: every override AUD-603 names is registered as a two-actor action', () => {
  const text = ruleLine('AUD-603');

  for (const [override, action] of Object.entries(AUD_603_OVERRIDES)) {
    assert.ok(text.includes(override), `AUD-603 no longer names "${override}"`);
    assert.ok(auditService.ACTIONS[action].override, `${action} must be marked as an override`);
  }
  assert.deepEqual(
    [...auditService.OVERRIDE_ACTIONS].sort(),
    Object.values(AUD_603_OVERRIDES).sort(),
    "the override set is exactly the one AUD-603 enumerates"
  );
});

test('every registered action carries a label and the rule that requires it', () => {
  for (const [name, declared] of Object.entries(auditService.ACTIONS)) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name}: actions are SCREAMING_SNAKE_CASE`);
    assert.ok(declared.what && declared.what.length > 5, `${name}: SCR-703 lists this label`);
    assert.match(declared.rule, /^(AUD-60[1-6]|SEC-\d+|VR-\d+|CR-\d+|POS-\d+|PO-\d+|OPS-\d+|FR_[\d.]+)$/, `${name}: name the rule requiring it`);
  }
});

test('an unregistered action is a programming error, not a silent second name', () => {
  // Requirement 2: a bare string typo would otherwise create an action that no filter
  // and no report ever finds.
  assert.throws(() => auditService.assertKnownAction('PRICE_CHANGE'), RangeError);
  assert.throws(() => auditService.describe('nope'), RangeError);
  assert.equal(auditService.isKnownAction('PRICE_CHANGED'), true);
});

// ── SEC-1: redaction, in the service rather than in every caller ────────────

test('a hash placed in a before/after payload is stripped by the service', () => {
  const bcryptHash = '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';
  const payload = {
    username: 'nena',
    password_hash: bcryptHash,
    pin_hash: '$2b$04$0123456789012345678901uvwxyzABCDEFGHIJKLMNOPQRSTUVWXY',
    recovery_code_hash: bcryptHash,
    nested: { token: 'abc', deeper: { secret: 'shh' } },
  };

  const redacted = auditService.redact(payload);

  assert.equal(redacted.username, 'nena', 'only the credentials go');
  for (const key of ['password_hash', 'pin_hash', 'recovery_code_hash']) {
    assert.equal(redacted[key], auditService.REDACTED, key);
  }
  assert.equal(redacted.nested.token, auditService.REDACTED);
  assert.equal(redacted.nested.deeper.secret, auditService.REDACTED);
  assert.equal(JSON.stringify(redacted).includes(bcryptHash), false, 'no hash survives anywhere');
});

test('a credential is stripped by its shape, whatever field it arrived in', () => {
  // The net that matters: a hash that arrives inside a field nobody thought to name.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const redacted = auditService.redact({
    note: '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
    session: jwt,
    printed_code: 'SR82-9SWP-QMHZ-GK6A',
    ordinary: 'a perfectly normal reason',
  });

  assert.equal(redacted.note, auditService.REDACTED, 'bcrypt shape');
  assert.equal(redacted.session, auditService.REDACTED, 'JWT shape');
  assert.equal(redacted.printed_code, auditService.REDACTED, 'a recovery code (SEC-5)');
  assert.equal(redacted.ordinary, 'a perfectly normal reason');
});

test('redaction keeps the fact that a credential changed', () => {
  // AUD-601 wants a password reset on the trail. "password_changed: true" is the fact;
  // the password is the secret. A key-name rule that blanks both records nothing.
  const redacted = auditService.redact({ password_changed: true, pin_set: true, pin_cleared: false });
  assert.deepEqual(redacted, { password_changed: true, pin_set: true, pin_cleared: false });
});

test('redaction handles arrays, nulls and pathological nesting without throwing', () => {
  assert.equal(auditService.redact(null), null);
  assert.equal(auditService.redact(undefined), undefined);
  assert.deepEqual(auditService.redact([{ pin: '284917' }, 42]), [{ pin: auditService.REDACTED }, 42]);

  let deep = { value: 'bottom' };
  for (let i = 0; i < 40; i += 1) deep = { deep };
  assert.doesNotThrow(() => JSON.stringify(auditService.redact(deep)));
});

// ── Date filters (VR-102) ───────────────────────────────────────────────────

test('a date filter is a Manila calendar day, stored and compared as UTC', () => {
  // An owner filtering "7 September" means their own day. Treating it as a UTC window
  // would start it at eight in the morning and lose the first eight hours of trading.
  assert.equal(auditService.dayStartUtc('2026-09-07'), '2026-09-06T16:00:00.000Z');
  assert.equal(auditService.dayEndUtc('2026-09-07'), '2026-09-07T15:59:59.999Z');
  assert.throws(() => auditService.dayStartUtc('07/09/2026'), (e) => e.ruleId === 'VR-102');
});

// ── SEC-11: the integrity guard ─────────────────────────────────────────────

test('TC-UT-07: no repository has an UPDATE or DELETE path on audit_logs', () => {
  // AUD-605 / SEC-11. The control is the absence of the code, so the check reads the
  // source: a runtime test can only prove the one method it knows about is missing.
  const dir = path.join(root, 'src', 'repositories');
  const offenders = [];

  // Only string literals are examined, for the reason TC-UT-99 gives: scanning raw
  // source matches English prose — including the comment in auditRepository.js that
  // explains this very rule — and a guard that cries wolf gets weakened until it
  // catches nothing. Real SQL is always in a string.
  const literals = (line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '');

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    // Verbs assembled from fragments so this file does not match its own pattern.
    for (const verb of ['UP' + 'DATE', 'DEL' + 'ETE', 'DR' + 'OP', 'TRUN' + 'CATE']) {
      const pattern = new RegExp(`${verb}[\\s\\S]{0,60}audit_logs`, 'i');
      const found = source.split('\n').some((line) => literals(line).some((lit) => pattern.test(lit)))
        || pattern.test(source.match(/`[\s\S]*?`/g) ? source.match(/`[\s\S]*?`/g).join('\n') : '');
      if (found) offenders.push(`src/repositories/${file} has a ${verb} path on audit_logs`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('TC-UT-07: the audit repository exports no mutating method beyond insert', () => {
  const repository = require('../../repositories/auditRepository');
  const mutating = Object.keys(repository).filter((name) => /update|delete|remove|purge|prune|clear|truncate/i.test(name));

  assert.deepEqual(mutating, [], `AUD-605: ${mutating.join(', ')} must not exist`);
  assert.deepEqual(Object.keys(repository).sort(), ['actors', 'count', 'countAll', 'insert', 'list']);
});

// ── CSV ─────────────────────────────────────────────────────────────────────

test('the CSV export quotes every cell and doubles an embedded quote', () => {
  assert.deepEqual(auditService.CSV_COLUMNS[0], 'occurred_at_utc');
  assert.ok(auditService.CSV_COLUMNS.includes('approver_username'), 'AUD-603 survives the export');
  assert.ok(auditService.CSV_COLUMNS.includes('before') && auditService.CSV_COLUMNS.includes('after'));
});
