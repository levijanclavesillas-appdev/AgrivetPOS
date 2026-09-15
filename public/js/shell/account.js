// TASK-058 — the signed-in person's own account, from their name at the foot of the rail.
//
// Before this the name was a lock button and nothing else: there was no way to sign out,
// nobody could change their own password or PIN (the Users screen told the owner "They
// can change it later"), and the owner's recovery code could not be replaced short of
// using it. Each action here proves the person with their current password on the
// server, and none is offered to a PIN session, which is scoped to the counter (SEC-2).
//
// Its own dialog rather than ui.ask: a mistyped current password has to leave the form
// open with the reason under it, and ui.ask closes on submit and trims what was typed —
// which a password must never be.

import * as api from './api.js';
import * as ui from './ui.js';
import { h, clear } from './ui.js';

const ROLE_LABELS = { OWNER: 'Owner', MANAGER: 'Manager', CASHIER: 'Cashier', INVENTORY: 'Inventory clerk' };
const PASSWORD_MIN = 10;

/**
 * @param session  the public user (username, role, has_pin)
 * @param scope    'FULL' after a password, 'PIN' after a PIN unlock
 * @param onLock, onSignOut  the shell's own
 * @param onChanged(user)    the fresh public user after a change (has_pin moves)
 */
export function openAccount({ session, scope, onLock, onSignOut, onChanged }) {
  const panel = h('div', { class: 'ask account', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Your account' });
  const overlay = h('div', { class: 'ask-overlay' }, [panel]);
  let dismissible = true;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (event) => {
    if (event.key !== 'Escape' || !dismissible) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (event) => { if (event.target === overlay && dismissible) close(); });

  const pinSession = scope === 'PIN';

  // ── The menu ──────────────────────────────────────────────────────────────

  function menu() {
    dismissible = true;
    const item = (icon, text, onclick, extra = {}) => h('button', { type: 'button', class: 'account-item', icon, text, onclick, ...extra });
    // Filtered: Element.append writes a null as the text "null".
    clear(panel).append(...[
      h('h2', { text: session.username }),
      h('p', { class: 'ask-message', text: `${ROLE_LABELS[session.role] || session.role}`
        + (pinSession ? ' · unlocked with a PIN' : '') }),
      h('div', { class: 'account-items' }, [
        session.has_pin ? item('lock', 'Lock screen', () => { close(); onLock(); }) : null,
        pinSession ? null : item('shield-check', 'Change password', passwordForm),
        pinSession ? null : item('lock-open', session.has_pin ? 'Change PIN' : 'Set a PIN', pinForm),
        !pinSession && session.role === 'OWNER' ? item('file-text', 'New recovery code', recoveryForm) : null,
        item('log-in', 'Sign out', () => { close(); onSignOut(); }, { class: 'account-item sign-out' }),
      ]),
      pinSession
        ? h('p', { class: 'muted account-note', text: 'To change your password or PIN, sign out and sign in with your password.' })
        : null,
      h('div', { class: 'ask-actions' }, [h('button', { type: 'button', text: 'Close', onclick: close })]),
    ].filter(Boolean));
    queueMicrotask(() => panel.querySelector('.account-item')?.focus());
  }

  // ── A form, with its refusal under it ─────────────────────────────────────

  function form({ title, message, fields, submitLabel, extra = null, submit }) {
    dismissible = true;
    const problem = h('p', { class: 'error', role: 'alert', hidden: true });
    const say = (text) => { problem.textContent = text; problem.hidden = !text; };
    const busy = h('button', { type: 'submit', class: 'primary', text: submitLabel });

    const el = h('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        say('');
        busy.disabled = true;
        try {
          await submit(Object.fromEntries(fields.map((f) => [f.name, f.input.value])), say);
        } catch (err) {
          say(err.message);
        } finally {
          busy.disabled = false;
        }
      },
    }, [
      h('h2', { text: title }),
      message ? h('p', { class: 'ask-message', text: message }) : null,
      ...fields.map((f) => h('label', {}, [h('span', { text: f.label }), f.input, f.hint ? h('small', { class: 'muted', text: f.hint }) : null])),
      problem,
      extra,
      h('div', { class: 'ask-actions' }, [
        busy,
        h('button', { type: 'button', text: 'Back', onclick: menu }),
      ]),
    ]);
    clear(panel).append(el);
    queueMicrotask(() => fields[0]?.input.focus());
  }

  const secret = (name, label, { autocomplete = 'current-password', hint = null, pin = false } = {}) => ({
    name, label, hint,
    input: h('input', {
      type: 'password', autocomplete,
      ...(pin ? { inputmode: 'numeric', pattern: '\\d{6}', maxlength: '6' } : {}),
    }),
  });

  function passwordForm() {
    form({
      title: 'Change your password',
      message: 'You will use the new password the next time you sign in.',
      fields: [
        secret('current', 'Current password'),
        secret('next', 'New password', { autocomplete: 'new-password', hint: `At least ${PASSWORD_MIN} characters.` }),
        secret('again', 'New password again', { autocomplete: 'new-password' }),
      ],
      submitLabel: 'Change password',
      submit: async ({ current, next, again }, say) => {
        if (next.length < PASSWORD_MIN) return say(`The new password is at least ${PASSWORD_MIN} characters.`);
        if (next !== again) return say('The two new passwords do not match.');
        await api.post('/auth/password', { currentPassword: current, newPassword: next });
        close();
        ui.toast('Password changed.', { kind: 'success' });
        return undefined;
      },
    });
  }

  function pinForm() {
    const remove = session.has_pin
      ? h('button', {
        type: 'button', class: 'account-remove', text: 'Remove my PIN',
        onclick: async () => {
          const current = panel.querySelector('input[autocomplete="current-password"]').value;
          try {
            const result = await api.post('/auth/pin', { currentPassword: current, pin: null });
            onChanged(result.user);
            close();
            ui.toast('PIN removed. The screen now asks for your password when it locks.', { kind: 'success' });
          } catch (err) {
            const problem = panel.querySelector('.error');
            problem.textContent = err.message;
            problem.hidden = false;
          }
        },
      })
      : null;
    form({
      title: session.has_pin ? 'Change your PIN' : 'Set a PIN',
      message: 'The PIN unlocks your own open shift at the counter. It is not a second password.',
      fields: [
        secret('current', 'Your password'),
        secret('pin', 'New PIN (6 digits)', { autocomplete: 'off', pin: true }),
        secret('again', 'New PIN again', { autocomplete: 'off', pin: true }),
      ],
      submitLabel: session.has_pin ? 'Change PIN' : 'Set PIN',
      extra: remove,
      submit: async ({ current, pin, again }, say) => {
        if (!/^\d{6}$/.test(pin)) return say('The PIN is exactly 6 digits.');
        if (pin !== again) return say('The two PINs do not match.');
        const result = await api.post('/auth/pin', { currentPassword: current, pin });
        onChanged(result.user);
        close();
        ui.toast('PIN saved.', { kind: 'success' });
        return undefined;
      },
    });
  }

  function recoveryForm() {
    form({
      title: 'New recovery code',
      message: 'The recovery code is the only way back into the owner account if the password is lost. '
        + 'A new one replaces the old one, which stops working at once. Use this if the paper is lost, '
        + 'or somebody may have seen it.',
      fields: [secret('password', 'Your password')],
      submitLabel: 'Make a new code',
      submit: async ({ password }) => {
        const result = await api.post('/auth/recovery-code', { password });
        showCode(result.recoveryCode);
      },
    });
  }

  /** SEC-5: shown once. The panel stays until the owner says it is written down. */
  function showCode(code) {
    dismissible = false;
    const done = h('button', { type: 'button', class: 'primary', text: 'Done', disabled: true, onclick: close });
    const tick = h('input', { type: 'checkbox', onchange: () => { done.disabled = !tick.checked; } });
    clear(panel).append(
      h('h2', { text: 'Your new recovery code' }),
      h('p', { class: 'ask-message', text: 'Write it down now and keep it away from the computer. It is not shown again, '
        + 'and the old code no longer works.' }),
      h('p', { class: 'code recovery-code', text: code }),
      h('label', { class: 'ask-check' }, [tick, h('span', { text: 'I have written it down.' })]),
      h('div', { class: 'ask-actions' }, [done]),
    );
    queueMicrotask(() => tick.focus());
  }

  menu();
  document.body.append(overlay);
}

/**
 * SCR-101's other way in: the owner's forgotten password, replaced with the recovery
 * code (SEC-5, AUD-604). The server issues a new code as it consumes the old one, and
 * it is shown here once, behind the same "written down" tick as at setup.
 */
export function renderRecover(root, { onDone, onBack }) {
  const username = h('input', { type: 'text', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const code = h('input', { type: 'text', autocomplete: 'off', required: true, spellcheck: 'false',
    autocapitalize: 'characters', placeholder: 'XXXX-XXXX-XXXX-XXXX', class: 'recovery-input' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const problem = h('p', { class: 'error', role: 'alert', hidden: true });
  const say = (text) => { problem.textContent = text; problem.hidden = !text; };

  clear(root).append(h('div', { class: 'signin' }, [
    h('h1', { text: 'Forgotten owner password' }),
    h('p', { class: 'signin-note', text: 'Use the recovery code written down when the store was set up. '
      + 'It replaces the owner password; other users’ passwords are reset by the owner in Admin → Users.' }),
    h('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        say('');
        if (next.value.length < PASSWORD_MIN) return say(`The new password is at least ${PASSWORD_MIN} characters.`);
        if (next.value !== again.value) return say('The two new passwords do not match.');
        try {
          const result = await api.post('/auth/recover', {
            username: username.value.trim(), recoveryCode: code.value.trim(), newPassword: next.value,
          });
          next.value = '';
          again.value = '';
          showReplacement(result);
        } catch (err) {
          say(err.message);
        }
        return undefined;
      },
    }, [
      h('label', { text: 'Owner username' }, [username]),
      h('label', { text: 'Recovery code' }, [code]),
      h('label', { text: 'New password' }, [next]),
      h('label', { text: 'New password again' }, [again]),
      problem,
      h('button', { type: 'submit', class: 'primary', icon: 'shield-check', text: 'Reset the password' }),
    ]),
    h('button', { type: 'button', class: 'signin-link', icon: 'arrow-left', text: 'Back to sign in', onclick: onBack }),
  ]));
  queueMicrotask(() => username.focus());

  function showReplacement(result) {
    const go = h('button', { type: 'button', class: 'primary', icon: 'log-in', text: 'Sign in', disabled: true,
      onclick: () => onDone(result.user.username) });
    const tick = h('input', { type: 'checkbox', onchange: () => { go.disabled = !tick.checked; } });
    clear(root).append(h('div', { class: 'signin' }, [
      h('h1', { text: 'Password reset' }),
      h('p', { class: 'signin-note', text: 'The code you used no longer works. This is the new one: write it down '
        + 'now and keep it away from the computer. It is not shown again.' }),
      h('p', { class: 'code recovery-code', text: result.recoveryCode }),
      h('label', { class: 'check' }, [tick, h('span', { text: 'I have written the new code down.' })]),
      go,
    ]));
    queueMicrotask(() => tick.focus());
  }
}
