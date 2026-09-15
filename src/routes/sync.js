'use strict';

// TASK-063 — one store on the web and its devices.
//
// On the store's web copy (the hub):
//   POST /sync/devices              TX-423   a device joins: its id, letter and secret
//   GET  /sync/devices              TX-423   the store's devices
//   PUT  /sync/devices/:id          TX-423   rename one
//   POST /sync/devices/:id/revoke   TX-423   remove one; it stops syncing at once
//   GET  /sync/snapshot             device   the store, for a device to start from
//   POST /sync/push                 device   a device's changes
//   GET  /sync/pull?since=          device   everybody's changes since a version
//
// On any installation:
//   GET  /sync/status               signed in  where this is, how many changes wait
//   POST /sync/now                  signed in  sync this device now
//   POST /sync/go-online            TX-427     a store that began here goes on the web
//
// "device" is `Authorization: Device <id>.<secret>`, never a person's session: a device
// syncs whoever is signed in on it, and whether anybody is.

const express = require('express');
const fs = require('fs');
const syncService = require('../services/syncService');
const syncClient = require('../services/syncClient');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const owner = [authenticate, requirePermission('TX-423')];

const asDevice = (req, res, next) => {
  try {
    req.device = syncService.authenticateDevice(req.get('authorization'));
    next();
  } catch (err) {
    next(err);
  }
};

router.post('/sync/devices', owner, (req, res, next) => {
  try {
    const { name, platform, appVersion, schema } = req.body || {};
    res.status(201).json(syncService.registerDevice({ name, platform, appVersion, schema }, req.session));
  } catch (err) {
    next(err);
  }
});

router.get('/sync/devices', owner, (req, res, next) => {
  try {
    res.json({ devices: syncService.listDevices() });
  } catch (err) {
    next(err);
  }
});

router.put('/sync/devices/:id', owner, (req, res, next) => {
  try {
    res.json({ device: syncService.renameDevice(req.params.id, (req.body || {}).name, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/sync/devices/:id/revoke', owner, (req, res, next) => {
  try {
    res.json({ device: syncService.revokeDevice(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.get('/sync/snapshot', asDevice, (req, res, next) => {
  let snap = null;
  try {
    snap = syncService.snapshot();
    res.set('Content-Type', 'application/zip');
    res.set('X-Sync-Version', String(snap.version));
    res.set('X-Sync-Schema', String(snap.schema_version));
    const cleanup = () => fs.rm(snap.dir, { recursive: true, force: true }, () => {});
    res.on('close', cleanup);
    fs.createReadStream(snap.file).on('error', next).pipe(res);
  } catch (err) {
    if (snap) fs.rm(snap.dir, { recursive: true, force: true }, () => {});
    next(err);
  }
});

router.post('/sync/push', asDevice, (req, res, next) => {
  try {
    res.json(syncService.applyPush(req.device, req.body || {}));
  } catch (err) {
    next(err);
  }
});

router.get('/sync/pull', asDevice, (req, res, next) => {
  try {
    res.json(syncService.pull(req.device, { since: req.query.since, limit: req.query.limit }));
  } catch (err) {
    next(err);
  }
});

router.get('/sync/status', authenticate, (req, res, next) => {
  try {
    res.json({ ...syncService.status(), connected: syncClient.reachable() });
  } catch (err) {
    next(err);
  }
});

router.post('/sync/now', authenticate, async (req, res, next) => {
  try {
    res.json({ ...(await syncClient.syncNow()), connected: syncClient.reachable() });
  } catch (err) {
    next(err);
  }
});

router.post('/sync/go-online', [authenticate, requirePermission('TX-427')], async (req, res, next) => {
  try {
    const { hubUrl, setupCode, password, deviceName } = req.body || {};
    res.json(await syncClient.goOnline({
      hubUrl, setupCode, password, deviceName, appVersion: require('../../package.json').version,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
