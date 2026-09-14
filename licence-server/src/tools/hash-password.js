'use strict';

// Print the bcrypt hash of an admin password for ADMIN_PASSWORD_HASH.
//   node src/tools/hash-password.js            (reads the password from stdin)

const bcrypt = require('bcryptjs');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const password = input.replace(/\r?\n$/, '');
  if (password.length < 12) { process.stderr.write('Use at least 12 characters.\n'); process.exit(1); }
  process.stdout.write(`${bcrypt.hashSync(password, 12)}\n`);
});
