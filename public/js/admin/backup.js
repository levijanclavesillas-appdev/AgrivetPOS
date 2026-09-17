// SCR-704 — backups and restore.
//
// Two things on this screen are stated in plain words rather than implied, because the
// people who need them are not reading a manual:
//
//   * **A backup on a shared drive is readable by anyone with that drive** (SEC-9).
//     The product does not encrypt backups and does not pretend to, so the honest
//     thing is to say who can read one.
//   * **The off-machine copy is something a person does, not something this does**
//     (05_TECH_SPEC.md §7). Backups on the same machine survive exactly the failures
//     that do not matter. There is no cloud sync here and the screen says why.
//
// The restore is deliberately awkward. Picking from a list and clicking OK is how the
// wrong night's backup gets restored; typing the filename is the moment somebody reads
// the date on it.
//
// TASK-057: a backup the log does not know — copied from the computer that died, chosen
// with **Restore from a file…**, or made here before the last restore rolled the log
// back — is listed under the log with its own Restore….
// It has no row here to vouch for it, so the dialog opens it first and shows which store
// it holds and when it last recorded anything, before the name is typed.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

export function createBackup({ root, session }) {
  let data = null;

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      data = await api.get('/backups');
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'admin backups' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Backups' }),
        session.role === 'OWNER' ? fromFileButton() : null,
        h('button', {
          class: 'primary', text: 'Back up now',
          onclick: runBackup,
        }),
      ]),
      overdueBlock(),
      folderBlock(),
      warningBlock(),
      listBlock(),
      othersBlock(),
    ]));
  }

  /**
   * TASK-057: a backup from somewhere else, chosen from this device. It is checked and
   * saved into the backup folder — the same as copying it there by hand — and then
   * offered for restore like any file in the folder.
   */
  function fromFileButton() {
    const input = h('input', {
      type: 'file', accept: '.zip,application/zip', hidden: true,
      'aria-label': 'Choose a backup file',
      onchange: async (event) => {
        const chosen = event.target.files[0];
        event.target.value = '';
        if (!chosen) return;
        ui.toast(`Checking ${chosen.name}…`);
        try {
          const added = await api.upload(`/backups/files?fileName=${encodeURIComponent(chosen.name)}`, chosen);
          await load();
          askToRestore({ file_name: added.file_name });
        } catch (err) {
          ui.toast(err.message, { kind: 'error' });
        }
      },
    });
    // Beside the button rather than inside it: a click on the input would bubble back to
    // the button and open the chooser a second time.
    return h('span', { class: 'file-pick' }, [
      input,
      h('button', { icon: 'upload', text: 'Restore from a file…', onclick: () => input.click() }),
    ]);
  }

  /** FR_7.3 — and it carries no dismiss control, because OPS-007 gives it none. */
  function overdueBlock() {
    if (!data.overdue || !data.overdue.overdue) {
      return data.overdue && data.overdue.last_verified_at
        ? h('p', { class: 'backup-fresh', text: `Last verified backup: ${manila(data.overdue.last_verified_at)}.` })
        : null;
    }
    return h('div', { class: 'alert alert-critical', role: 'alert' }, [
      h('span', { class: 'alert-message', text: data.overdue.message }),
      h('span', { class: 'alert-rule', text: 'OPS-007' }),
    ]);
  }

  function folderBlock() {
    return h('dl', { class: 'admin-meta' }, [
      field('Folder', data.folder || 'Not set — backups cannot run'),
      data.inside_app_data
        ? h('div', { class: 'meta-field warn' }, [
          h('dt', { text: 'Warning' }),
          // OPS-001. A backup inside the folder being backed up survives exactly the
          // failures that do not matter: not the disk, not ransomware, not the
          // uninstaller.
          h('dd', { text: 'This folder is inside the application’s own data folder. A backup there '
            + 'will not survive the things a backup is for. Choose another drive.' }),
        ])
        : null,
    ]);
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  /** SEC-9 and §7's process control, said once and plainly. */
  function warningBlock() {
    return h('div', { class: 'backup-warning' }, [
      h('h2', { text: 'Two things worth knowing' }),
      h('p', { text: data.shared_drive_warning }),
      // On Android the app copies each backup out to shared storage, where it survives the app.
      data.copied_to
        ? h('p', { text: `Each backup is also copied to ${data.copied_to} on this device, where it stays if the app `
          + 'is removed. Copy that folder to a computer every week: backups on this phone do not survive this phone. '
          + 'After the app is installed again, open an old backup with Restore from a file.' })
        : null,
      data.hosted
        // TASK-062: the web version's backups are on Chachi's server.
        ? h('p', { text: 'These backups are kept on Chachi\'s server, apart from the store\'s data. '
          + 'Download the newest one every week with Download, and keep it somewhere safe: it is '
          + 'your own copy if you ever move the store to a PC.' })
        : h('p', { text: 'Backups on this machine do not survive this machine. Copy the backup folder '
          + 'to a USB stick every week and keep it somewhere else, or use Download on the newest one. '
          + 'Nothing in this application does that for you, and nothing will remind you at the right moment.' }),
    ]);
  }

  function listBlock() {
    if (data.backups.length === 0) {
      return ui.empty(h('div', {}), { title: 'No backup has been taken yet.' });
    }

    return h('div', { class: 'table-scroll' }, [h('table', { class: 'backup-list' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Taken' }), h('th', { text: 'Trigger' }), h('th', { text: 'Verified' }),
        h('th', { text: 'Size' }), h('th', { text: 'File' }), h('th', { text: '' }),
      ])]),
      h('tbody', {}, data.backups.map((b) => h('tr', { class: b.verified ? null : 'failed' }, [
        h('td', { text: b.taken_at_manila }),
        h('td', { text: b.trigger.toLowerCase().replace(/_/g, ' ') }),
        // OPS-002: "written" and "verified" are two different claims, and only the
        // second one counts. The column says which.
        h('td', { class: 'verified', text: b.verified ? 'Verified' : (b.error || 'Not verified') }),
        h('td', { text: b.size_bytes ? `${(b.size_bytes / 1048576).toFixed(1)} MB` : '—' }),
        h('td', { class: 'file', text: b.file_name || '—' }),
        h('td', {}, [
          b.verified && b.on_disk && session.role === 'OWNER'
            ? h('button', { class: 'restore', icon: 'archive-restore', text: 'Restore…', onclick: () => askToRestore(b) })
            : null,
          // TASK-062: the owner's own copy, off this machine.
          b.verified && b.on_disk && session.role === 'OWNER'
            ? h('button', { class: 'restore', icon: 'download', text: 'Download', onclick: () => download(b) })
            : null,
          !b.on_disk && b.pruned_at ? h('span', { class: 'muted', text: 'pruned' }) : null,
          !b.on_disk && !b.pruned_at ? h('span', { class: 'muted', text: 'not in folder' }) : null,
        ]),
      ]))),
    ])]);
  }

  /** TASK-057: backups in the folder with no row in this store's log. */
  function othersBlock() {
    if (!data.unrecognised || data.unrecognised.length === 0) return null;
    return h('div', { class: 'backup-others' }, [
      h('h2', { text: 'Other backups in the folder' }),
      h('p', { class: 'muted', text: 'Backups this store’s list does not know: copied from another '
        + 'computer, or made here before the last restore. Each is opened and checked before it can '
        + 'be restored.' }),
      h('div', { class: 'table-scroll' }, [h('table', { class: 'backup-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Copied in' }), h('th', { text: 'Size' }), h('th', { text: 'File' }), h('th', { text: '' }),
        ])]),
        h('tbody', {}, data.unrecognised.map((f) => h('tr', {}, [
          h('td', { text: manila(f.modified_at) }),
          h('td', { text: `${(f.size_bytes / 1048576).toFixed(1)} MB` }),
          h('td', { class: 'file', text: f.file_name }),
          h('td', {}, [
            session.role === 'OWNER'
              ? h('button', { class: 'restore', icon: 'archive-restore', text: 'Restore…', onclick: () => askToRestore({ file_name: f.file_name }) })
              : null,
          ]),
        ]))),
      ])]),
    ]);
  }

  async function download(backup) {
    ui.toast(`Preparing ${backup.file_name}…`);
    try {
      api.saveAs(await api.download(`/backups/${backup.id}/download`));
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  async function runBackup() {
    ui.toast('Backing up and verifying…');
    try {
      const result = await api.post('/backups', {});
      ui.toast(`${result.file_name} verified`, { kind: 'success' });
    } catch (err) {
      // A backup that fails is not a crash; it is the store not being backed up, and
      // the reason belongs on screen where somebody can act on it.
      ui.toast(err.message, { kind: 'error' });
    }
    load();
  }

  /**
   * OPS-004 — the confirmation.
   *
   * Everything that is about to be lost is named first, then the filename must be
   * typed. Not a checkbox: a checkbox is ticked without reading, and the date on the
   * file is the thing that has to be read.
   */
  async function askToRestore(chosen) {
    const logged = Boolean(chosen.id);
    let preflight = null;
    if (!logged) ui.toast(`Opening and checking ${chosen.file_name}…`);
    try {
      preflight = await api.get(logged
        ? `/backups/restore/preflight?backupId=${chosen.id}`
        : `/backups/restore/preflight?fileName=${encodeURIComponent(chosen.file_name)}`);
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
      return;
    }
    // A logged backup is described by its row; a file from elsewhere, by opening it.
    const backup = logged ? chosen : { ...chosen, ...preflight.backup };
    const refused = !logged && !backup.restorable;

    const typed = h('input', {
      type: 'text', class: 'confirm-filename', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Type the backup filename to confirm',
    });
    const go = h('button', { class: 'danger', icon: 'archive-restore', text: 'Restore', disabled: true });
    typed.addEventListener('input', () => { go.disabled = typed.value.trim() !== backup.file_name; });

    const overlay = h('div', { class: 'lock-overlay' }, [
      h('div', { class: 'restore-dialog' }, [
        h('h1', { text: 'Restore this backup?' }),
        logged
          ? h('p', { text: `This replaces everything in the database with the contents of `
            + `${backup.file_name}, taken ${backup.taken_at_manila}.` })
          : h('dl', { class: 'admin-meta' }, [
            field('Store', backup.store_name || '—'),
            field('Last recorded', backup.taken_at_manila || '—'),
            field('Owner sign-in', (backup.owners || []).join(', ') || '—'),
          ]),
        !logged && !refused
          ? h('p', { text: `This replaces everything in the database with the contents of ${backup.file_name}. `
            + 'Afterwards, sign in with a username and password from that backup.' })
          : null,
        refused ? h('p', { class: 'error', role: 'alert', text: backup.error }) : null,
        h('p', { class: 'restore-loss', text: 'Every sale, payment, stock movement and customer '
          + 'change made since then will no longer be in the system.' }),
        // OPS-004: a fresh backup is taken first, and saying so is what makes the
        // decision reversible in the reader's mind as well as in fact.
        h('p', { text: 'A backup of the current database is taken first, so this can be undone. '
          + 'If that backup cannot be taken, the restore will not start.' }),
        preflight.blocked_by_open_shift
          ? h('p', { class: 'error', role: 'alert', text: `${preflight.open_shifts} shift(s) are still `
            + 'open. Close the drawer first — a shift counted against a database that is about to '
            + 'be replaced reconciles to nothing.' })
          : null,
        refused ? null : h('label', { text: 'Type the filename to confirm' }, [typed]),
        refused ? null : h('p', { class: 'muted file', text: backup.file_name }),
        h('div', { class: 'dialog-actions' }, [
          h('button', { text: refused ? 'Close' : 'Cancel', onclick: () => overlay.remove() }),
          refused ? null : go,
        ]),
      ]),
    ]);

    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const result = logged
          ? await api.post(`/backups/${backup.id}/restore`, { confirmFilename: typed.value.trim() })
          : await api.post('/backups/files/restore', { fileName: backup.file_name, confirmFilename: typed.value.trim() });
        overlay.remove();
        ui.toast(result.message, { kind: 'success' });
        if (!result.signed_in_user_survives) window.location.reload();
        else load();
      } catch (err) {
        go.disabled = false;
        ui.toast(err.message, { kind: 'error' });
      }
    });

    document.body.append(overlay);
    queueMicrotask(() => (refused ? null : typed.focus()));
  }

  return { mount: load, unmount() {} };
}
