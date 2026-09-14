'use strict';

// The licence server's pages: /link for a store owner, /admin for Chachi's. Plain HTML,
// one stylesheet, no script — nothing here needs one, and a page with no script cannot
// be made to run somebody else's.

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `
:root{--primary:#2563eb;--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--canvas:#f1f5f9;--surface:#fff;--warn:#fef3c7;--warn-ink:#92400e;--ok:#dcfce7;--ok-ink:#166534;--err:#fee2e2;--err-ink:#991b1b}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1rem}main.wide{max-width:72rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.5rem;margin:0 0 1rem;box-shadow:0 1px 3px rgba(15,23,42,.06)}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:700;margin:0 0 1.5rem}.brand span{display:inline-grid;place-items:center;width:2rem;height:2rem;border-radius:.6rem;background:var(--primary);color:#fff}
h1{font-size:1.4rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}p{margin:0 0 1rem}.muted{color:var(--muted)}
label{display:block;font-weight:600;margin:0 0 .25rem}input,select{width:100%;min-height:44px;padding:.5rem .75rem;border:1px solid #cbd5e1;border-radius:.5rem;font:inherit;margin:0 0 1rem;background:#fff}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 1.25rem;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:var(--primary);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.primary{background:var(--primary);border-color:var(--primary);color:#fff}.danger{color:var(--err-ink)}
.code{font:600 1.75rem/1 ui-monospace,monospace;letter-spacing:.15em;text-align:center;text-transform:uppercase}
.note{padding:.75rem 1rem;border-radius:.6rem;margin:0 0 1rem}.note.warn{background:var(--warn);color:var(--warn-ink)}.note.ok{background:var(--ok);color:var(--ok-ink)}.note.err{background:var(--err);color:var(--err-ink)}
.choice{display:flex;gap:.75rem;align-items:flex-start;border:1px solid var(--line);border-radius:.75rem;padding:.75rem 1rem;margin:0 0 .5rem;font-weight:400}.choice input{width:auto;min-height:auto;margin:.3rem 0 0}
table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{text-align:left;padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.row form{margin:0}
.tag{display:inline-block;padding:0 .5rem;border-radius:999px;font-size:.8rem;font-weight:600}.tag.ok{background:var(--ok);color:var(--ok-ink)}.tag.warn{background:var(--warn);color:var(--warn-ink)}.tag.err{background:var(--err);color:var(--err-ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:0 1rem}
`;

function layout(title, body, { wide = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Chachi POS</title>
<link rel="stylesheet" href="/assets/site.css"></head>
<body><main${wide ? ' class="wide"' : ''}><p class="brand"><span>C</span> Chachi POS</p>${body}</main></body></html>`;
}

const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const date = (iso) => (iso ? esc(String(iso).slice(0, 10)) : '—');

/** The status of a store's subscription, as a tag. */
function paidTag(paidUntil, now) {
  const days = Math.ceil((new Date(paidUntil) - now) / 86400e3);
  if (days < 0) return `<span class="tag err">lapsed ${-days} d</span>`;
  if (days <= 7) return `<span class="tag warn">${days} d left</span>`;
  return `<span class="tag ok">paid</span>`;
}

const pages = {
  css: CSS,

  enterCode({ code = '', error = null, googleReady }) {
    return layout('Link a device', `<div class="card">
<h1>Link a POS to your store</h1>
<p class="muted">The POS shows a code. Enter it here, then sign in with the Google account that owns the store.</p>
${error ? `<p class="note err">${esc(error)}</p>` : ''}
<form method="get" action="/link"><label for="code">Code from the POS</label>
<input id="code" name="code" class="code" autocomplete="off" autocapitalize="characters" maxlength="9" value="${esc(code)}" placeholder="XXXX-XXXX">
<button class="primary" type="submit">Continue</button></form>
${googleReady ? '' : '<p class="note warn">Google sign-in is not set up on this server yet.</p>'}
</div>`);
  },

  signIn({ code, link }) {
    return layout('Sign in', `<div class="card">
<h1>Sign in to approve</h1>
<p>${esc(link.store_name || 'A POS')} ${link.platform ? `on ${esc(link.platform)}` : ''} is asking to join your store.</p>
<p class="muted">Sign in with the Google account that owns the store. Only the owner signs in with Google; everyone at the counter keeps their own POS login.</p>
<a class="button primary" href="/auth/google?code=${encodeURIComponent(code)}">Continue with Google</a>
</div>`);
  },

  approve({ code, link, stores, owner, csrf }) {
    const options = stores.map((s, i) => `<label class="choice"><input type="radio" name="store_id" value="${esc(s.id)}"${i === 0 ? ' checked' : ''}>
<span><strong>${esc(s.name)}</strong><br><span class="muted">Paid until ${date(s.paid_until)}</span></span></label>`).join('');
    return layout('Approve this device', `<div class="card">
<h1>Approve this device?</h1>
<p><strong>${esc(link.store_name || 'A POS')}</strong> ${link.platform ? `on ${esc(link.platform)}` : ''}, code <strong>${esc(code)}</strong>.</p>
<p class="muted">Signed in as ${esc(owner.email)}. <a href="/logout?code=${encodeURIComponent(code)}">Not you?</a></p>
<form method="post" action="/link/approve">${hidden('csrf', csrf)}${hidden('code', code)}
${stores.length ? `<p>Add it to:</p>${options}<label class="choice"><input type="radio" name="store_id" value="">
<span><strong>A new store</strong></span></label>` : '<p>This is your first store.</p>'}
<label for="name">${stores.length ? 'New store name (if new)' : 'Store name'}</label>
<input id="name" name="store_name" maxlength="120" value="${esc(link.store_name || '')}">
<div class="row"><button class="primary" type="submit">Approve</button>
<button type="submit" formaction="/link/deny" class="danger">Deny</button></div>
</form></div>`);
  },

  linked({ store }) {
    return layout('Linked', `<div class="card"><h1>Linked</h1>
<p class="note ok">The POS is now part of <strong>${esc(store.name)}</strong>. Go back to it — it finishes on its own within a few seconds.</p>
<p class="muted">Paid until ${date(store.paid_until)}. You can close this page.</p></div>`);
  },

  denied() {
    return layout('Denied', '<div class="card"><h1>Denied</h1><p>That POS was not linked. You can close this page.</p></div>');
  },

  message(title, text, kind = 'warn') {
    return layout(title, `<div class="card"><h1>${esc(title)}</h1><p class="note ${kind}">${esc(text)}</p><a class="button" href="/link">Back</a></div>`);
  },

  // ── Admin ──────────────────────────────────────────────────────────────────

  adminLogin({ error = null, configured }) {
    return layout('Admin', `<div class="card"><h1>Chachi POS admin</h1>
${configured ? '' : '<p class="note warn">No admin password is set on this server (ADMIN_PASSWORD_HASH).</p>'}
${error ? `<p class="note err">${esc(error)}</p>` : ''}
<form method="post" action="/admin/login"><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password">
<button class="primary" type="submit">Sign in</button></form></div>`);
  },

  adminStores({ stores, now, csrf }) {
    const rows = stores.map((s) => `<tr><td><a href="/admin/stores/${esc(s.id)}">${esc(s.name)}</a></td><td>${esc(s.owner_email)}</td>
<td>${date(s.paid_until)} ${paidTag(s.paid_until, now)}</td><td>${s.devices}</td><td>${date(s.last_check_at)}</td></tr>`).join('');
    return layout('Stores', `<div class="row" style="justify-content:space-between"><h1>Stores</h1>
<form method="post" action="/admin/logout">${hidden('csrf', csrf)}<button type="submit">Sign out</button></form></div>
<div class="card scroll"><table><thead><tr><th>Store</th><th>Owner</th><th>Paid until</th><th>Devices</th><th>Last check</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">No stores yet. A store appears when its owner links its first POS.</td></tr>'}</tbody></table></div>`, { wide: true });
  },

  adminStore({ detail, now, csrf, notice = null }) {
    const { store, installations, payments } = detail;
    const devices = installations.map((i) => `<tr><td>${esc(i.platform || '—')} ${esc(i.app_version || '')}<br><span class="muted">${esc(i.id)}</span></td>
<td>${date(i.created_at)}</td><td>${date(i.last_check_at)}</td>
<td>${i.revoked_at ? `removed ${date(i.revoked_at)}` : `<form method="post" action="/admin/installations/${esc(i.id)}/revoke">${hidden('csrf', csrf)}<button class="danger" type="submit">Remove</button></form>`}</td></tr>`).join('');
    const history = payments.map((p) => `<tr><td>${date(p.created_at)}</td><td>${esc(p.method)}</td>
<td>${p.amount_centavos == null ? '—' : `₱${(p.amount_centavos / 100).toFixed(2)}`}</td><td>${esc(p.reference || '')} ${esc(p.note || '')}</td>
<td>${date(p.paid_until_after)}</td><td>${esc(p.recorded_by)}</td></tr>`).join('');
    return layout(store.name, `<p><a href="/admin">← Stores</a></p>
<div class="card"><h1>${esc(store.name)}</h1><p class="muted">${esc(store.owner_email)} · since ${date(store.created_at)}</p>
<p>Paid until <strong>${date(store.paid_until)}</strong> ${paidTag(store.paid_until, now)}</p>
${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}</div>
<div class="card"><h2>Record a payment</h2><p class="muted">GCash or bank transfer. The subscription is extended from today or from the date already paid to, whichever is later.</p>
<form method="post" action="/admin/stores/${esc(store.id)}/payments">${hidden('csrf', csrf)}
<div class="grid"><div><label for="months">Months</label><input id="months" name="months" type="number" min="1" max="36" value="1" required></div>
<div><label for="amount">Amount (₱)</label><input id="amount" name="amount" inputmode="decimal" placeholder="e.g. 499.00"></div>
<div><label for="reference">Reference</label><input id="reference" name="reference" maxlength="80" placeholder="GCash ref no."></div></div>
<label for="note">Note</label><input id="note" name="note" maxlength="200">
<button class="primary" type="submit">Record payment</button></form></div>
<div class="card scroll"><h2>Devices</h2><table><thead><tr><th>Device</th><th>Linked</th><th>Last check</th><th></th></tr></thead><tbody>${devices || '<tr><td colspan="4" class="muted">None.</td></tr>'}</tbody></table></div>
<div class="card scroll"><h2>Payments</h2><table><thead><tr><th>Date</th><th>How</th><th>Amount</th><th>Reference</th><th>Paid until</th><th>By</th></tr></thead><tbody>${history}</tbody></table></div>`, { wide: true });
  },
};

module.exports = { pages, esc };
