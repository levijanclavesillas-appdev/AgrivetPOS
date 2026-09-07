// SCR-001 — the first-run wizard. Vanilla ES module, no build step
// (05_TECH_SPEC.md §2).
//
// The client-side checks here are a courtesy: they catch a typo before a round trip.
// Every one of them is repeated on the server, which is the only place a rule is
// actually enforced (SEC-6) — VR-501, VR-502, TAX-001, SEC-5 and OPS-001 all refuse
// again in setupService, and this file cannot weaken any of them.

const STEPS = ['store', 'tax', 'owner', 'recovery', 'backup'];
const LABELS = { store: 'Store', tax: 'Tax', owner: 'Owner', recovery: 'Recovery', backup: 'Backup' };

const form = document.querySelector('#wizard');
const errorBox = document.querySelector('#error');
const stepList = document.querySelector('#steps');
const backButton = document.querySelector('#back');
const nextButton = document.querySelector('#next');

let index = 0;
let done = false;

const sectionFor = (name) => document.querySelector(`.step[data-step="${name}"]`);
const field = (name) => form.elements[name];
const value = (name) => (field(name) ? field(name).value.trim() : '');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
  if (message) errorBox.scrollIntoView({ block: 'nearest' });
}

function renderProgress() {
  stepList.innerHTML = STEPS.map((name, i) => {
    const state = done || i < index ? 'done' : i === index ? 'current' : 'todo';
    return `<li class="${state}"><span>${i + 1}</span> ${LABELS[name]}</li>`;
  }).join('');
}

function render() {
  for (const name of [...STEPS, 'done']) sectionFor(name).hidden = true;
  sectionFor(done ? 'done' : STEPS[index]).hidden = false;

  backButton.hidden = done || index === 0;
  nextButton.hidden = done;
  nextButton.textContent = index === STEPS.length - 1 ? 'Finish setup' : 'Next';
  renderProgress();
  showError('');

  const first = sectionFor(done ? 'done' : STEPS[index]).querySelector('input, button');
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

// ── Per-step checks ─────────────────────────────────────────────────────────

const CHECKS = {
  store() {
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
  };
}

async function complete() {
  nextButton.disabled = true;
  try {
    const res = await fetch('/api/v1/setup', {
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
    done = true;
    document.querySelector('#recovery-code').textContent = body.recoveryCode;
    document.querySelector('#done-detail').textContent =
      `${body.profile.store_name} · owner "${body.owner.username}" · backups to ${body.backupFolder}`;
    render();
  } catch (err) {
    showError(`The application did not answer (${err.message}). Close it and start it again.`);
  } finally {
    nextButton.disabled = false;
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const problem = CHECKS[STEPS[index]]();
  if (problem) return showError(problem);

  if (index === STEPS.length - 1) return complete();
  index += 1;
  render();
});

backButton.addEventListener('click', () => {
  if (index === 0) return;
  index -= 1;
  render();
});

document.querySelector('#go-to-app').addEventListener('click', () => {
  window.location.href = '/';
});

try {
  const res = await fetch('/api/v1/setup');
  const status = await res.json();

  // Already set up — this page was reached by hand, or by a stale tab. The API refuses
  // a second POST regardless (FR_1.1); this just avoids showing a form that cannot work.
  if (!status.required) {
    window.location.href = '/';
  } else {
    renderTaxModes(status.tax_modes);
    if (status.suggested_backup_folder) field('backupFolder').value = status.suggested_backup_folder;
    render();
  }
} catch (err) {
  showError(`The application did not answer (${err.message}). Close it and start it again.`);
}
