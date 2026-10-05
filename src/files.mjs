import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { userFolders } from './find.mjs';

/**
 * Everything that touches the user's disk. Files are read only to hash them;
 * their bytes never leave this process.
 */

/** `~/x` and relative paths, made absolute. Relative paths resolve against the server's cwd. */
export function expandPath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

/** SHA-256 of a file, streamed: the same for a 1 KB note or a 20 GB video. */
export function sha256File(filePath) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
      .on('error', fail);
  });
}

/** A regular file, or a clear error the model can repeat to the user. */
export function requireFile(path) {
  const absolute = expandPath(path);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new Error(`File not found: ${absolute}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${absolute}`);
  }
  return { path: absolute, size: stats.size, name: basename(absolute) };
}

// Control characters are the only thing a proof name may not carry (API v2 takes any string ≤ 200).
const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

export function cleanName(name) {
  return name.replace(CONTROL_CHARS, '').trim().slice(0, 200) || 'file';
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Informational only; the proof is about the bytes, not the type. */
export function mimeTypeFor(filePath) {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Where downloads go: SELLAT_DOWNLOAD_DIR, else the system's downloads folder (~/Descargas on a Spanish Linux), else home. */
export function defaultDownloadDir(env = process.env) {
  if (env.SELLAT_DOWNLOAD_DIR) return expandPath(env.SELLAT_DOWNLOAD_DIR);
  return userFolders().downloads?.[0] ?? homedir();
}

/** `name.pdf`, or `name (2).pdf` when that one is taken: a download never overwrites. */
export function freePath(directory, fileName) {
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = join(directory, fileName);
  for (let n = 2; existsSync(candidate); n++) {
    candidate = join(directory, `${stem} (${n})${ext}`);
  }
  return candidate;
}
