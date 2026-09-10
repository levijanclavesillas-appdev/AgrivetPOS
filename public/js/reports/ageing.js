// SCR-605 — the ageing report (TASK-031, CR-301, FT-406).
//
// What the store is owed, split by how old the debt actually is. Read by an owner
// deciding who to telephone this morning, which is why the account rows lead with a
// name and a number and the oldest debt is what they sort by.
//
// **A bucket belongs to a debit, not to an account** (`CR-301`). One farm can be ₱2,000
// in the 1–30 column and ₱5,000 in the 90+ at the same time, and a screen that put the
// whole account in its oldest bucket would tell the owner their problem is more than
// twice what it is. So a row has five figures, and they add across.
//
// **Credit a customer is holding is its own column, never netted into a bucket.** A
// debt three months old does not become younger because a payment landed against it
// later, and an overpayment sitting on one account has nothing to do with another
// account's age. The reconciliation at the foot is where the two meet: aged debt, less
// unapplied credit, is exactly what the ledger says the store is owed.
//
// The screen computes nothing — every figure here is the server's, including the
// reconciliation. A report that added up its own columns is a report with two answers.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

export function createAgeing({ root, onBack, onOpenCustomer = null }) {
  let report = null;

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      report = await api.get('/reports/ageing');
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'report report-ageing' }, [
      h('header', { class: 'report-head' }, [
        h('button', { class: 'report-back', text: '← Dashboard', onclick: () => onBack() }),
        h('h1', { text: 'Ageing' }),
        h('button', { class: 'row-action', text: 'Export CSV', onclick: exportCsv }),
      ]),

      h('dl', { class: 'report-meta' }, [
        metaField('As of', report.as_of_manila),
        metaField('Owed to the store', money(report.totals.receivable_centavos)),
        metaField('Accounts with debt', String(report.totals.accounts_with_debt)),
      ]),

      h('div', { class: 'ageing-buckets' }, report.buckets.map((bucket) => h('div', {
        class: `ageing-bucket ageing-${bucket.bucket.toLowerCase()}`,
      }, [
        h('span', { class: 'ageing-bucket-value', text: money(bucket.total_centavos) }),
        h('span', { class: 'ageing-bucket-label', text: bucket.label }),
        h('small', { class: 'muted', text: `${bucket.accounts} account${bucket.accounts === 1 ? '' : 's'}` }),
      ]))),

      report.accounts.length === 0 ? emptyState() : table(),

      // FR_6.2's demand, applied to the debt: the report reconciles **on the report**,
      // as arithmetic somebody can follow rather than as a tick asserting that two
      // numbers agree.
      h('div', { class: `report-reconciliation${report.reconciles ? '' : ' is-broken'}` }, [
        h('p', { class: 'reconciliation-statement', text: report.reconciliation_note }),
        h('dl', { class: 'report-meta' }, [
          metaField('Aged debt', money(report.totals.bucketed_centavos)),
          metaField('Credit held by customers', money(report.totals.unapplied_credit_centavos)),
          metaField('Net', money(report.totals.net_centavos)),
        ]),
      ]),

      // RPT-106.
      h('p', { class: 'muted rule-note', text: report.basis }),
    ]));
  }

  function emptyState() {
    const host = h('div');
    ui.empty(host, { title: 'Nobody owes the store anything today.' });
    return host;
  }

  function table() {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list ageing-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Customer' }), h('th', { text: 'Contact' }),
          ...report.buckets.map((bucket) => h('th', { class: 'money', text: bucket.label })),
          h('th', { class: 'money', text: 'Credit held' }),
          h('th', { class: 'money', text: 'Owing' }),
        ])]),
        h('tbody', {}, [...report.accounts]
          // Oldest debt first: the morning's telephone list, in the order somebody
          // would actually work it.
          .sort((a, b) => b.oldest_days_past_due - a.oldest_days_past_due)
          .map((account) => h('tr', {
            class: account.buckets.D90_PLUS > 0 ? 'is-low' : '',
            tabindex: onOpenCustomer ? '0' : null,
            onclick: onOpenCustomer ? () => onOpenCustomer(account.customer_id) : null,
            onkeydown: onOpenCustomer
              ? (event) => { if (event.key === 'Enter') onOpenCustomer(account.customer_id); }
              : null,
          }, [
            h('td', {}, [
              h('span', { text: account.customer_name }),
              account.oldest_days_past_due > 0
                ? h('small', { class: 'muted', text: `oldest ${account.oldest_days_past_due} days past due` })
                : h('small', { class: 'muted', text: 'nothing overdue' }),
            ]),
            // The number somebody rings. A telephone list without one is a list of names.
            h('td', { text: account.contact_no || '—' }),
            ...report.buckets.map((bucket) => h('td', {
              class: 'money',
              text: account.buckets[bucket.bucket] ? money(account.buckets[bucket.bucket]) : '',
            })),
            h('td', {
              class: 'money',
              text: account.unapplied_credit_centavos ? money(account.unapplied_credit_centavos) : '',
            }),
            h('td', { class: 'money', text: money(account.outstanding_centavos) }),
          ]))),
      ]),
    ]);
  }

  async function exportCsv() {
    try {
      const filename = api.saveAs(await api.download('/reports/ageing/export.csv'));
      ui.toast(`${filename} saved`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
