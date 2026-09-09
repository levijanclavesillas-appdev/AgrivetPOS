'use strict';

// A minimal ZIP writer and reader, for the backup archives (OPS-001).
//
// 05_TECH_SPEC.md §7 and TASK-017 requirement 2 both name the artefact:
// `agrivet_backup_….zip` in the configured folder. That is not decoration. A store PC
// in Sultan Kudarat recovers by someone plugging in a USB stick and double-clicking,
// and Windows Explorer opens a .zip natively and a .gz not at all. Compression also
// matters at the scale the product is sized for: a SQLite file compresses three to
// five times, and thirty retained backups of a 100 MB database is the difference
// between 3 GB and 700 MB on a stick someone actually owns.
//
// Written here rather than taken as a dependency because the deflate half — the only
// part that is real work — is in Node's own zlib, and the container around it is a
// documented file format about seventy lines long. The project runs on four runtime
// dependencies and this is not worth being the fifth.
//
// **The risk in hand-rolling an archive format is producing something only its own
// reader can open.** So the tests do not check this writer with this reader: they
// check it with Python's `zipfile`, an implementation that shares no code and no
// author with it. A format is only correct if something else agrees.
//
// Scope: deflated, no encryption, no ZIP64. A backup is a single SQLite file and
// `zipOne` writes exactly that; `zipMany` (TASK-025) writes the export archive, which
// is one JSON file per entity plus a manifest. Every limit that would need ZIP64 (4 GB)
// is far past the point where this product would have told the operator to archive
// (NFR_2.2).
//
// **`zipOne` is `zipMany` of one entry**, and is kept as its own name rather than as a
// call through: `unzipOne` refuses an archive holding more than one file, which is the
// check that makes "this backup contains a database" true rather than assumed. A
// backup that had quietly become a multi-entry archive is a restore nobody can reason
// about.

const zlib = require('zlib');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const DEFLATED = 8;
const VERSION_NEEDED = 20;          // 2.0 — the version that introduced deflate
const MAX_ZIP32_BYTES = 0xffffffff;

/**
 * CRC-32, the checksum ZIP carries for every entry.
 *
 * This is what makes the archive self-checking: a bit flipped on a USB stick fails
 * here on extraction rather than surfacing as a corrupt database page three months
 * later. zlib exposes one from Node 20, and the table below is the fallback so this
 * file does not quietly stop verifying on an older runtime.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date and time, which is what ZIP stores. Two-second resolution, since 1980. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * One file, deflated, as a complete ZIP archive.
 *
 * `entryName` is the name the file has inside the archive — what Explorer shows when
 * the operator opens it. It is deliberately the plain database name, so that the
 * recovery instruction is "open the zip, take out agrivet.db" and not a scavenger hunt.
 */
function zipOne(entryName, content, { at = new Date(), level = zlib.constants.Z_BEST_SPEED } = {}) {
  const name = Buffer.from(entryName, 'utf8');
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);

  if (raw.length > MAX_ZIP32_BYTES) {
    // ZIP64 is not implemented, and silently writing a broken archive is the one
    // outcome a backup format may never have.
    throw new RangeError(
      `${entryName} is ${raw.length} bytes, past the 4 GB limit of this archive writer. `
      + 'Archive older data before continuing (NFR_2.2).'
    );
  }

  const deflated = zlib.deflateRawSync(raw, { level });
  const crc = crc32(raw);
  const stamp = dosStamp(at);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(0, 6);                       // no flags: sizes are known up front
  local.writeUInt16LE(DEFLATED, 8);
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);                      // no extra field

  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_SIG, 0);
  central.writeUInt16LE(VERSION_NEEDED, 4);        // made by
  central.writeUInt16LE(VERSION_NEEDED, 6);        // needed to extract
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(DEFLATED, 10);
  central.writeUInt16LE(stamp.time, 12);
  central.writeUInt16LE(stamp.date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);                    // extra
  central.writeUInt16LE(0, 32);                    // comment
  central.writeUInt16LE(0, 34);                    // disk number
  central.writeUInt16LE(0, 36);                    // internal attributes
  central.writeUInt32LE(0o644 << 16, 38);          // external attributes, rw-r--r--
  central.writeUInt32LE(0, 42);                    // offset of the local header

  const centralOffset = local.length + name.length + deflated.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);                         // entries on this disk
  end.writeUInt16LE(1, 10);                        // entries total
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);                        // no archive comment

  return Buffer.concat([local, name, deflated, central, name, end]);
}

/**
 * Several files, deflated, as one ZIP archive (OPS-101).
 *
 * The export is one JSON file per entity plus `manifest.json`, and Explorer must show
 * them as the separate files they are — an operator asked to check an export opens it
 * and looks, and a single blob named `export.json` is not something anybody can look at.
 *
 * **Deterministic by construction** (requirement 8). Entries are written in the order
 * given, the DOS timestamp defaults to the ZIP epoch rather than to now, and the
 * deflate level is fixed. So the same data exported twice is byte-identical, and a
 * diff between two archives means the data changed — which is the only way a person
 * can use one export to check another.
 */
function zipMany(entries, { at = new Date(Date.UTC(1980, 0, 1)), level = zlib.constants.Z_BEST_SPEED } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RangeError('an archive needs at least one entry');
  }

  const stamp = dosStamp(at);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);

    if (raw.length > MAX_ZIP32_BYTES) {
      throw new RangeError(
        `${entry.name} is ${raw.length} bytes, past the 4 GB limit of this archive writer.`
      );
    }

    const deflated = zlib.deflateRawSync(raw, { level });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o644 << 16, 38);
    // Where this entry's local header sits. The one field that made this more than a
    // loop around zipOne, and the one every other reader navigates by.
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, deflated);
    centrals.push(central, name);
    offset += local.length + name.length + deflated.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([body, directory, end]);
}

/**
 * Every entry back out, each checked against its own CRC.
 *
 * Navigated through the **central directory**, not by walking local headers, for the
 * reason `unzipOne` already documents: every other tool finds files through that
 * record, so an archive whose directory disagrees with its contents is one this module
 * must refuse rather than quietly read past.
 */
function unzipMany(archive) {
  if (archive.length < 22) throw new Error('not a zip archive');

  const end = archive.length - 22;
  if (end < 0 || archive.readUInt32LE(end) !== END_SIG) {
    throw new Error('the archive has no end-of-central-directory record; it is truncated or damaged');
  }

  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error('the archive’s central directory is damaged');
    }

    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (archive.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`entry ${name} has no local header where the directory says it is`);
    }
    // The two headers describe the same entry, and a difference means one was altered.
    if (archive.readUInt32LE(localOffset + 14) !== expectedCrc) {
      throw new Error(`the archive’s two headers disagree about ${name}’s checksum`);
    }

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = archive.subarray(start, start + compressedSize);

    if (method !== DEFLATED && method !== 0) throw new Error(`unsupported compression method ${method}`);
    const content = method === DEFLATED ? zlib.inflateRawSync(body) : Buffer.from(body);

    if (content.length !== uncompressedSize) {
      throw new Error(`entry ${name} is ${content.length} bytes, header says ${uncompressedSize}`);
    }
    const actual = crc32(content);
    if (actual !== expectedCrc) {
      throw new Error(`entry ${name} failed its checksum (${actual} ≠ ${expectedCrc})`);
    }

    out.push({ name, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return out;
}

/**
 * Read the single entry back out, checking its CRC.
 *
 * Used by verification (OPS-002), which is the point: proving the archive can be read
 * back is a stronger claim than proving a file was written, and it is the claim the
 * rule actually needs.
 */
function unzipOne(archive) {
  if (archive.length < 22 || archive.readUInt32LE(0) !== LOCAL_SIG) {
    throw new Error('not a zip archive');
  }

  // The end-of-central-directory record, checked before anything else.
  //
  // An earlier version read only the local header, so a byte flipped in the central
  // directory passed verification here and produced an archive Windows Explorer would
  // refuse to open — the exact failure OPS-002 exists to catch, passing its own check.
  // Every other tool finds the file through this record, so a backup whose central
  // directory is damaged is not a backup, however readable it is to this module.
  const end = archive.length - 22;
  if (end < 0 || archive.readUInt32LE(end) !== END_SIG) {
    throw new Error('the archive has no end-of-central-directory record; it is truncated or damaged');
  }
  const entries = archive.readUInt16LE(end + 10);
  if (entries !== 1) throw new Error(`the archive holds ${entries} entries; a backup holds one`);

  const centralOffset = archive.readUInt32LE(end + 16);
  if (centralOffset + 46 > end || archive.readUInt32LE(centralOffset) !== CENTRAL_SIG) {
    throw new Error('the archive’s central directory is damaged');
  }
  // The two headers describe the same entry, and a difference between them means one
  // of the two has been altered.
  if (archive.readUInt32LE(centralOffset + 16) !== archive.readUInt32LE(14)) {
    throw new Error('the archive’s two headers disagree about the entry’s checksum');
  }
  if (archive.readUInt32LE(centralOffset + 24) !== archive.readUInt32LE(22)) {
    throw new Error('the archive’s two headers disagree about the entry’s size');
  }

  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const compressedSize = archive.readUInt32LE(18);
  const uncompressedSize = archive.readUInt32LE(22);
  const expectedCrc = archive.readUInt32LE(14);
  const method = archive.readUInt16LE(8);

  const name = archive.subarray(30, 30 + nameLength).toString('utf8');
  const start = 30 + nameLength + extraLength;
  const body = archive.subarray(start, start + compressedSize);

  if (method !== DEFLATED && method !== 0) throw new Error(`unsupported compression method ${method}`);
  const content = method === DEFLATED ? zlib.inflateRawSync(body) : Buffer.from(body);

  if (content.length !== uncompressedSize) {
    throw new Error(`entry ${name} is ${content.length} bytes, header says ${uncompressedSize}`);
  }
  const actual = crc32(content);
  if (actual !== expectedCrc) {
    // The bit-flip case. Better found here than as a corrupt page on the day it is
    // restored.
    throw new Error(`entry ${name} failed its checksum (${actual} ≠ ${expectedCrc})`);
  }

  return { name, content };
}

module.exports = { zipOne, unzipOne, zipMany, unzipMany, crc32, MAX_ZIP32_BYTES };
