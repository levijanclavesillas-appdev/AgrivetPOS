'use strict';

// better-sqlite3, opened the one way this product opens it — TASK-049.
//
// On Windows, in `npm start` and in the tests, the native addon is the one npm built
// into node_modules for the Node that is running. On Android it cannot be: the addon
// has to be compiled for the tablet's CPU against the Node the app embeds, so Android
// Studio compiles it into the APK (`android/app/src/main/cpp`) and the app says where
// it is with AGRIVET_SQLITE_ADDON. Everything above this file is the same either way.

const Database = require('better-sqlite3');

let addon = null;

/** The addon the app compiled, loaded once — or undefined, which means npm's own. */
function nativeBinding() {
  const file = process.env.AGRIVET_SQLITE_ADDON;
  if (!file) return undefined;
  if (!addon) {
    // Loaded by hand rather than by path: the APK's copy is `libbetter_sqlite3.so`, and
    // better-sqlite3 appends `.node` to any path it is given.
    const module = { exports: {} };
    process.dlopen(module, file);
    addon = module.exports;
  }
  return addon;
}

/** `new Database(file, options)`, with the Android addon when there is one. */
function openDatabase(file, options = {}) {
  const binding = nativeBinding();
  return new Database(file, binding ? { ...options, nativeBinding: binding } : options);
}

module.exports = { openDatabase };
