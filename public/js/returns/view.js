// SCR-305 — the return. FT-307.
//
// Two phases on one screen: find the sale, then decide what comes back off it. They
// are one screen rather than two because they are one conversation — a customer is
// standing at the counter holding a sack, and the receipt number is the first thing
// they hand over.
//
// **Every rule on this screen is the server's answer, fetched.** The remaining
// quantity per line (`POS-301`), the default disposition and the sentence explaining
// it (`POS-304`), the window and whether this sale is past it (`POS-307`), and the
// reason list (`POS-302`) all arrive from `GET /sales/:id/returnable`. A screen that
// computed any of them would eventually disagree with the refusal it then got, and the
// cashier would be the one holding the difference.
//
// What the screen *does* decide is the shape of the conversation, and one thing about
// it is deliberate: **a line that defaults to write-off says why, next to the control
// that would change it.** POS-304 exists because a returned bottle of antibiotic has
// been in somebody's motorcycle box, and a default with no reason beside it is a
// default that gets clicked past.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity, manila } from '../shell/format.js';

export function createReturn({ root, saleId = null, onBack, onDone }) {
  let view = null;             // GET /sales/:id/returnable
  let query = '';
  let results = null;
  let lines = [];              // { saleItemId, qty, disposition, ... }
  let reason = '';
  let notes = '';
  let refusal = null;
  let approver = null;
  let approvalReason = '';
  let posting = false;
  let result = null;

  async function mount() {
    if (saleId) return openSale(saleId);
    return renderLookup();
  }

  // ── Phase one — find the sale ─────────────────────────────────────────────

  /**
   * `returnable=true` rather than the screen filtering the list itself.
   *
   * Which statuses still have something to give back is POS-301's business, and the
   * server holds it. Offering a voided sale here and refusing it two clicks later is
   * the shape of interface that teaches people to distrust the buttons.
   */
  async function findSales() {
    const term = query.trim();
    try {
      const data = await api.get(
        `/sales?returnable=true&limit=25${term ? `&q=${encodeURIComponent(term)}` : ''}`
      );
      results = data.sales;
      renderResults();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function renderLookup() {
    clear(root).append(h('section', { class: 'returns return-lookup' }, [
      h('header', { class: 'admin-head' }, [
        onBack ? h('button', { class: 'report-back', text: '← Back', onclick: () => onBack() }) : null,
        h('h1', { text: 'Return goods' }),
      ]),

      h('form', {
        class: 'editor-form',
        onsubmit: (event) => { event.preventDefault(); findSales(); },
      }, [
        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Receipt number or customer' }),
          h('div', { class: 'field-row' }, [
            h('input', {
              type: 'search', value: query, autofocus: true, autocomplete: 'off',
              placeholder: 'SALE-20260909-000012, or a name',
              'aria-label': 'Receipt number or customer name',
              oninput: (event) => { query = event.target.value; },
            }),
            h('button', { type: 'submit', class: 'primary', text: 'Find' }),
          ]),
          h('small', { class: 'muted', text:
            'A return is always against the sale the goods came off (POS-301). '
            + 'Voided and fully returned sales are not listed — there is nothing left on them.' }),
        ]),
      ]),

      h('div', { id: 'return-results' }, [resultsBlock()]),
    ]));
    queueMicrotask(() => root.querySelector('input[type="search"]')?.focus());
  }

  function renderResults() {
    const host = root.querySelector('#return-results');
    if (host) clear(host).append(resultsBlock());
  }

  function resultsBlock() {
    if (results === null) {
      return h('p', { class: 'muted', text: 'Search for the sale, or leave the box empty to '
        + 'list the most recent.' });
    }
    if (results.length === 0) {
      return h('p', { class: 'muted', text: 'No sale matches that, or the ones that do have '
        + 'nothing left to return.' });
    }

    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list return-results' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Receipt' }),
          h('th', { text: 'When' }),
          h('th', { text: 'Customer' }),
          h('th', { class: 'money', text: 'Total' }),
          h('th', { text: 'Status' }),
          h('th', { text: '' }),
        ])]),
        h('tbody', {}, results.map((sale) => h('tr', {}, [
          h('td', { text: sale.sale_no }),
          h('td', { text: manila(sale.occurred_at) }),
          h('td', { text: sale.customer_name || 'Walk-in' }),
          h('td', { class: 'money', text: money(sale.total_centavos) }),
          // POS-107's word for the status, served rather than spelled here: a status
          // rendered in three places drifts in two of them.
          h('td', { text: sale.status_label }),
          h('td', {}, [h('button', {
            class: 'row-action', text: 'Return from this',
            onclick: () => openSale(sale.id),
          })]),
        ]))),
      ]),
    ]);
  }

  // ── Phase two — what comes back ───────────────────────────────────────────

  async function openSale(id) {
    ui.loading(root, { rows: 5 });
    try {
      view = await api.get(`/sales/${id}/returnable`);
      lines = view.lines
        // A line already fully returned is left off rather than shown at zero: it is a
        // row somebody has to read past on every return after the first.
        .filter((line) => !line.is_fully_returned)
        .map((line) => ({
          saleItemId: line.sale_item_id,
          qty: '',
          // POS-304's answer, pre-selected. Changing it away from WRITE_OFF is the
          // exception, and the screen says so beside the control.
          disposition: line.default_disposition,
          spec: line,
        }));
      reason = '';
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: () => openSale(id) });
    }
  }

  const milli = (value) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  };

  /**
   * What a line's refund will be, in proportion to the quantity.
   *
   * An estimate, and labelled as one — the same reasoning SCR-403's balance preview
   * carries. The server apportions from the sale line and gives the last portion the
   * rounding remainder (MON-003), so the figure that counts is the one that comes back
   * after the return posts. This is here because a cashier is about to tell a customer
   * a number, and no number at all is worse than an approximate one.
   */
  const lineRefund = (line) => {
    const qty = milli(line.qty);
    if (qty === null || qty <= 0) return 0;
    return Math.round((line.spec.line_total_centavos * qty) / line.spec.sold_qty_milli);
  };

  const estimate = () => lines.reduce((sum, line) => sum + lineRefund(line), 0);

  const chosen = () => lines.filter((line) => (milli(line.qty) || 0) > 0);

  function render() {
    clear(root).append(h('section', { class: 'returns return-form' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Another sale', onclick: () => { view = null; renderLookup(); } }),
        h('h1', { text: `Return against ${view.sale.sale_no}` }),
      ]),

      h('dl', { class: 'admin-meta' }, [
        metaField('Sold', manila(view.sale.occurred_at)),
        metaField('Customer', view.sale.customer ? view.sale.customer.name : 'Walk-in'),
        metaField('Paid by', view.sale.tenders.map((t) => t.method).join(', ')),
        metaField('Sale total', money(view.sale.total_centavos)),
      ]),

      windowNotice(),

      h('form', {
        class: 'editor-form',
        onsubmit: (event) => { event.preventDefault(); submit(); },
      }, [
        h('div', { class: 'table-scroll' }, [
          h('table', { class: 'catalogue-list return-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Line' }),
              h('th', { class: 'qty', text: 'Sold' }),
              h('th', { class: 'qty', text: 'Already back' }),
              h('th', { class: 'qty', text: 'Coming back' }),
              h('th', { text: 'What happens to it' }),
              h('th', { class: 'money', text: 'Refund' }),
            ])]),
            h('tbody', { id: 'return-lines' }, lines.map((line, index) => lineRow(line, index))),
          ]),
        ]),

        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Reason' }),
          h('select', {
            required: true,
            onchange: (event) => { reason = event.target.value; refreshTotals(); },
          }, [
            h('option', { value: '', text: 'Choose a reason…' }),
            ...view.reasons.map((r) => h('option', { value: r, text: r, selected: r === reason })),
          ]),
          // POS-302: from the list. Free text alongside, never instead — said here so
          // the notes field does not look like a way around the list.
          h('small', { class: 'muted', text:
            'From the list (POS-302). Anything else goes in the note beside it.' }),
        ]),

        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Note' }),
          h('input', {
            type: 'text', value: notes, placeholder: 'Optional — what the customer said',
            oninput: (event) => { notes = event.target.value; },
          }),
        ]),

        h('div', { class: 'preview', id: 'return-preview' }, [previewBlock()]),

        h('div', { id: 'authorisation' }, [refusal ? authorisation() : null]),

        h('div', { class: 'editor-actions' }, [
          h('button', {
            type: 'submit', class: 'primary', text: 'Take the goods back',
            disabled: posting || (Boolean(refusal) && !approver),
          }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => (onBack ? onBack() : renderLookup()) }),
        ]),
      ]),
    ]));
  }

  /** POS-307, answered at the top rather than as a refusal at the bottom. */
  function windowNotice() {
    if (!view.window.beyond) return null;
    return h('p', { class: 'rule-note warn', role: 'alert', text:
      `This sale was ${view.window.elapsed_days} days ago and the return window is `
      + `${view.window.window_days} days. A manager or owner will have to authorise it — `
      + 'worth saying before the goods come out of the bag (POS-307).' });
  }

  function lineRow(line, index) {
    const spec = line.spec;
    const defaultsToWriteOff = spec.default_disposition === 'WRITE_OFF';

    return h('tr', {}, [
      h('td', {}, [
        h('span', { text: spec.product_name }),
        h('small', { class: 'muted', text: spec.sku }),
      ]),
      h('td', { class: 'qty', text: spec.sold_display }),
      h('td', { class: 'qty', text: spec.returned_qty_milli > 0
        ? quantity(spec.returned_qty_milli, spec.base_unit_code)
        : '—' }),

      h('td', { class: 'qty' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', class: 'qty', value: line.qty,
          placeholder: '0',
          'aria-label': `Quantity of ${spec.product_name} coming back`,
          oninput: (event) => { line.qty = event.target.value; refreshLine(index); },
        }),
        h('span', { class: 'unit', text: spec.base_unit_code }),
        // POS-301, on the row: the most that can come back, not merely a refusal
        // waiting to happen.
        h('small', { class: 'muted', text: `up to ${spec.remaining_display}` }),
      ]),

      h('td', {}, [
        h('select', {
          'aria-label': `What happens to the returned ${spec.product_name}`,
          onchange: (event) => { line.disposition = event.target.value; refreshLine(index); },
        }, [
          h('option', { value: 'RESTOCK', text: 'Back on the shelf', selected: line.disposition === 'RESTOCK' }),
          h('option', { value: 'WRITE_OFF', text: 'Written off', selected: line.disposition === 'WRITE_OFF' }),
        ]),
        // POS-304's sentence, next to the control it explains. This is the whole
        // reason the server sends it rather than the screen inventing a label.
        defaultsToWriteOff
          ? h('small', { class: 'rule-note default-why', text: spec.default_reason })
          : null,
        // And the warning, only once it is actually the exception.
        defaultsToWriteOff && line.disposition === 'RESTOCK'
          ? h('small', { class: 'warn override-note', role: 'alert',
            text: 'A manager or owner must authorise putting this back (POS-304).' })
          : null,
      ]),

      h('td', { class: 'money line-refund', text: money(lineRefund(line)) }),
    ]);
  }

  /** Recompute the derived cells without rebuilding the row under the cursor. */
  function refreshLine(index) {
    const row = root.querySelectorAll('#return-lines tr')[index];
    if (!row) return;
    const line = lines[index];

    const refundCell = row.querySelector('.line-refund');
    if (refundCell) refundCell.textContent = money(lineRefund(line));

    // The POS-304 warning appears and disappears with the choice, so the cell that
    // holds it is the one cell that is rebuilt.
    const spec = line.spec;
    if (spec.default_disposition === 'WRITE_OFF') {
      const cell = row.children[4];
      const existing = cell.querySelector('.override-note');
      if (line.disposition === 'RESTOCK' && !existing) {
        cell.append(h('small', { class: 'warn override-note', role: 'alert',
          text: 'A manager or owner must authorise putting this back (POS-304).' }));
      } else if (line.disposition !== 'RESTOCK' && existing) {
        existing.remove();
      }
    }

    refreshTotals();
  }

  function refreshTotals() {
    const host = root.querySelector('#return-preview');
    if (host) clear(host).append(previewBlock());
  }

  /**
   * What the customer gets back, and how — an estimate, and labelled as one.
   *
   * POS-305's precedence is the server's to apply: it knows what the sale was tendered
   * by and what the customer owes right now, and both can have moved since this screen
   * loaded. What the screen shows is the shape of the answer, so nobody is surprised
   * by being handed store credit instead of notes.
   */
  function previewBlock() {
    const picked = chosen();
    if (picked.length === 0) {
      return h('p', { class: 'muted', text: 'Enter what is coming back on each line.' });
    }

    const soldOnCredit = view.credit && view.credit.sold_on_credit;
    const owes = view.credit ? view.credit.balance_centavos : 0;

    return h('div', {}, [
      h('p', { class: 'preview-line' }, [
        h('span', { text: `${picked.length} line${picked.length === 1 ? '' : 's'} coming back, about ` }),
        h('strong', { text: money(estimate()) }),
      ]),
      h('p', { class: 'muted', text: soldOnCredit && owes > 0
        ? `This was a credit sale and they owe ${money(owes)}, so the refund comes off their `
          + 'balance before anything is handed over (POS-305).'
        : (owes > 0
          ? `They still owe ${money(owes)}, so nothing is paid out in cash while that stands `
            + '(POS-306).'
          : 'Refunded in cash from the till (POS-305).') }),
      h('p', { class: 'muted', text: 'The figures above are this screen’s arithmetic. The ones '
        + 'that count are on the slip the return prints.' }),
    ]);
  }

  /**
   * AUD-603 — the approver authenticates as themselves.
   *
   * `/auth/login` issues no session header, so the cashier stays signed in and the
   * trail records two distinct actors rather than one asserted twice.
   */
  function authorisation() {
    return ui.authorisationPanel({
      message: refusal.message,
      ruleId: refusal.ruleId,
      requiresRole: refusal.requiresRole,
      onApprove: async ({ username, password }) => {
        const auth = await api.post('/auth/login', { username, password });
        approver = auth.user;
        approvalReason = refusal.message;
        ui.toast(`${approver.username} authorised this return`, { kind: 'success' });
        render();
      },
      onCancel: () => { refusal = null; approver = null; render(); },
    });
  }

  function usable() {
    if (chosen().length === 0) {
      ui.toast('Enter what is coming back on at least one line.', { kind: 'error' });
      return false;
    }
    if (!reason) {
      ui.toast('Choose a reason for the return (POS-302).', { kind: 'error' });
      return false;
    }
    const over = chosen().find((line) => milli(line.qty) > line.spec.remaining_qty_milli);
    if (over) {
      ui.toast(
        `${over.spec.product_name}: only ${over.spec.remaining_display} is left to return (POS-301).`,
        { kind: 'error' }
      );
      return false;
    }
    return true;
  }

  async function submit() {
    if (posting || !usable()) return;
    posting = true;
    try {
      result = await api.post(`/sales/${view.sale.id}/returns`, {
        reason,
        notes: notes.trim() || null,
        approver: approver ? { username: approver.username } : null,
        approvalReason: approvalReason || null,
        lines: chosen().map((line) => ({
          saleItemId: line.saleItemId,
          qtyMilli: milli(line.qty),
          disposition: line.disposition,
        })),
      });
      renderResult();
    } catch (err) {
      // POS-304 and POS-307 come back as a refusal naming the rule and the role. The
      // panel opens here rather than being pre-judged: the window is a setting and the
      // default is the server's list, so a screen that decided for itself would be a
      // screen that disagreed with the refusal it then got.
      if (err.isRefusal && ['POS-304', 'POS-307'].includes(err.ruleId) && err.requiresRole) {
        refusal = err;
        render();
        queueMicrotask(() => root.querySelector('.authorisation input')?.focus());
        return;
      }
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      posting = false;
    }
  }

  // ── After it is posted ────────────────────────────────────────────────────

  function renderResult() {
    const doc = result.sale_return;
    const refund = doc.refund;

    clear(root).append(h('section', { class: 'returns return-done' }, [
      h('header', { class: 'admin-head' }, [h('h1', { text: `${doc.return_no} — goods taken back` })]),

      h('p', { class: 'close-verdict balanced',
        text: `${money(doc.total_centavos)} returned against ${doc.sale_no}.` }),

      // POS-305's three destinations, and only the ones carrying money.
      h('ul', { class: 'refund-split' }, [
        refund.credit_centavos > 0
          ? h('li', { text: `${money(refund.credit_centavos)} taken off their balance (POS-305).` })
          : null,
        refund.cash_centavos > 0
          ? h('li', { text: `${money(refund.cash_centavos)} handed back in cash — the drawer is open.` })
          : null,
        refund.store_credit_centavos > 0
          ? h('li', { text: `${money(refund.store_credit_centavos)} held as store credit (CR-108).` })
          : null,
      ]),

      result.withheld_reason
        ? h('p', { class: 'rule-note warn', role: 'alert', text: result.withheld_reason })
        : null,

      // POS-303, per line, so the cashier can say what happened to each thing.
      h('ul', { class: 'return-outcome' }, result.lines.map((line) => h('li', {
        text: `${line.qty_display} ${line.product_name} — `
          + `${line.disposition === 'RESTOCK' ? 'back on the shelf' : 'written off, not resold'}`
          + `${line.restocked_against_default ? ' (authorised against POS-304)' : ''}`,
      }))),

      result.credit_balance_centavos !== null
        ? h('p', { class: 'preview-line', text: result.store_credit_centavos > 0
          ? `${view.sale.customer.name} is ${money(result.store_credit_centavos)} in credit.`
          : `${view.sale.customer.name} now owes ${money(result.credit_balance_centavos)}.` })
        : null,

      result.printed
        ? h('p', { class: 'muted', text: result.printed.delivered
          ? 'The acknowledgement printed. Hand it over.'
          : `The acknowledgement did not print (${result.printed.error}). It is queued, and the `
            + 'figures above are the same ones on it.' })
        : null,

      h('div', { class: 'editor-actions' }, [
        h('button', { class: 'primary', text: 'Done', onclick: () => (onDone ? onDone(result) : renderLookup()) }),
        h('button', { text: 'Another return', onclick: () => { result = null; view = null; results = null; renderLookup(); } }),
      ]),
    ]));
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount, unmount() {} };
}
