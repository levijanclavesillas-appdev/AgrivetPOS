'use strict';

// 05_TECH_SPEC.md §4: every error is { code, message, rule_id, requires_role }, and
// §8.6 makes the rule id part of the contract — "a refusal the UI cannot explain is an
// unfinished refusal". Building them in one place is what stops half the routes from
// omitting the rule id.

class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', ruleId = null, requiresRole = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.ruleId = ruleId;
    this.requiresRole = requiresRole;
  }
}

const badRequest = (message, opts = {}) => new AppError(message, { status: 400, code: 'BAD_REQUEST', ...opts });
const unauthorized = (message, opts = {}) => new AppError(message, { status: 401, code: 'UNAUTHORIZED', ...opts });
const forbidden = (message, opts = {}) => new AppError(message, { status: 403, code: 'FORBIDDEN', ...opts });
const notFound = (message, opts = {}) => new AppError(message, { status: 404, code: 'NOT_FOUND', ...opts });
const conflict = (message, opts = {}) => new AppError(message, { status: 409, code: 'CONFLICT', ...opts });
const locked = (message, opts = {}) => new AppError(message, { status: 423, code: 'ACCOUNT_LOCKED', ...opts });

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, locked };
