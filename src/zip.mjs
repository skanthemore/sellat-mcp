import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of a ZIP reader to take `proof.json` out of a SELLAT evidence
 * package: the central directory, stored and deflated entries. No ZIP64 —
 * an evidence package holding a 4 GB original is not something this reads,
 * and it says so instead of guessing.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  // The record is 22 bytes plus a comment of at most 65 535.
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('not a ZIP file (no end of central directory)');
}

/** Every entry's name, in the order the archive lists them. */
export function listEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error('corrupt ZIP central directory');
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one entry. */
export function readEntry(buffer, entry) {
  const at = entry.localHeaderOffset;
  if (buffer.readUInt32LE(at) !== LOCAL) {
    throw new Error(`corrupt ZIP local header for ${entry.name}`);
  }
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/**
 * The `proof.json` of an evidence package, or null when the package was made
 * before its batch was anchored (a provisional package has none).
 */
export function proofJsonFromZip(buffer) {
  const entry = listEntries(buffer).find((e) => e.name === 'proof.json' || e.name.endsWith('/proof.json'));
  return entry ? JSON.parse(readEntry(buffer, entry).toString('utf8')) : null;
}
