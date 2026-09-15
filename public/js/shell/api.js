// The one place the renderer talks to the server.
//
// 05_TECH_SPEC.md §4 fixes the error shape — { code, message, rule_id, requires_role }
// — and §8.6 makes rule_id part of the contract, because "a refusal the UI cannot
// explain is an unfinished refusal". So every failure arrives here as an ApiError
// carrying the rule, and every view can render 04_UX_SPEC.md §5's **refused** state
// from it without parsing a message.
//
// SEC-7: the session token lives in memory and is never written to storage. It is
// replaced from the X-Session-Token header on every reply, which is what makes the
// timeout an idle one.

const BASE = '/api/v1';
const SESSION_HEADER = 'x-session-token';

let token = null;
const listeners = { session: [], error: [] };

export class ApiError extends Error {
  constructor({ status, code, message, ruleId = null, requiresRole = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.ruleId = ruleId;
    this.requiresRole = requiresRole;
  }

  /** 04_UX_SPEC.md §5: a refusal names the rule and who may authorise it. */
  get isRefusal() {
    return this.status === 403 || this.status === 409 || Boolean(this.ruleId);
  }
}

export function setToken(value) {
  token = value || null;
  for (const listener of listeners.session) listener(token);
}

export function getToken() {
  return token;
}

export function onSession(listener) {
  listeners.session.push(listener);
}

export function onError(listener) {
  listeners.error.push(listener);
}

async function request(method, path, body = null, { signal = null } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    // The server is in-process on this machine (05_TECH_SPEC.md §1), so this is not
    // "you are offline" — it is the application failing, and it says so.
    throw new ApiError({
      status: 0,
      code: 'UNREACHABLE',
      message: 'The application stopped responding. Close it and start it again.',
    });
  }

  // SEC-7: the re-issued session, taken on every reply including a refusal.
  const refreshed = response.headers.get(SESSION_HEADER);
  if (refreshed) setToken(refreshed);

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (response.ok) return payload;

  const error = new ApiError({
    status: response.status,
    code: payload?.error?.code || 'ERROR',
    message: payload?.error?.message || 'Something went wrong.',
    ruleId: payload?.error?.rule_id || null,
    requiresRole: payload?.error?.requires_role || null,
  });

  // An expired session is not an error the current view should render; the shell
  // takes it and shows the lock screen over the preserved cart (POS-105, SCR-102).
  if (response.status === 401) setToken(null);
  for (const listener of listeners.error) listener(error);
  throw error;
}

export const get = (path, opts) => request('GET', path, null, opts);
export const post = (path, body, opts) => request('POST', path, body ?? {}, opts);
export const put = (path, body, opts) => request('PUT', path, body ?? {}, opts);
export const del = (path, opts) => request('DELETE', path, null, opts);

/**
 * A file the server generates, fetched with the session header (TX-426).
 *
 * A plain <a href> cannot do this: SEC-7 keeps the token in memory only, so a link the
 * browser follows on its own arrives unauthenticated and the user gets a 401 page
 * instead of a spreadsheet. The response is fetched here and handed to the browser as
 * a blob, and a refusal comes back as an ApiError like any other.
 */
/**
 * Fetch a file the server produces, and hand it back with the name it gave it.
 *
 * Grew a method and a body for TASK-025: the audit and report exports are `GET`s
 * returning CSV, and the data export is a `POST` returning a zip. One function rather
 * than two, because the interesting half — the refusal shape, the session refresh, the
 * filename out of `content-disposition` — is the same for both, and two copies of it
 * would drift the first time one was fixed.
 *
 * Returns `text` for a textual response and `blob` for anything else. A caller that
 * reads `.text` on a zip would get mojibake, so binary is not decoded at all.
 */
export async function download(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null);

  if (!response) {
    throw new ApiError({
      status: 0, code: 'UNREACHABLE',
      message: 'The application stopped responding. Close it and start it again.',
    });
  }

  const refreshed = response.headers.get(SESSION_HEADER);
  if (refreshed) setToken(refreshed);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new ApiError({
      status: response.status,
      code: payload?.error?.code || 'ERROR',
      message: payload?.error?.message || 'The export could not be produced.',
      ruleId: payload?.error?.rule_id || null,
      requiresRole: payload?.error?.requires_role || null,
    });
    for (const listener of listeners.error) listener(error);
    throw error;
  }

  const disposition = response.headers.get('content-disposition') || '';
  const named = disposition.match(/filename="([^"]+)"/);
  const filename = named ? named[1] : 'export.csv';

  const type = response.headers.get('content-type') || '';
  if (/^text\/|json|csv/.test(type)) {
    // Decoded from the bytes with `ignoreBOM`, not through `response.text()`.
    // `text()` follows the encoding standard and *strips* a leading BOM, which would
    // quietly undo the three bytes the opening-data templates are served with — and
    // those three bytes are the whole reason Excel on a Philippine desktop reads the
    // file as UTF-8 instead of the system code page.
    const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
    return { text: decoded, blob: null, filename, type };
  }
  return { text: null, blob: await response.blob(), filename, type };
}

/**
 * A picture the server holds, as a Blob — or null when there is none (TASK-052).
 *
 * The same reason as `download`: an `<img>` pointed at the API arrives without the
 * token SEC-7 keeps in memory. Quiet on a 404, because "this product has no picture"
 * is an answer, not an error a screen should announce.
 */
export async function blob(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  if (!response) return null;
  const refreshed = response.headers.get(SESSION_HEADER);
  if (refreshed) setToken(refreshed);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return response.blob();
}

/**
 * Save what `download` returned, as a file.
 *
 * The renderer has no build step and no file-saving library, and every screen that
 * offers a download had been writing these five lines itself. Here once, so a browser
 * quirk is fixed in one place.
 */
export function saveAs({ text, blob, filename, type }) {
  const payload = blob || new Blob([text], { type: type || 'text/plain;charset=utf-8' });

  // Android (TASK-049): a WebView has no download manager for a blob URL, so the app
  // saves the bytes to the tablet's Downloads itself, through the bridge it exposes.
  if (typeof window !== 'undefined' && window.ChachiAndroid) {
    payload.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      window.ChachiAndroid.saveFile(filename, payload.type || type || '', btoa(binary));
    });
    return filename;
  }
  const url = URL.createObjectURL(payload);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously races the browser's own read of
  // the URL in some builds, and the download silently produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
