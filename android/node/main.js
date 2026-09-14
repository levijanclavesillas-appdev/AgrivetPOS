'use strict';

// The server, on the tablet — TASK-049.
//
// NodeRuntime.java unpacks this folder, sets the environment (AGRIVET_DATA_DIR,
// AGRIVET_PORT, AGRIVET_SQLITE_ADDON, AGRIVET_BACKUP_SUGGESTION) and runs this file.
// Everything past this line is src/ as the Windows build runs it.

const server = require('./src/server');

server.start({ log: (line) => process.stdout.write(`${line}\n`) }).catch((err) => {
  // Logcat shows it (adb logcat -s ChachiNode), and the app's loading screen, which is
  // waiting on /health, says the server did not start.
  process.stderr.write(`The server did not start: ${err.stack || err.message}\n`);
});
