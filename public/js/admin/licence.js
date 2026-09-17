// SCR-707 — the store's subscription. TASK-048, LIC-001 – LIC-004.
//
// What the licence says, in words, and the two things an owner does here: link this POS
// to the store (once), and check now rather than waiting for tonight's automatic check.
//
// **Linking is a code, not a sign-in on this screen.** The POS asks the licence server
// for a code and shows it; the owner opens pos.chachisoftware.store/link — on this
// machine or on their own phone — signs in with Google there, and approves it. This
// screen polls until the licence arrives. Google never sees the POS, and the POS never
// holds a Google password or token.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear, openExternally } from '../shell/ui.js';
import { manila } from '../shell/format.js';

const STATE_WORDS = {
  ACTIVE: { tag: 'Active', tone: 'ok' },
  WARNING: { tag: 'Ending soon', tone: 'warn' },
  GRACE: { tag: 'Grace period', tone: 'warn' },
  LAPSED: { tag: 'Lapsed', tone: 'err' },
  UNLINKED: { tag: 'Not linked', tone: 'err' },
  MISCONFIGURED: { tag: 'Not set up', tone: 'err' },
};

const date = (iso) => (iso ? iso.slice(0, 10) : '—');

export function createLicence({ root, session }) {
  let status = null;
  let busy = false;
  let pollTimer = null;
  let note = null;           // { kind, text }
  const isOwner = session.role === 'OWNER';

  async function load() {
    ui.loading(root, { rows: 3 });
    try {
      status = await api.get('/licence');
      render();
      if (status.pending) schedulePoll();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const act = (fn) => async () => {
    busy = true;
    note = null;
    render();
    try {
      status = await fn();
      if (status.pending) schedulePoll();
    } catch (err) {
      note = { kind: 'error', text: err.isRefusal && err.ruleId ? `${err.message} (${err.ruleId})` : err.message };
    } finally {
      busy = false;
      render();
    }
  };

  const link = act(() => api.post('/licence/link'));
  const renew = act(async () => {
    const result = await api.post('/licence/renew');
    note = { kind: 'success', text: 'Checked with the licence server.' };
    return result;
  });

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const result = await api.post('/licence/link/poll');
        status = result;
        if (result.poll === 'approved') note = { kind: 'success', text: `Linked to ${result.store_name}.` };
        else if (result.poll !== 'pending' && result.last_error) note = { kind: 'error', text: result.last_error };
        render();
        if (result.pending) schedulePoll();
      } catch (err) {
        note = { kind: 'error', text: err.message };
        render();
        if (status && status.pending) schedulePoll();
      }
    }, 5000);
  }

  function render() {
    clear(root).append(h('section', { class: 'licence' }, [
      h('h2', { text: 'Subscription' }),
      status.enforced ? statusBlock() : h('p', { class: 'muted', text:
        'This build does not check a subscription. Licensing starts when the build names a licence server.' }),
      note ? h('p', { class: `opening-status ${note.kind === 'error' ? 'error' : 'success'}`, role: note.kind === 'error' ? 'alert' : 'status', text: note.text }) : null,
      status.enforced && status.pending ? pendingBlock() : null,
    ]));
  }

  function statusBlock() {
    const words = STATE_WORDS[status.state] || { tag: status.state, tone: 'warn' };
    const linked = !['UNLINKED', 'MISCONFIGURED'].includes(status.state);
    return h('div', { class: `licence-card tone-${words.tone}` }, [
      h('p', { class: 'licence-state' }, [h('span', { class: `tag licence-${words.tone}`, text: words.tag }), status.store_name ? ` ${status.store_name}` : '']),
      // The server's sentence says where to go; on this screen, say what to press.
      h('p', { text: status.state === 'UNLINKED' && !status.pending
        ? (status.message.startsWith('This POS is not linked')
          ? 'This POS is not linked to a store yet, so no shift can be opened. Press Link this POS and approve the code from any browser.'
          : status.message)
        : status.message }),
      linked ? h('dl', { class: 'licence-facts' }, [
        fact('Owner', status.owner_email),
        // TASK-067: a one-time licence has no paid-until to show.
        fact('Plan', status.plan === 'ONE_TIME' ? 'One-time licence' : 'Monthly subscription'),
        status.plan === 'ONE_TIME' ? null : fact('Paid until', date(status.paid_until)),
        fact('Last checked', date(status.checked_at)),
        fact('Check again by', date(status.valid_until)),
      ]) : null,
      status.last_error ? h('p', { class: 'muted', text: `Last attempt: ${status.last_error}` }) : null,
      isOwner ? h('div', { class: 'opening-actions' }, [
        linked
          ? h('button', { class: 'primary', icon: 'refresh-cw', text: busy ? 'Checking…' : 'Check now', disabled: busy, onclick: renew })
          : (status.pending ? null : h('button', { class: 'primary', icon: 'link', text: busy ? 'Asking…' : 'Link this POS', disabled: busy, onclick: link })),
        linked && !status.pending ? h('button', { icon: 'link', text: 'Link again', disabled: busy, onclick: link }) : null,
      ]) : h('p', { class: 'muted', text: 'Only the owner manages the subscription (LIC-004).' }),
    ]);
  }

  const fact = (label, value) => h('div', { class: 'meta-field' }, [h('dt', { text: label }), h('dd', { text: value || '—' })]);

  function pendingBlock() {
    const { user_code: code, uri, expires_at: expires } = status.pending;
    return h('div', { class: 'licence-link' }, [
      h('h3', { text: 'Approve it from any browser' }),
      h('ol', {}, [
        h('li', { text: 'Open the link page — on this machine, or on your phone.' }),
        h('li', { text: 'Sign in with the Google account that owns the store.' }),
        h('li', { text: 'Check the code below and approve.' }),
      ]),
      h('p', { class: 'licence-code', text: code }),
      h('div', { class: 'opening-actions' }, [
        h('button', { class: 'primary', icon: 'external-link', text: 'Open the link page', onclick: () => openExternally(uri) }),
      ]),
      h('p', { class: 'muted', text: `${uri.replace(/\?code=.*/, '')} · the code works until ${manila(expires)}. This screen finishes on its own.` }),
    ]);
  }

  return {
    mount: load,
    unmount() { clearTimeout(pollTimer); },
  };
}

/** The dashboard's line about the subscription, when there is something to say. */
export function licenceBanner(status) {
  if (!status || !status.enforced || status.state === 'ACTIVE') return null;
  const words = STATE_WORDS[status.state] || { tone: 'warn' };
  return h('p', { class: `licence-banner tone-${words.tone}`, role: words.tone === 'err' ? 'alert' : 'status', icon: 'badge-alert', text: status.message });
}
