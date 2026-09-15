// TASK-063 — the store on the web and on its devices, from Admin → Web & devices.
//
// One tab, three faces, because an installation is one of three things:
//
//   the web copy (HUB)     the store's devices: which, their letter, when each last synced,
//                          how far behind; rename or remove one; how to connect another
//   a device (DEVICE)      the store it belongs to, when it last synced, what is waiting,
//                          and Sync now
//   on its own (STANDALONE) put this store on the web: it becomes the first device of its
//                          new web copy, and keeps selling offline as before

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

export function createDevices({ root, session }) {
  let status = null;

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      status = await api.get('/sync/status');
      if (status.role === 'HUB') status.devices = (await api.get('/sync/devices')).devices;
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    const body = status.role === 'HUB' ? hub() : status.role === 'DEVICE' ? device() : standalone();
    clear(root).append(h('section', { class: 'admin devices' }, [
      h('header', { class: 'admin-head' }, [h('h1', { text: 'Web & devices' })]),
      body,
    ]));
  }

  // ── The web copy ──────────────────────────────────────────────────────────

  function hub() {
    const live = status.devices.filter((d) => !d.revoked_at);
    return h('div', {}, [
      h('p', { class: 'muted', text: 'This is the store\'s web copy: its record. Each phone or PC connected '
        + 'to it keeps the whole store, sells offline, and syncs here when it can. Its receipts carry '
        + 'its letter (SALE-A-…), so two devices never share a number.' }),
      live.length === 0
        ? h('p', { class: 'state-title', text: 'No device is connected yet.' })
        : h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list device-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Device' }), h('th', { text: 'Letter' }), h('th', { text: 'Last synced' }),
            h('th', { text: 'Behind' }), h('th', { text: '' }),
          ])]),
          h('tbody', {}, status.devices.map((d) => h('tr', { class: d.revoked_at ? 'is-complete' : null }, [
            h('td', {}, [h('strong', { text: d.name }), d.platform ? h('small', { class: 'muted', text: ` ${d.platform}` }) : null]),
            h('td', { text: d.series }),
            h('td', { text: d.revoked_at ? `removed ${manila(d.revoked_at)}` : (d.last_seen_at ? manila(d.last_seen_at) : 'not yet') }),
            h('td', { text: d.revoked_at ? '—' : (d.behind ? `${d.behind} change${d.behind === 1 ? '' : 's'}` : 'up to date') }),
            h('td', { class: 'detail-actions' }, d.revoked_at ? [] : [
              h('button', { class: 'row-action', text: 'Rename', onclick: () => rename(d) }),
              h('button', { class: 'row-action danger', text: 'Remove', onclick: () => remove(d) }),
            ]),
          ]))),
        ])]),
      h('div', { class: 'backup-warning' }, [
        h('h2', { text: 'Connect a phone or PC' }),
        h('ol', { class: 'steps' }, [
          h('li', { text: 'Install Chachi POS on it (the Windows app or the Android app).' }),
          h('li', { text: 'In its setup, choose "Connect to a store on the web".' }),
          // The page's own address, path and all: every web store shares one host (TASK-065).
          h('li', { text: `Type this store's address, ${new URL('.', window.location.href).href.replace(/\/$/, '')}, and sign in as the owner.` }),
          h('li', { text: 'It downloads the store and is ready to sell. Link its own subscription seat under Admin → Subscription.' }),
        ]),
      ]),
    ]);
  }

  async function rename(d) {
    const answers = await ui.ask({ title: `Rename ${d.name}`, fields: [{ name: 'name', label: 'Name', value: d.name, maxLength: 60 }], submitLabel: 'Rename' });
    if (!answers || !answers.name) return;
    try {
      await api.put(`/sync/devices/${d.id}`, { name: answers.name });
      await load();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  async function remove(d) {
    if (!window.confirm(`Remove ${d.name} (${d.series}) from the store?\n\nIt stops syncing at once. What it has already `
      + 'sent stays. Anything it sold since it last synced stays on that device only. Its letter is not given to another device.')) return;
    try {
      await api.post(`/sync/devices/${d.id}/revoke`, {});
      ui.toast(`${d.name} removed.`, { kind: 'success' });
      await load();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  // ── A device ──────────────────────────────────────────────────────────────

  function device() {
    const field = (label, value) => h('div', { class: 'meta-field' }, [h('dt', { text: label }), h('dd', { text: value })]);
    return h('div', {}, [
      h('dl', { class: 'admin-meta' }, [
        field('Store on the web', status.hub_url),
        field('This device', `${status.device.name} — letter ${status.device.series}`),
        field('Last synced', status.last_sync_at ? manila(status.last_sync_at) : 'not yet'),
        field('Waiting to send', status.pending ? `${status.pending} change${status.pending === 1 ? '' : 's'}` : 'nothing'),
        status.last_error ? field('Last problem', status.last_error) : null,
      ]),
      h('div', { class: 'editor-actions' }, [
        h('button', { class: 'primary', icon: 'refresh-cw', text: 'Sync now', onclick: syncNow }),
      ]),
      h('p', { class: 'muted', text: 'Without the internet this device keeps selling, taking payments, receiving '
        + 'stock and adding customers; it sends them when the connection is back. Products, prices, users and '
        + 'settings are changed while connected, so every device agrees on them.' }),
    ]);
  }

  async function syncNow() {
    ui.toast('Syncing…');
    try {
      const result = await api.post('/sync/now', {});
      ui.toast(result.error ? `Not synced: ${result.error}` : 'Synced.', { kind: result.error ? 'error' : 'success' });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
    await load();
  }

  // ── On its own ────────────────────────────────────────────────────────────

  function standalone() {
    const address = h('input', { type: 'text', placeholder: 'pos.chachisoftware.store/s/yourstore', autocomplete: 'off', spellcheck: 'false' });
    const code = h('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', class: 'recovery-input' });
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    const name = h('input', { type: 'text', value: 'Counter 1', maxlength: '60' });
    const problem = h('p', { class: 'error', role: 'alert', hidden: true });
    const go = h('button', { type: 'submit', class: 'primary', text: 'Put this store on the web' });
    const field = (label, input, note = null) => h('div', { class: 'editor-field' }, [
      h('label', { text: label }), input, note ? h('small', { class: 'muted', text: note }) : null,
    ]);

    return h('div', {}, [
      h('p', { text: 'This store is on this device only. To use it on the web as well, and on more phones or '
        + 'PCs, Chachi\'s makes it a web copy and sends you its address and a setup code. Then:' }),
      session.role !== 'OWNER'
        ? h('p', { class: 'muted', text: 'Only the owner can put the store on the web.' })
        : h('form', {
          class: 'editor-form customer-form',
          onsubmit: async (event) => {
            event.preventDefault();
            problem.hidden = true;
            go.disabled = true;
            go.textContent = 'Uploading the store…';
            try {
              await api.post('/sync/go-online', {
                hubUrl: address.value.trim(), setupCode: code.value.trim(), password: password.value, deviceName: name.value.trim(),
              });
              password.value = '';
              ui.toast('The store is on the web. This device is its first, and keeps working offline.', { kind: 'success' });
              await load();
            } catch (err) {
              problem.textContent = err.message;
              problem.hidden = false;
            } finally {
              go.disabled = false;
              go.textContent = 'Put this store on the web';
            }
          },
        }, [
          field('Web address', address),
          field('Setup code', code, 'The code Chachi\'s sent with the address.'),
          field('Your password', password, 'You sign in to the web copy with the same username and password.'),
          field('Name for this device', name, 'Shown in the web copy\'s list of devices. Its receipts will carry the letter A.'),
          problem,
          h('div', { class: 'editor-actions' }, [go]),
        ]),
      h('p', { class: 'muted', text: 'The store\'s records are uploaded as they are now, and everything from then on '
        + 'is kept in step. This device keeps selling offline; the web needs the internet.' }),
    ]);
  }

  return { mount: load, unmount() {} };
}
