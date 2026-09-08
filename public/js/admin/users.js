// SCR-701 — user administration.
//
// The screen whose absence is worst in a way that is easy to miss: without it the
// store trades on the owner login. Every audit row then carries the owner's name,
// TX-412 puts cost prices in front of whoever is at the counter, and SCR-102's PIN
// unlock has nobody to unlock.
//
// Nothing here decides who may do what. TX-423 is owner-only and the server refuses
// the route regardless (SEC-6); this renders the server's answer, including its
// refusals, rather than second-guessing them. VR-503's last-owner guard is the clearest
// case: the control is offered and the refusal explains itself, because a greyed-out
// button teaches nobody why the store must keep an owner.
//
// **No secret is ever rendered back.** SEC-1 keeps hashes on the server, and this
// screen never puts a password or a PIN into a value it re-reads: the fields are
// write-only, cleared after use, and what reaches the trail is that a password
// changed, never what it changed to.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

const ROLES = [
  ['CASHIER', 'Sells at the counter. No cost prices, no settings.'],
  ['INVENTORY', 'Products and stock. No sales screen.'],
  ['MANAGER', 'Everything except users and settings.'],
  ['OWNER', 'Everything, including restore and cost prices.'],
];

export function createUsers({ root }) {
  let users = [];
  let editing = null;        // a user id, 'new', or null
  let includeInactive = false;

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      users = (await api.get(`/users?includeInactive=${includeInactive}`)).users;
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'admin users' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Users' }),
        h('label', { class: 'check' }, [
          h('input', {
            type: 'checkbox', checked: includeInactive,
            onchange: (event) => { includeInactive = event.target.checked; load(); },
          }),
          h('span', { text: 'Show deactivated' }),
        ]),
        h('button', { class: 'primary', text: 'New user', onclick: () => { editing = 'new'; render(); } }),
      ]),

      h('p', { class: 'muted', text: 'Give every person who works the till their own login. '
        + 'Sharing one means every price change, every discount and every drawer count is '
        + 'recorded against the wrong name.' }),

      editing === 'new' ? form(null) : null,

      users.length === 0
        ? h('p', { class: 'muted', text: 'No users yet.' })
        : h('table', { class: 'catalogue-list users-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Username' }), h('th', { text: 'Name' }), h('th', { text: 'Role' }),
            h('th', { text: 'PIN' }), h('th', { text: 'Status' }), h('th', { text: '' }),
          ])]),
          h('tbody', {}, users.flatMap((user) => [
            h('tr', { class: user.is_active ? '' : 'is-inactive' }, [
              h('td', { class: 'sku', text: user.username }),
              h('td', { text: user.full_name }),
              h('td', { text: user.role }),
              // The thing an owner is checking when they look at this column: a cashier
              // without a PIN cannot use the lock screen (SCR-102, SEC-2).
              h('td', { text: user.has_pin ? 'set' : '—' }),
              h('td', {}, [statusCell(user)]),
              h('td', {}, [h('button', {
                class: 'row-action', text: editing === user.id ? 'Close' : 'Edit',
                onclick: () => { editing = editing === user.id ? null : user.id; render(); },
              })]),
            ]),
            editing === user.id
              ? h('tr', {}, [h('td', { colspan: '6' }, [form(user)])])
              : null,
          ])),
        ]),
    ]));
  }

  /** SEC-3, with the minutes remaining — which is what the person asking wants. */
  function statusCell(user) {
    if (!user.is_active) return h('span', { class: 'tag', text: 'deactivated' });

    const until = user.locked_until_at ? Date.parse(user.locked_until_at) : 0;
    const minutes = Math.ceil((until - Date.now()) / 60000);
    if (minutes > 0) {
      return h('span', { class: 'tag warn', title: `Locked until ${manila(user.locked_until_at)}`,
        text: `locked ${minutes} min` });
    }
    return h('span', { class: 'muted', text: 'active' });
  }

  // ── Create and edit ───────────────────────────────────────────────────────

  function form(user) {
    const isNew = !user;
    const username = h('input', { type: 'text', value: isNew ? '' : user.username, autocomplete: 'off' });
    const fullName = h('input', { type: 'text', value: isNew ? '' : user.full_name });
    const role = h('select', {}, ROLES.map(([value]) => h('option', {
      value, text: value, selected: !isNew && user.role === value,
    })));
    // Write-only. Never given a value, never read back after use (SEC-1).
    const password = h('input', { type: 'password', autocomplete: 'new-password' });
    const pin = h('input', {
      type: 'password', inputmode: 'numeric', maxlength: '6', autocomplete: 'off',
      placeholder: isNew ? 'Optional' : (user.has_pin ? 'Leave blank to keep' : 'Optional'),
    });

    const roleNote = h('p', { class: 'muted role-note', text: '' });
    const describeRole = () => {
      roleNote.textContent = (ROLES.find(([value]) => value === role.value) || [, ''])[1];
    };
    role.addEventListener('change', describeRole);
    queueMicrotask(describeRole);

    return h('form', {
      class: 'editor-form user-form',
      onsubmit: async (event) => {
        event.preventDefault();
        await save({ isNew, user, username, fullName, role, password, pin });
      },
    }, [
      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Username' }), username,
        h('small', { class: 'muted', text: 'What they type to sign in. Lower case, no spaces.' }),
      ]),
      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Full name' }), fullName,
        // VR-501, said next to the field rather than discovered on submit.
        h('small', { class: 'muted', text: 'The name that appears on the audit trail (VR-501).' }),
      ]),
      h('div', { class: 'editor-field' }, [h('label', { text: 'Role' }), role, roleNote]),
      h('div', { class: 'editor-field' }, [
        h('label', { text: isNew ? 'Password' : 'New password' }), password,
        h('small', { class: 'muted', text: isNew
          ? 'They can change it later; you cannot read it back.'
          : 'Leave blank to keep the current one. Setting a new one also clears a lockout.' }),
      ]),
      h('div', { class: 'editor-field' }, [
        h('label', { text: isNew ? 'PIN (optional)' : 'PIN' }), pin,
        // VR-502 and SEC-2.
        h('small', { class: 'muted', text: 'Six digits, to unlock the screen mid-shift without '
          + 'losing the cart. It is not a way to sign in (SEC-2).' }),
      ]),

      h('div', { class: 'editor-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: isNew ? 'Create user' : 'Save' }),
        isNew || !user.is_active ? null : h('button', {
          type: 'button', class: 'row-action', text: 'Deactivate', onclick: () => setActive(user, false),
        }),
        isNew || user.is_active ? null : h('button', {
          type: 'button', class: 'row-action', text: 'Reactivate', onclick: () => setActive(user, true),
        }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => { editing = null; render(); } }),
      ]),

      isNew ? null : h('p', { class: 'muted', text: 'Users are deactivated, never deleted — '
        + 'every sale, price change and drawer count they made still names them (AUD-606).' }),
    ]);
  }

  async function save({ isNew, user, username, fullName, role, password, pin }) {
    const body = {
      username: username.value.trim(),
      fullName: fullName.value.trim(),
      role: role.value,
    };
    if (password.value) body.password = password.value;
    if (pin.value) body.pin = pin.value;

    if (isNew && !body.password) {
      ui.toast('A new user needs a password.', { kind: 'error' });
      return;
    }

    try {
      if (isNew) {
        const created = await api.post('/users', body);
        ui.toast(`${created.user.username} created.`, { kind: 'success' });
      } else {
        await api.put(`/users/${user.id}`, body);
        ui.toast('Saved.', { kind: 'success' });
      }
      // SEC-1: the fields are cleared rather than re-rendered with what was typed.
      password.value = '';
      pin.value = '';
      editing = null;
      await load();
    } catch (err) {
      // VR-501, VR-502, VR-503 and the username rules all land here, each naming
      // its rule.
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function setActive(user, isActive) {
    if (!isActive && !window.confirm(`Deactivate ${user.username}?\n\n`
      + 'They cannot sign in afterwards. Everything they have already done keeps their name '
      + 'on it, and you can reactivate them at any time.')) return;

    try {
      await api.put(`/users/${user.id}`, { isActive });
      ui.toast(isActive ? 'Reactivated.' : 'Deactivated.', { kind: 'success' });
      editing = null;
      await load();
    } catch (err) {
      // VR-503: the last active owner. The refusal explains itself — a greyed-out
      // button teaches nobody why the store must keep one.
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  return { mount: load, unmount() {} };
}
