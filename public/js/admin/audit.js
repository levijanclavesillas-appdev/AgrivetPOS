// SCR-703 — the audit trail.
//
// The last screen, and the one that makes several of the others mean anything. TX-412
// hides cost, AUD-603 records two actors on an override and POS-511 freezes a closed
// shift — all of it on the understanding that somebody can look afterwards. **A trail
// nobody can read deters nobody**, and until now the owner it exists for could not read
// a line of it.
//
// Three things this screen does not do.
//
// It holds no list of actions and no list of actors. `GET /audit` returns both, built
// from the ACTIONS registry, so an action added to auditService appears in the filter
// with no edit here — and one removed cannot linger as a choice the server refuses.
//
// It writes nothing. AUD-605 gives the trail no application path that changes it: no
// update, no delete, anywhere in the product. A control here implying otherwise would
// be a control the server has no route for, and the screen says so where somebody would
// look for an edit button.
//
// It reconstructs nothing. SEC-1 redacts secrets before the row is stored; this renders
// what it is given.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

const PAGE = 50;

export function createAudit({ root }) {
  let filters = { actor: '', action: '', entity: '', from: '', to: '' };
  let offset = 0;
  let page = { rows: [], total: 0 };
  let actions = [];
  let actors = [];
  const expanded = new Set();

  async function load() {
    ui.loading(root, { rows: 6 });
    await refresh();
  }

  const query = () => {
    const parts = [`limit=${PAGE}`, `offset=${offset}`];
    for (const [key, value] of Object.entries(filters)) {
      if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
    }
    return parts.join('&');
  };

  async function refresh() {
    try {
      const body = await api.get(`/audit?${query()}`);
      page = body;
      actions = body.actions || [];
      actors = body.actors || [];
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: refresh });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'admin audit' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Audit trail' }),
        h('button', { class: 'row-action', text: 'Export CSV', onclick: exportCsv }),
      ]),

      h('p', { class: 'muted', text: 'Every price change, cost change, credit limit, adjustment, '
        + 'void, reprint, user change, settings change, export and restore, with who did it and '
        + 'what it was before (AUD-601).' }),

      controls(),

      page.rows.length === 0 ? emptyState() : table(),
      pager(),

      // AUD-605, said where somebody would look for an edit button.
      h('p', { class: 'muted trail-note', text: 'Nothing here can be changed or removed. The '
        + 'trail is written by the operations that cause it and has no path that edits it — '
        + 'which is what makes it worth reading (AUD-605).' }),
    ]));
  }

  function controls() {
    const actor = h('select', {
      'aria-label': 'Actor',
      onchange: (event) => { filters.actor = event.target.value; offset = 0; refresh(); },
    }, [
      h('option', { value: '', text: 'Anyone' }),
      // From the server. A list held here would drift the first time a user was added.
      ...actors.map((row) => h('option', {
        value: row.username, text: `${row.username} (${row.rows_written})`,
        selected: row.username === filters.actor,
      })),
    ]);

    const action = h('select', {
      'aria-label': 'Action',
      onchange: (event) => { filters.action = event.target.value; offset = 0; refresh(); },
    }, [
      h('option', { value: '', text: 'Anything' }),
      // Built from the ACTIONS registry, so a new action appears here with no edit.
      ...actions.map((row) => h('option', {
        value: row.value, text: row.label, selected: row.value === filters.action,
      })),
    ]);

    const entity = h('input', {
      type: 'text', value: filters.entity, placeholder: 'products, sales, users…',
      'aria-label': 'Entity type',
      oninput: (event) => { filters.entity = event.target.value; },
    });

    const from = h('input', {
      type: 'date', value: filters.from, 'aria-label': 'From',
      onchange: (event) => { filters.from = event.target.value; offset = 0; refresh(); },
    });
    const to = h('input', {
      type: 'date', value: filters.to, 'aria-label': 'To',
      onchange: (event) => { filters.to = event.target.value; offset = 0; refresh(); },
    });

    return h('form', {
      class: 'audit-filters',
      onsubmit: (event) => { event.preventDefault(); offset = 0; refresh(); },
    }, [
      labelled('Who', actor),
      labelled('What', action),
      labelled('Entity', entity),
      labelled('From', from),
      labelled('To', to),
      h('button', { type: 'submit', class: 'row-action', text: 'Filter' }),
      h('button', {
        type: 'button', text: 'Clear',
        onclick: () => {
          filters = { actor: '', action: '', entity: '', from: '', to: '' };
          offset = 0;
          refresh();
        },
      }),
    ]);
  }

  const labelled = (text, input) => h('label', { class: 'audit-filter' }, [
    h('span', { text }), input,
  ]);

  function emptyState() {
    const host = h('div');
    ui.empty(host, {
      title: Object.values(filters).some(Boolean)
        ? 'Nothing on the trail matches that.'
        : 'Nothing has been recorded yet.',
    });
    return host;
  }

  function table() {
    return h('table', { class: 'catalogue-list audit-list' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'When' }), h('th', { text: 'Who' }), h('th', { text: 'What' }),
        h('th', { text: 'On' }), h('th', { text: 'Why' }), h('th', { text: '' }),
      ])]),
      h('tbody', {}, page.rows.flatMap((row) => [
        h('tr', {
          class: expanded.has(row.id) ? 'is-open' : '',
          tabindex: '0',
          onclick: () => toggle(row.id),
          onkeydown: (event) => { if (event.key === 'Enter') toggle(row.id); },
        }, [
          h('td', { text: row.occurred_at_manila }),
          h('td', {}, [
            h('span', { text: row.actor.username || 'system' }),
            // AUD-603: an override names who asked and who allowed. One name is an
            // override nobody authorised.
            row.approver
              ? h('span', { class: 'tag approver', text: `approved by ${row.approver.username}` })
              : null,
          ]),
          h('td', { text: row.action_label }),
          h('td', { class: 'sku', text: row.entity_type + (row.entity_id ? ` ${short(row.entity_id)}` : '') }),
          h('td', { class: 'reason', text: row.reason || '' }),
          h('td', {}, [h('span', {
            class: 'expand-hint',
            text: row.before || row.after ? (expanded.has(row.id) ? '−' : '+') : '',
          })]),
        ]),
        expanded.has(row.id) ? detail(row) : null,
      ])),
    ]);
  }

  const short = (id) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

  /** AUD-606: a change is legible afterwards, or the row answers nothing. */
  function detail(row) {
    return h('tr', { class: 'audit-detail' }, [
      h('td', { colspan: '6' }, [
        h('div', { class: 'detail-grid' }, [
          h('div', {}, [
            h('h3', { text: 'Before' }),
            h('pre', { text: row.before === null ? '—' : format(row.before) }),
          ]),
          h('div', {}, [
            h('h3', { text: 'After' }),
            h('pre', { text: row.after === null ? '—' : format(row.after) }),
          ]),
        ]),
        h('p', { class: 'detail-meta', text: `${row.action} · ${row.entity_type}`
          + `${row.entity_id ? ` · ${row.entity_id}` : ''}`
          + `${row.shift_id ? ` · shift ${short(row.shift_id)}` : ''}`
          + ` · ${manila(row.occurred_at)}` }),
      ]),
    ]);
  }

  /** One field per line, so a reader compares the two columns by eye. */
  const format = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).map(([key, v]) => `${key}: ${JSON.stringify(v)}`).join('\n')
    : JSON.stringify(value, null, 2));

  function toggle(id) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  }

  function pager() {
    if (page.total <= PAGE) {
      return h('p', { class: 'muted', text: `${page.total} row${page.total === 1 ? '' : 's'}.` });
    }
    return h('div', { class: 'pager' }, [
      h('button', {
        text: '← Newer', disabled: offset === 0,
        onclick: () => { offset = Math.max(0, offset - PAGE); refresh(); },
      }),
      h('span', { text: `${offset + 1}–${Math.min(offset + PAGE, page.total)} of ${page.total}` }),
      h('button', {
        text: 'Older →', disabled: offset + PAGE >= page.total,
        onclick: () => { offset += PAGE; refresh(); },
      }),
    ]);
  }

  /**
   * TX-429, not TX-426 — exporting the trail is reading the trail.
   *
   * The export is itself audited, and saying so is the point rather than a nicety: a
   * copy of who-did-what leaving the machine is exactly the event somebody would later
   * want to find.
   */
  async function exportCsv() {
    try {
      const filename = api.saveAs(await api.download(`/audit/export?${query()}`));
      ui.toast(`${filename} saved. The export is on the trail itself.`, { kind: 'success' });
      await refresh();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  return { mount: load, unmount() { expanded.clear(); } };
}
