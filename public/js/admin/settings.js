// SCR-702 — settings.
//
// OPS-005 is the rule this screen serves: **every operator-owned figure lives in the
// settings registry, not in code.** Twenty-nine of them do, and TC-UT-06 has caught
// four attempts to leave one in a service. Until now none of them could be changed by
// the person who owns them.
//
// **This file holds no copy of the registry.** Every field — its label, its bounds, its
// enumeration, its rule id, whether it is owner-only — is built from what
// `GET /settings` returned. A setting added to settingsService appears here with no
// edit to this file, and one whose bounds change cannot be validated here against the
// old ones. A screen that knew the registry independently would be the second place
// OPS-005 exists to prevent.
//
// It also validates nothing the server validates. Bounds, enumerations and the
// owner-only guard are all refused server-side with the rule named (SEC-6); this
// renders the refusal against the field that caused it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

export function createSettings({ root }) {
  let groups = {};
  let settings = [];
  let profile = null;
  let taxModes = [];
  const edited = new Map();      // key → the value as typed, until saved
  const problems = new Map();    // key → the server's refusal

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      const [all, store] = await Promise.all([api.get('/settings'), api.get('/store-profile')]);
      groups = all.groups;
      settings = all.settings;
      profile = store.profile;
      taxModes = store.tax_modes;
      edited.clear();
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    // The registry's own order, grouped by its own groups. Not a list this file keeps.
    const order = [];
    for (const setting of settings) {
      if (!order.includes(setting.group)) order.push(setting.group);
    }

    clear(root).append(h('section', { class: 'admin settings' }, [
      h('header', { class: 'admin-head' }, [h('h1', { text: 'Settings' })]),
      h('p', { class: 'muted', text: 'Every figure the store runs on is here, with the rule it '
        + 'comes from. Nothing is buried in the program (OPS-005).' }),

      storeSection(),
      ...order.map((group) => section(group, settings.filter((s) => s.group === group))),
    ]));
  }

  // ── The store itself, and TAX-001 ─────────────────────────────────────────

  function storeSection() {
    const fields = {
      storeName: h('input', { type: 'text', value: profile.store_name || '' }),
      address: h('input', { type: 'text', value: profile.address || '' }),
      contactNo: h('input', { type: 'text', value: profile.contact_no || '' }),
      tin: h('input', { type: 'text', value: profile.tin || '' }),
    };

    return h('div', { class: 'settings-group' }, [
      h('h2', { text: 'The store' }),
      h('form', {
        class: 'editor-form',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            profile = (await api.put('/store-profile', {
              storeName: fields.storeName.value.trim(),
              address: fields.address.value.trim(),
              contactNo: fields.contactNo.value.trim(),
              tin: fields.tin.value.trim() || null,
            })).profile;
            ui.toast('Saved.', { kind: 'success' });
          } catch (err) {
            ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
          }
        },
      }, [
        field('Store name', fields.storeName),
        field('Address', fields.address),
        field('Contact number', fields.contactNo),
        field('TIN', fields.tin, 'Optional. It appears on printed documents when it is set.'),
        h('div', { class: 'editor-actions' }, [
          h('button', { type: 'submit', class: 'primary', text: 'Save the store' }),
        ]),
      ]),

      taxSection(),
    ]);
  }

  /** TAX-001 — owner only (TX-425), and the consequence stated before the control. */
  function taxSection() {
    // TAX-001 ships a label and a plain-language sentence per mode. Both are used:
    // "NON_VAT" means nothing to a shopkeeper, and the sentence is the thing that
    // makes the choice answerable.
    const mode = h('select', {}, Object.entries(taxModes).map(([value, meta]) => h('option', {
      value, text: `${value} — ${meta.label}`, selected: value === profile.tax_mode,
    })));
    const sentence = h('p', { class: 'muted mode-sentence', text: '' });
    const describeMode = () => {
      sentence.textContent = (taxModes[mode.value] || {}).sentence || '';
    };
    mode.addEventListener('change', describeMode);
    queueMicrotask(describeMode);

    const reason = h('input', { type: 'text', placeholder: 'Why it is changing' });

    return h('div', { class: 'tax-mode' }, [
      h('h3', { text: 'Tax mode' }),
      h('p', { class: 'muted', text: `The store is currently ${profile.tax_mode}`
        + `${taxModes[profile.tax_mode] ? ` — ${taxModes[profile.tax_mode].label}` : ''}. `
        + 'This decides what the receipt prints and what every report header states.' }),
      // Said before the control, not after the click: reports covering the change will
      // straddle two modes for ever, and that is not undoable.
      h('p', { class: 'warn-note', text: 'Changing this after the store has traded means every '
        + 'report that spans the change reports two modes at once. Past sales keep the mode they '
        + 'were made under — that is deliberate, and it cannot be undone.' }),
      h('form', {
        class: 'editor-form inline',
        onsubmit: async (event) => {
          event.preventDefault();
          if (mode.value === profile.tax_mode) {
            ui.toast('That is already the mode.', { kind: 'error' });
            return;
          }
          if (!window.confirm(`Change the tax mode from ${profile.tax_mode} to ${mode.value}?\n\n`
            + 'Every report spanning today will show both.')) return;
          try {
            const result = await api.put('/store-profile/tax-mode', {
              taxMode: mode.value, reason: reason.value.trim() || null,
            });
            profile = result.profile;
            ui.toast(`Tax mode is now ${profile.tax_mode}.`, { kind: 'success' });
            render();
          } catch (err) {
            // TX-425 is owner-only; a manager gets the refusal, not a hidden control.
            ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
          }
        },
      }, [
        h('div', { class: 'field-row' }, [
          mode, reason,
          h('button', { type: 'submit', class: 'row-action', text: 'Change mode' }),
        ]),
        sentence,
        h('p', { class: 'refusal-rule', text: 'TAX-001 · TX-425' }),
      ]),
    ]);
  }

  // ── One group of the registry ─────────────────────────────────────────────

  function section(group, rows) {
    const isPrinter = rows.some((r) => r.key === 'printer_transport');

    return h('div', { class: 'settings-group' }, [
      h('h2', { text: groups[group] || group }),
      ...rows.map(control),

      isPrinter ? printTest() : null,

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Save this section',
          onclick: () => save(rows),
        }),
      ]),
    ]);
  }

  /**
   * One setting, rendered from its declaration and nothing else.
   *
   * The `switch` is on `value_type`, which the server states. There is no list of keys
   * here, no bounds, no enumeration and no label that this file knows.
   */
  function control(setting) {
    const id = `set-${setting.key}`;
    let input;

    if (setting.value_type === 'BOOL') {
      input = h('input', {
        id, type: 'checkbox', checked: setting.value === true,
        onchange: (event) => edited.set(setting.key, event.target.checked),
      });
    } else if (setting.one_of) {
      input = h('select', {
        id,
        onchange: (event) => edited.set(setting.key, event.target.value),
      }, setting.one_of.map((option) => h('option', {
        value: option, text: option, selected: option === setting.value,
      })));
    } else if (setting.value_type === 'JSON' && setting.entry_shape === 'OBJECT') {
      // A list whose entries have structure — PR-106's discount bands. Rendered as
      // JSON and parsed back, because "one per line" has nothing to put on a line.
      //
      // Which shape a list has is the **server's** answer, from `entry_shape`: a
      // screen that guessed by looking at the value would render "[object Object]"
      // the first time somebody declared a structured list it had not met, and one
      // that knew the key would be the copy of the registry TC-UI-07 forbids.
      input = h('textarea', {
        id, rows: String(Math.max(6, JSON.stringify(setting.value || [], null, 2).split('\n').length)),
        class: 'json-entry',
        oninput: (event) => {
          try {
            edited.set(setting.key, JSON.parse(event.target.value));
            event.target.setCustomValidity('');
          } catch {
            // Left unset rather than saved as broken. The server would refuse it
            // anyway; refusing to stage it means Save does not silently skip the one
            // field somebody was in the middle of.
            event.target.setCustomValidity('This is not valid JSON yet.');
          }
        },
      });
      input.value = JSON.stringify(setting.value || [], null, 2);
    } else if (setting.value_type === 'JSON') {
      // A short, ordered list of labels — the adjustment reasons, the till reasons.
      // One per line is the shape somebody can actually edit.
      input = h('textarea', {
        id, rows: String(Math.max(3, (setting.value || []).length + 1)),
        oninput: (event) => edited.set(
          setting.key,
          event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
        ),
      });
      input.value = (setting.value || []).join('\n');
    } else {
      input = h('input', {
        id,
        type: 'text',
        inputmode: setting.value_type === 'INT' ? 'numeric' : 'text',
        value: setting.value === null || setting.value === undefined ? '' : String(setting.value),
        oninput: (event) => edited.set(
          setting.key,
          setting.value_type === 'INT'
            ? Number.parseInt(event.target.value, 10)
            : event.target.value
        ),
      });
    }

    const problem = problems.get(setting.key);

    return h('div', { class: `setting${problem ? ' has-problem' : ''}` }, [
      h('label', { for: id, class: 'setting-label' }, [
        h('span', { text: setting.what }),
        // OPS-005's own id, visible rather than hidden in a tooltip: reading it down
        // the phone is the fastest support call this product will have.
        h('span', { class: 'setting-rule', text: setting.rule_id }),
        setting.owner_only ? h('span', { class: 'tag', text: 'owner only' }) : null,
      ]),
      input,
      h('p', { class: 'setting-meta' }, [
        h('span', { class: 'setting-key', text: setting.key }),
        setting.min !== null || setting.max !== null
          ? h('span', { text: ` · ${setting.min ?? '—'} to ${setting.max ?? '—'}` })
          : null,
        h('span', { text: ` · default ${formatDefault(setting)}` }),
        setting.is_default
          ? h('span', { class: 'muted', text: ' · never changed' })
          : h('span', { class: 'muted', text: ` · changed ${manila(setting.updated_at)}` }),
      ]),
      problem ? h('p', { class: 'error', role: 'alert', text: `${problem.message} (${problem.ruleId})` }) : null,
    ]);
  }

  const formatDefault = (setting) => (Array.isArray(setting.default_value)
    ? `${setting.default_value.length} entries`
    : String(setting.default_value));

  /** INT-1 — the installer's first question, and the endpoint that answers it. */
  function printTest() {
    return h('div', { class: 'print-test' }, [
      h('button', {
        class: 'row-action', text: 'Print a test page',
        onclick: async () => {
          try {
            const result = await api.post('/print/test', {});
            ui.toast(
              result.printed.delivered
                ? 'A test page went to the printer. Check the paper.'
                : `It did not print (${result.printed.error}). It is queued.`,
              { kind: result.printed.delivered ? 'success' : 'error' }
            );
          } catch (err) {
            ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
          }
        },
      }),
      h('p', { class: 'muted', text: 'Read the paper, not the screen. A width set wrong does not '
        + 'error — it wraps a peso figure onto two lines.' }),
    ]);
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  async function save(rows) {
    const body = {};
    for (const setting of rows) {
      if (edited.has(setting.key)) body[setting.key] = edited.get(setting.key);
    }
    if (Object.keys(body).length === 0) {
      ui.toast('Nothing changed in this section.', { kind: 'error' });
      return;
    }

    problems.clear();
    try {
      // One save is one request, and settingsService.setMany owns the transaction —
      // a half-applied section would be worse than a refused one.
      const result = await api.put('/settings', body);
      settings = result.settings;
      for (const key of Object.keys(body)) edited.delete(key);
      ui.toast(`Saved ${result.changed.length} setting${result.changed.length === 1 ? '' : 's'}.`,
        { kind: 'success' });
      render();
    } catch (err) {
      // Bounds, enumerations and the owner-only guard all land here with their rule.
      // Attached to the field that caused it where the message names one, because a
      // toast that vanishes is no use against a form of thirty fields.
      const key = Object.keys(body).find((k) => err.message.includes(k));
      if (key) problems.set(key, err);
      render();
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  const field = (label, input, note = null) => h('div', { class: 'editor-field' }, [
    h('label', { text: label }), input,
    note ? h('small', { class: 'muted', text: note }) : null,
  ]);

  return { mount: load, unmount() {} };
}
