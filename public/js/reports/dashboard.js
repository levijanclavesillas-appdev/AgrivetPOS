// SCR-601 — the dashboard.
//
// Seven tiles and the alert list, refreshed on navigation (FR_6.1). Every tile is a
// link to the report behind it, and every figure on it came from that report's own
// query — this view does no arithmetic at all, which is the point rather than an
// omission. A tile that computes its own number is the defect TC-INT-60 exists to
// catch, and the reason it matters is that a tile is the figure people quote.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

/** Which report a tile opens. Credit and inventory are v1.1 screens; say so. */
const OPENS = {
  daily: 'daily',
  payments: 'payments',
  inventory: 'valuation',
  credit: null,
};

/**
 * Tiles that open a screen rather than a report. `INV-109`'s count opens the list, and
 * since `TASK-031` the two credit tiles open the ageing — which is the screen somebody
 * pressing "Credit outstanding" or "Overdue accounts" was always trying to reach.
 */
const OPENS_SCREEN = {
  LOW_STOCK: 'low-stock',
  CREDIT_OUTSTANDING: 'ageing',
  OVERDUE_ACCOUNTS: 'ageing',
};

/**
 * Alerts that are worth acting on rather than only reading, and where they go.
 *
 * OPS-007's list was read-only until TASK-043: the expiry alerts carry the batch and
 * the product they are about, and telling a store that three batches on its shelf may
 * not be sold while leaving it to find them is most of a feature.
 */
const ALERT_OPENS = {
  NEAR_EXPIRY: { screen: 'batches', label: 'See the batches' },
  EXPIRED_STOCK: { screen: 'batches', label: 'Write it off' },
};

export function createDashboard({ root, session, onOpenReport, onOpenBatches = null }) {
  let dismissed = new Set();

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      render(await api.get('/reports/dashboard'));
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render(data) {
    clear(root).append(h('div', { class: 'dashboard' }, [
      h('header', { class: 'dash-head' }, [
        h('h1', { text: 'Today' }),
        h('p', { class: 'dash-when', text: `${data.date} · as of ${manila(data.as_of)}` }),
        // TX-421's OWN_SHIFT, said out loud. A cashier seeing store-wide headings over
        // their own till's figures would believe the wrong thing.
        data.scope === 'OWN_SHIFT'
          ? h('p', { class: 'dash-scope', text: 'Your shift only' })
          : null,
        h('button', { class: 'dash-refresh', text: 'Refresh', onclick: load }),
      ]),
      alertList(data.alerts),
      h('div', { class: 'tiles' }, data.tiles.map(tile)),
    ]));
  }

  function tile(data) {
    const screen = OPENS_SCREEN[data.key];
    const target = screen || OPENS[data.report];
    return h('button', {
      class: `tile tile-${data.key.toLowerCase().replace(/_/g, '-')}`,
      // Not a dead button: a tile whose report is not built says so on the tile.
      disabled: !target,
      title: target ? `Open the ${data.report} report` : 'This report arrives in v1.1',
      onclick: target ? () => onOpenReport(target, Boolean(screen)) : null,
    }, [
      h('span', { class: 'tile-label', text: data.label }),
      h('span', { class: 'tile-value', text: data.display }),
      data.margin_bp !== undefined
        ? h('span', { class: 'tile-note', text: `${(data.margin_bp / 100).toFixed(1)}% margin` })
        : null,
      h('span', { class: 'tile-rule', text: data.rule_id }),
    ]);
  }

  /**
   * OPS-007's list, above the tiles.
   *
   * Dismissal is per session and lives only here — nothing is written to the server,
   * because "I have read this" is not a fact about the store. Backup overdue and clock
   * anomaly carry `dismissible: false` from the server and get no dismiss control at
   * all: hiding them does not make the day any safer, and the person who dismisses one
   * is rarely the person who loses the data.
   */
  function alertList({ alerts }) {
    const showing = alerts.filter((a) => !dismissed.has(key(a)));
    if (showing.length === 0) return null;

    return h('ul', { class: 'alerts', 'aria-label': 'Alerts' }, showing.map((a) => h('li', {
      class: `alert alert-${a.severity.toLowerCase()}`,
      role: a.severity === 'CRITICAL' ? 'alert' : null,
    }, [
      h('span', { class: 'alert-message', text: a.message }),
      h('span', { class: 'alert-rule', text: a.rule_id }),
      alertAction(a),
      a.dismissible
        ? h('button', {
          class: 'alert-dismiss', 'aria-label': 'Dismiss', text: '×',
          onclick: () => { dismissed.add(key(a)); load(); },
        })
        : null,
    ])));
  }

  /** The one step from an alert to the screen that can do something about it. */
  function alertAction(a) {
    const opens = ALERT_OPENS[a.kind];
    if (!opens || !onOpenBatches || !a.product_id) return null;
    return h('button', {
      class: 'alert-action', text: opens.label,
      onclick: () => onOpenBatches(a.product_id),
    });
  }

  const key = (a) => `${a.kind}:${a.shift_id || ''}`;

  return {
    mount: load,
    unmount() { dismissed = new Set(); },
  };
}
