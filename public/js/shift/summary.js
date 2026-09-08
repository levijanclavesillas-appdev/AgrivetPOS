// SCR-503 after the close — the summary, and what happened to the backup.
//
// POS-511 makes a closed shift immutable, so this is a read and there is no button on
// it that implies otherwise. What it must do is tell the truth about two things the
// cashier cannot see for themselves:
//
//   * **the variance, per method**, with the reason that was given for it (AUD-602);
//   * **whether the backup ran and verified** (OPS-001, OPS-002). A close whose backup
//     failed has to say so on the screen that closed it. Putting that only in the alert
//     centre means the person who could still do something about it — plug the drive
//     back in, before going home — never sees it.

import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

export function createShiftSummary({ root, result, onDone }) {
  function render() {
    const balanced = result.variance_centavos === 0;

    clear(root).append(h('section', { class: 'shift summary' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Shift closed' }),
      ]),

      backupBlock(),

      h('p', {
        class: `close-verdict ${balanced ? 'balanced' : (result.beyond_tolerance ? 'beyond' : 'within')}`,
        text: balanced
          ? 'The drawer balanced exactly.'
          : `The drawer is ${money(Math.abs(result.variance_centavos))} `
            + `${result.variance_centavos < 0 ? 'short' : 'over'}`
            + (result.beyond_tolerance
              ? `, beyond the ${money(result.tolerance_centavos)} tolerance.`
              : `, within the ${money(result.tolerance_centavos)} tolerance.`),
      }),

      result.variance_reason
        // AUD-602: the reason is on the audit trail, and it is on the screen too, so
        // the cashier can see what was recorded against their name.
        ? h('p', { class: 'close-reason', text: `Recorded reason: “${result.variance_reason}”` })
        : null,

      h('table', { class: 'shift-close' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Method' }), h('th', { text: 'Expected' }),
          h('th', { text: 'Counted' }), h('th', { text: 'Variance' }),
        ])]),
        h('tbody', {}, result.lines.map((line) => h('tr', {
          class: line.reconcilable ? '' : 'not-counted',
        }, [
          h('td', { text: line.method }),
          h('td', { class: 'money', text: money(line.expected_centavos) }),
          h('td', {
            class: line.reconcilable ? 'money' : 'muted',
            text: line.reconcilable ? money(line.actual_centavos) : 'not counted',
          }),
          h('td', {
            class: `money variance ${line.variance_centavos < 0 ? 'down' : (line.variance_centavos > 0 ? 'up' : 'zero')}`,
            text: line.reconcilable ? money(line.variance_centavos) : '—',
          }),
        ]))),
      ]),

      h('p', { class: 'muted', text: `Closed ${manila(result.shift.closed_at || result.shift.opened_at)}. `
        + 'A closed shift cannot be changed (POS-511).' }),

      printedBlock(),

      h('div', { class: 'editor-actions' }, [
        h('button', { class: 'primary', text: 'Done', onclick: onDone }),
      ]),
    ]));
  }

  /**
   * FR_5.4 — the summary is printed by the close itself, not by a button here.
   *
   * There is deliberately no reprint control: `POST /shifts/:id/close` prints the
   * summary as part of closing, and no endpoint reprints one. Offering a button that
   * cannot work would be worse than the queue the printer already has — a failed
   * document is queued for reprint (POS-208) and shows in `GET /print/queue`, and this
   * screen says which of the two happened.
   */
  function printedBlock() {
    const printed = result.printed;
    if (!printed) return null;

    return printed.delivered
      ? h('p', { class: 'muted', text: 'The summary printed.' })
      : h('p', { class: 'muted', text: `The summary did not print (${printed.error}). `
        + 'It is queued, and the figures above are the same ones on it.' });
  }

  /** OPS-001 and OPS-002, on the screen that closed the shift. */
  function backupBlock() {
    const backup = result.backup;
    if (!backup) return null;

    if (backup.ok) {
      return h('div', { class: 'alert', role: 'status' }, [
        h('span', { class: 'alert-message', text: `The day is backed up and the copy was opened `
          + `and checked: ${backup.file_name}.` }),
        h('span', { class: 'alert-rule', text: 'OPS-002' }),
      ]);
    }

    // The shift is closed regardless — a counted drawer is not un-counted because a
    // USB stick was full — but the person who can still fix it is standing here.
    return h('div', { class: 'alert alert-critical', role: 'alert' }, [
      h('span', { class: 'alert-message', text: `${backup.error} Your shift is closed and the `
        + 'day’s trading is safe in the system — but it is not backed up. Tell the owner before '
        + 'you go home.' }),
      h('span', { class: 'alert-rule', text: backup.rule_id || 'OPS-002' }),
    ]);
  }

  return { mount: render, unmount() {} };
}
