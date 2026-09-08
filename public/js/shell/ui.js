// 04_UX_SPEC.md §5 — the five states, and §4's toasts, as the only place they are
// built. A view that hand-rolls its own empty state is a view whose empty state says
// something different from every other one.

export const h = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
};

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

/** Loading: a skeleton, never a spinner over stale data (§5). */
export function loading(el, { rows = 3 } = {}) {
  clear(el).append(h('div', { class: 'state state-loading', 'aria-busy': 'true' },
    Array.from({ length: rows }, () => h('div', { class: 'skeleton' }))));
}

/** Empty: what it is, and the one action that fills it. */
export function empty(el, { title, action = null, onAction = null }) {
  clear(el).append(h('div', { class: 'state state-empty' }, [
    h('p', { class: 'state-title', text: title }),
    action ? h('button', { class: 'primary', text: action, onclick: onAction }) : null,
  ]));
}

/** Error: what failed and what to do, never a stack trace. */
export function error(el, { message, retry = null }) {
  clear(el).append(h('div', { class: 'state state-error', role: 'alert' }, [
    h('p', { text: message }),
    retry ? h('button', { text: 'Try again', onclick: retry }) : null,
  ]));
}

/**
 * Refused: the rule's plain-language text and who may authorise it.
 *
 * The rule id is shown because 05_TECH_SPEC.md §8.6 makes it part of the contract —
 * a cashier reading "PR-203" to an owner over the phone is the fastest support call
 * this product will ever have.
 */
export function refused(el, apiError, { onAuthorise = null } = {}) {
  clear(el).append(h('div', { class: 'state state-refused', role: 'alert' }, [
    h('p', { class: 'refusal-message', text: apiError.message }),
    apiError.requiresRole
      ? h('p', { class: 'refusal-role', text: `A ${apiError.requiresRole.toLowerCase()} can authorise this.` })
      : null,
    apiError.ruleId ? h('p', { class: 'refusal-rule', text: apiError.ruleId }) : null,
    onAuthorise && apiError.requiresRole
      ? h('button', { class: 'primary', text: 'Get authorisation', onclick: onAuthorise })
      : null,
  ]));
}

// ── Toasts (§4) ─────────────────────────────────────────────────────────────

let toastHost = null;

function host() {
  if (!toastHost) {
    // aria-live so a refusal is announced rather than only shown (§8).
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(toastHost);
  }
  return toastHost;
}

/** Success auto-dismisses in 3 s; an error persists until dismissed (§4). */
export function toast(message, { kind = 'success' } = {}) {
  const node = h('div', { class: `toast toast-${kind}`, role: kind === 'success' ? 'status' : 'alert' }, [
    h('span', { text: message }),
    h('button', { class: 'toast-close', 'aria-label': 'Dismiss', text: '×', onclick: () => node.remove() }),
  ]);
  host().append(node);
  if (kind === 'success') setTimeout(() => node.remove(), 3000);
  return node;
}

/**
 * The inline authorisation panel (§4, PR-203, PR-105, CR-104, INV-108).
 *
 * Inline, never a modal over a modal — the rule that opened it is already on the
 * screen behind, and covering it would leave the approver authorising something they
 * cannot read. It names the rule, states the role, and takes the approver's own
 * credentials so AUD-603's two actors are two people.
 */
export function authorisationPanel({ message, ruleId, requiresRole, onApprove, onCancel }) {
  const username = h('input', { type: 'text', name: 'approver', autocomplete: 'off', required: true });
  const password = h('input', { type: 'password', name: 'approverPassword', autocomplete: 'off', required: true });
  const problem = h('p', { class: 'error', hidden: true });

  const panel = h('form', {
    class: 'authorisation',
    onsubmit: async (event) => {
      event.preventDefault();
      problem.hidden = true;
      try {
        await onApprove({ username: username.value.trim(), password: password.value });
      } catch (err) {
        problem.textContent = err.message;
        problem.hidden = false;
        password.value = '';
        password.focus();
      }
    },
  }, [
    h('p', { class: 'authorisation-rule', text: `${ruleId} — authorisation required` }),
    h('p', { text: message }),
    h('p', { class: 'authorisation-role', text: `A ${String(requiresRole || '').toLowerCase()} must approve.` }),
    h('label', { text: 'Approver' }, [username]),
    h('label', { text: 'Password' }, [password]),
    problem,
    h('div', { class: 'authorisation-actions' }, [
      h('button', { type: 'submit', class: 'primary', text: 'Approve' }),
      h('button', { type: 'button', text: 'Cancel', onclick: onCancel }),
    ]),
  ]);

  queueMicrotask(() => username.focus());
  return panel;
}
