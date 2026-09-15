// SCR-001 — the first-run wizard. Vanilla ES module, no build step
// (05_TECH_SPEC.md §2).
//
// The client-side checks here are a courtesy: they catch a typo before a round trip.
// Every one of them is repeated on the server, which is the only place a rule is
// actually enforced (SEC-6) — VR-501, VR-502, TAX-001, SEC-5 and OPS-001 all refuse
// again in setupService, and this file cannot weaken any of them.
//
// TASK-057 added the other way through: a store moving from a computer that died
// restores its backup here instead of taking the five steps, and goes to the sign-in
// screen with the users and passwords it already had.
//
// TASK-047 added a sixth step after the five: the store's existing data, loaded with the
// same panel SCR-706 shows. It runs as the new owner — the wizard signs in with the
// credentials it was just given, keeps the token in memory only (SEC-7), and forgets the
// password — and it can be skipped, because an empty store is a store too.

import * as api from './shell/api.js';
import { createOpeningLoad } from './shell/opening.js';
import { iconSvg } from './shell/icons.js';

const STEPS = ['store', 'tax', 'owner', 'recovery', 'backup'];
const LABELS = { store: 'Store', tax: 'Tax', owner: 'Owner', recovery: 'Recovery code', backup: 'Backup', data: 'Your data' };

const form = document.querySelector('#wizard');
const errorBox = document.querySelector('#error');
const stepList = document.querySelector('#steps');
const backButton = document.querySelector('#back');
const nextButton = document.querySelector('#next');
const nav = document.querySelector('.wizard-nav');

let index = 0;
// 'steps' → the five; 'done' → the recovery code; 'data' → step 6;
// 'restore' → a backup instead of the five; 'restored' → then to the sign-in (TASK-057).
let phase = 'steps';
const RESTORING = ['restore', 'restored', 'connect', 'connected'];
let signedIn = null;          // { user } once the new owner is signed in, for step 6
let signingIn = null;         // the sign-in in flight, which step 6 waits for
let loaded = false;           // step 6 has landed a load
let hosted = false;           // TASK-062: a web copy — a setup code, no folder to choose

const sectionFor = (name) => document.querySelector(`.step[data-step="${name}"]`);
const field = (name) => form.elements[name];
const value = (name) => (field(name) ? field(name).value.trim() : '');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
  if (message) errorBox.scrollIntoView({ block: 'nearest' });
}

/** A finished step shows a check, as M3's stepper does; the number stays for the rest. */
const mark = (state, n) => (state === 'done' ? `${iconSvg('check')}<span class="sr-only">${n}</span>` : n);

function renderProgress() {
  if (RESTORING.includes(phase)) {
    const finished = phase === 'restored' || phase === 'connected';
    const what = phase.startsWith('connect') ? 'Connect to the web store' : 'Restore a backup';
    const state = finished ? 'done' : 'current';
    stepList.innerHTML = `<li class="${state}"${state === 'current' ? ' aria-current="step"' : ''}>`
      + `<span>${mark(state, 1)}</span> ${what}</li>`;
    document.querySelector('#wizard-progress').textContent = finished ? 'Done' : what;
    document.querySelector('#wizard-bar').style.width = finished ? '100%' : '50%';
    return;
  }
  const saved = phase !== 'steps';
  const five = STEPS.map((name, i) => {
    const state = saved || i < index ? 'done' : i === index ? 'current' : 'todo';
    return `<li class="${state}"${state === 'current' ? ' aria-current="step"' : ''}>`
      + `<span>${mark(state, i + 1)}</span> ${LABELS[name]}</li>`;
  });
  const sixth = loaded ? 'done' : phase === 'data' ? 'current' : 'todo';
  five.push(`<li class="${sixth} optional"${sixth === 'current' ? ' aria-current="step"' : ''}>`
    + `<span>${mark(sixth, 6)}</span> ${LABELS.data} <small>optional</small></li>`);
  stepList.innerHTML = five.join('');

  // The compact header's version of the same thing: one line and a bar (app.css).
  const [text, reached] = phase === 'steps' ? [`Step ${index + 1} of 5 · ${LABELS[STEPS[index]]}`, index + 1]
    : phase === 'done' ? ['Saved', 5]
      : [`Step 6 · ${LABELS.data}`, loaded ? 6 : 5.5];
  document.querySelector('#wizard-progress').textContent = text;
  document.querySelector('#wizard-bar').style.width = `${(reached / 6) * 100}%`;
}

const current = () => (phase === 'steps' ? STEPS[index] : phase);

function render() {
  for (const name of [...STEPS, 'done', 'data', ...RESTORING]) sectionFor(name).hidden = true;
  sectionFor(current()).hidden = false;

  nav.hidden = phase !== 'steps';
  // Step 6 and the restore live outside the form; the form's sections are all hidden by
  // then, but an empty form still takes its share of the card's height.
  form.hidden = phase === 'data' || RESTORING.includes(phase);
  backButton.hidden = index === 0;
  nextButton.textContent = index === STEPS.length - 1 ? 'Finish setup' : 'Next';
  document.querySelector('#wizard-lede').textContent = phase === 'steps'
    ? 'Five steps. Nothing is saved until the last one.'
    : phase === 'restore' ? 'The store from its old computer, from its backup.'
      : phase === 'connect' ? 'This device joins a store that is on the web.'
      : 'The store is set up and saved.';
  renderProgress();
  showError('');

  // An input before a button: step 1 opens with the restore offer above its first field.
  // The first one on screen: the setup code's input is in the page on a PC, hidden.
  const visible = (el) => el.offsetParent !== null;
  const first = [...sectionFor(current()).querySelectorAll('input')].find(visible)
    || [...sectionFor(current()).querySelectorAll('button')].find(visible);
  if (first) first.focus();
}

// ── The tax step (TAX-001) ──────────────────────────────────────────────────

/**
 * Each mode is offered with the plain-language sentence the server sends. The wording
 * lives in storeProfileService, not here: an operator choosing a tax mode at install is
 * not a tax accountant, and two copies of that sentence would drift.
 */
function renderTaxModes(modes) {
  document.querySelector('#tax-modes').innerHTML = modes.map((mode, i) => `
    <label class="choice">
      <input type="radio" name="taxMode" value="${mode.value}"${i === 0 ? ' checked' : ''}>
      <span class="choice-body">
        <strong>${mode.label}</strong>
        <small class="muted">${mode.sentence}</small>
      </span>
    </label>`).join('');
}

// ── The industry (TASK-053) ─────────────────────────────────────────────────

/**
 * One application, the industry chosen here and fixed from then on. The list is the
 * server's (config/industries.js), so the wizard, the sign-in screen and the public site
 * name the same kinds of store; the ones not offered yet are shown, and cannot be picked.
 */
function renderIndustries(list) {
  document.querySelector('#industries').innerHTML = (list || []).map((industry) => `
    <label class="choice${industry.available ? '' : ' is-soon'}">
      <input type="radio" name="industry" value="${industry.code}"${industry.available ? '' : ' disabled'}>
      <span class="choice-body">
        <strong>${industry.label}${industry.available ? '' : ' <small class="soon">coming soon</small>'}</strong>
        <small class="muted">${industry.blurb}</small>
      </span>
    </label>`).join('');
}

// ── Per-step checks ─────────────────────────────────────────────────────────

const CHECKS = {
  store() {
    if (hosted && value('setupCode').replace(/[^A-Za-z0-9]/g, '').length < 8) return 'Type the setup code Chachi\'s sent you.';
    if (!form.elements.industry || !form.elements.industry.value) return 'Choose what kind of store this is.';
    if (value('storeName').length < 2) return 'Enter the store name.';
    return null;
  },
  tax() {
    if (!form.elements.taxMode || !form.elements.taxMode.value) return 'Choose a tax mode.';
    return null;
  },
  owner() {
    if (value('fullName').length < 2) return "Enter the owner's full name.";
    const username = value('username');
    if (username.length < 3 || username.length > 32) return 'The username is 3 to 32 characters.';
    if (field('password').value.length < 10) return 'The password is at least 10 characters.';
    if (field('password').value !== field('passwordConfirm').value) return 'The two passwords do not match.';
    const pin = value('pin');
    if (pin && !/^\d{6}$/.test(pin)) return 'The PIN is exactly 6 digits, or leave it empty.';
    return null;
  },
  recovery() {
    if (!field('acknowledgedRecoveryCode').checked) {
      return 'Tick the box to confirm you will write the recovery code down.';
    }
    return null;
  },
  backup() {
    if (!value('backupFolder')) return 'Choose a folder for automatic backups.';
    return null;
  },
};

// ── Completion ──────────────────────────────────────────────────────────────

function payload() {
  return {
    industry: form.elements.industry.value,
    store: {
      storeName: value('storeName'),
      address: value('address'),
      contactNo: value('contactNo'),
      tin: value('tin'),
    },
    taxMode: form.elements.taxMode.value,
    owner: {
      fullName: value('fullName'),
      username: value('username'),
      password: field('password').value,
      pin: value('pin') || null,
    },
    backupFolder: value('backupFolder'),
    acknowledgedRecoveryCode: field('acknowledgedRecoveryCode').checked,
    setupCode: hosted ? value('setupCode') : undefined,
  };
}

async function complete() {
  nextButton.disabled = true;
  try {
    const res = await fetch('api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    const body = await res.json();

    if (!res.ok) {
      // 04_UX_SPEC.md §5: an error says what failed and what to do. The server's
      // message already does; showing it verbatim beats inventing a second wording.
      showError(body.error ? body.error.message : `Setup failed (${res.status}).`);
      return;
    }

    // Shown once. It is not stored in plaintext anywhere and cannot be requested again
    // (SEC-5) — losing it means using POST /auth/recover, which issues a replacement.
    phase = 'done';
    document.querySelector('#recovery-code').textContent = body.recoveryCode;
    document.querySelector('#done-detail').textContent =
      `${body.profile.store_name} · owner "${body.owner.username}" · backups to ${body.backupFolder}`;
    // Not awaited: the recovery code is what matters now, and it is shown the moment the
    // store exists. Step 6 waits for the sign-in instead.
    signingIn = signInAsOwner();
    render();
  } catch (err) {
    showError(`The application did not answer (${err.message}). Close it and start it again.`);
  } finally {
    nextButton.disabled = false;
  }
}

// ── Step 6 — the store's existing data (TASK-047) ───────────────────────────

/**
 * Sign in as the owner the wizard has just created, for step 6's TX-427.
 *
 * Done straight after setup rather than when step 6 is opened, so the password can be
 * cleared from the form while the owner is still reading the recovery code instead of
 * sitting in the page for as long as they take to write it down. The token is in memory
 * only (SEC-7) and dies with this page; the application asks for the password again.
 */
async function signInAsOwner() {
  try {
    const session = await api.post('/auth/login', {
      username: value('username'),
      password: field('password').value,
    });
    api.setToken(session.token);
    signedIn = { user: session.user };
  } catch {
    // Not a reason to hide the recovery code. Step 6 says what happened instead.
    signedIn = null;
  } finally {
    field('password').value = '';
    field('passwordConfirm').value = '';
  }
}

let panel = null;

async function openDataStep() {
  await signingIn;
  phase = 'data';
  const lede = document.querySelector('#data-lede');
  if (!signedIn) {
    lede.textContent = 'The wizard could not sign in as the owner, so this step cannot run here. '
      + 'Go to the application, sign in, and use Admin → Export / import — it is the same load.';
    document.querySelector('#opening').hidden = true;
  } else if (!panel) {
    panel = createOpeningLoad({
      root: document.querySelector('#opening'),
      heading: null,
      onLoaded: () => { loaded = true; renderProgress(); },
    });
    panel.mount();
  }
  render();
}

// ── Or: restore the store from its old computer (TASK-057) ─────────────────

function restoreError(message) {
  const box = document.querySelector('#restore-error');
  box.textContent = message;
  box.hidden = !message;
}

/**
 * The file goes as it is, not in JSON: a backup carries every product picture and can
 * be hundreds of megabytes. The server checks it exactly as a restore on the Backups
 * screen does, and refuses one a newer version made.
 */
async function restoreBackup() {
  const go = document.querySelector('#restore-go');
  const file = document.querySelector('#restore-file').files[0];
  const folder = document.querySelector('#restore-folder').value.trim();
  if (!file) return restoreError('Choose the backup file.');
  if (!folder) return restoreError("Choose a folder for this computer's backups.");

  restoreError('');
  go.disabled = true;
  go.textContent = 'Checking and restoring…';
  try {
    const query = `fileName=${encodeURIComponent(file.name)}&backupFolder=${encodeURIComponent(folder)}`;
    const res = await fetch(`api/v1/setup/restore?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        // TASK-062: in a header, checked before the upload is read.
        ...(hosted ? { 'x-setup-code': document.querySelector('#restore-code').value.trim() } : {}),
      },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return restoreError(body.error ? body.error.message : `The restore failed (${res.status}).`);

    phase = 'restored';
    const owners = body.owners && body.owners.length ? ` (the owner: ${body.owners.join(', ')})` : '';
    document.querySelector('#restored-detail').textContent = `${body.store_name}, with ${body.sales} sales`
      + `${body.last_recorded_at_manila ? `, last recorded ${body.last_recorded_at_manila}` : ''}. `
      + `Sign in with the username and password you used on the old computer${owners}.`;
    document.querySelector('#restored-backup').textContent = body.first_backup.ok
      ? `This computer's first backup of it is in ${body.backup_folder}.`
      : `This computer's first backup did not work (${body.first_backup.error}) Open Admin → Backups after signing in.`;
    render();
  } catch (err) {
    restoreError(`The application did not answer (${err.message}). Close it and start it again.`);
  } finally {
    go.disabled = false;
    go.textContent = 'Restore';
  }
  return undefined;
}

document.querySelector('#to-restore').addEventListener('click', () => {
  phase = 'restore';
  if (hosted && !document.querySelector('#restore-code').value) {
    document.querySelector('#restore-code').value = value('setupCode');
  }
  if (!document.querySelector('#restore-folder').value) {
    document.querySelector('#restore-folder').value = value('backupFolder');
  }
  render();
});
document.querySelector('#restore-back').addEventListener('click', () => {
  phase = 'steps';
  restoreError('');
  render();
});
document.querySelector('#restore-go').addEventListener('click', restoreBackup);
document.querySelector('#restore-file').addEventListener('change', () => restoreError(''));
document.querySelector('#restored-go').addEventListener('click', () => {
  window.location.href = './';
});

// ── Or: connect to a store already on the web (TASK-063) ───────────────────

function connectError(message) {
  const box = document.querySelector('#connect-error');
  box.textContent = message;
  box.hidden = !message;
}

async function connect() {
  const go = document.querySelector('#connect-go');
  const read = (id) => document.querySelector(id).value.trim();
  if (!read('#connect-url')) return connectError('Type the store\'s web address.');
  if (!read('#connect-username') || !document.querySelector('#connect-password').value) return connectError('Sign in as the store\'s owner.');
  if (!read('#connect-name')) return connectError('Name this device.');
  connectError('');
  go.disabled = true;
  go.textContent = 'Downloading the store…';
  try {
    const res = await fetch('api/v1/setup/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hubUrl: read('#connect-url'), username: read('#connect-username'),
        password: document.querySelector('#connect-password').value, deviceName: read('#connect-name'),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return connectError(body.error ? body.error.message : `It did not connect (${res.status}).`);
    document.querySelector('#connect-password').value = '';
    phase = 'connected';
    document.querySelector('#connected-detail').textContent = `${body.store_name || 'The store'} is on this device as `
      + `"${body.device.name}", letter ${body.device.series}. Sign in with your username and password from the web store. `
      + 'Then link this device\'s subscription seat under Admin → Subscription.';
    render();
  } catch (err) {
    connectError(`The application did not answer (${err.message}). Close it and start it again.`);
  } finally {
    go.disabled = false;
    go.textContent = 'Connect';
  }
  return undefined;
}

document.querySelector('#to-connect').addEventListener('click', () => { phase = 'connect'; render(); });
document.querySelector('#connect-back').addEventListener('click', () => { phase = 'steps'; connectError(''); render(); });
document.querySelector('#connect-go').addEventListener('click', connect);
document.querySelector('#connected-go').addEventListener('click', () => { window.location.href = './'; });

// ── Wiring ──────────────────────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const problem = CHECKS[STEPS[index]]();
  if (problem) return showError(problem);

  // TASK-062: the setup code, checked now rather than at the last step.
  if (hosted && STEPS[index] === 'store') {
    const res = await fetch('api/v1/setup/code', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupCode: value('setupCode') }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const body = res ? await res.json().catch(() => ({})) : {};
      return showError(body.error ? body.error.message : 'The application did not answer.');
    }
  }

  if (index === STEPS.length - 1) return complete();
  index += 1;
  render();
});

backButton.addEventListener('click', () => {
  if (index === 0) return;
  index -= 1;
  render();
});

document.querySelector('#to-data').addEventListener('click', openDataStep);
for (const id of ['#go-to-app', '#skip-data']) {
  document.querySelector(id).addEventListener('click', () => {
    window.location.href = './';
  });
}

// TASK-053: one product for every kind of store, so a neutral mark rather than the pill.
document.querySelector('.wizard-mark').innerHTML = iconSvg('store');

try {
  const res = await fetch('api/v1/setup');
  const status = await res.json();

  // Already set up — this page was reached by hand, or by a stale tab. The API refuses
  // a second POST regardless (FR_1.1); this just avoids showing a form that cannot work.
  if (!status.required) {
    window.location.href = './';
  } else {
    renderTaxModes(status.tax_modes);
    renderIndustries(status.industries);
    if (status.suggested_backup_folder) field('backupFolder').value = status.suggested_backup_folder;
    // TASK-062: a web copy asks for its setup code, and its backup folder is the server's.
    hosted = Boolean(status.hosted);
    if (hosted) {
      // A web copy is the store; it does not connect to another one.
      document.querySelector('.connect-note').hidden = true;
      for (const el of document.querySelectorAll('.setup-code, .hosted-backup')) el.hidden = false;
      for (const el of document.querySelectorAll('.local-backup')) el.hidden = true;
      field('backupFolder').readOnly = true;
      document.querySelector('#restore-folder').readOnly = true;
      document.querySelector('.wizard-foot').textContent = 'This store is on the web: open its address from any '
        + 'device. Selling needs the internet; so does the monthly subscription check.';
    }
    render();
  }
} catch (err) {
  showError(`The application did not answer (${err.message}). Close it and start it again.`);
}
