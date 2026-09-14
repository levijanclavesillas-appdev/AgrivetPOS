'use strict';

// Start the licence server: `npm start`, configured from the environment (config.js).

const { fromEnv } = require('./config');
const db = require('./db');
const licence = require('./licence');
const { createService } = require('./service');
const { createGoogle } = require('./google');
const { createPlay } = require('./play');
const { createApp } = require('./app');

const config = fromEnv();
const privateKey = licence.loadOrCreateKey(config.keyFile);
const service = createService({ db: db.open(config.databaseFile), config, privateKey });
const google = createGoogle({ ...config.google, redirectUri: `${config.baseUrl}/auth/google/callback` });
const play = createPlay(config.play);

createApp({ service, config, google, play }).listen(config.port, config.host, () => {
  process.stdout.write(`licence server on ${config.host}:${config.port} for ${config.baseUrl}`
    + ` · Google ${google.configured ? 'ready' : 'NOT configured'} · Play ${play.configured ? 'ready' : 'NOT configured'}`
    + ` · admin ${config.admin.passwordHash ? 'ready' : 'NOT configured'}\n`);
});
