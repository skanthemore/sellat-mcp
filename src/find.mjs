import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding a file by what a person calls it ("the contract I downloaded
 * yesterday"), so nobody has to type a path. Only names are read, never
 * contents, and only inside the user's everyday folders.
 */

const XDG_KEYS = {
  downloads: 'XDG_DOWNLOAD_DIR',
  desktop: 'XDG_DESKTOP_DIR',
  documents: 'XDG_DOCUMENTS_DIR',
  pictures: 'XDG_PICTURES_DIR',
};

const FALLBACK_NAMES = {
  downloads: 'Downloads',
  desktop: 'Desktop',
  documents: 'Documents',
  pictures: 'Pictures',
};

/** XDG user dirs (Linux names them per locale: ~/Descargas, ~/Escritorio…). */
function readXdgDirs(home) {
  try {
    const text = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const dirs = {};
    for (const match of text.matchAll(/^(XDG_\w+_DIR)="([^"]*)"/gm)) {
      dirs[match[1]] = match[2].replace(/^\$HOME/, home);
    }
    return dirs;
  } catch {
    return {};
  }
}

/** The everyday folders that exist on this machine, by role. */
export function userFolders(home = homedir()) {
  const xdg = readXdgDirs(home);
  const folders = {};
  for (const role of Object.keys(XDG_KEYS)) {
    const candidates = [xdg[XDG_KEYS[role]], join(home, FALLBACK_NAMES[role])].filter(Boolean);
    const found = candidates.filter((dir) => dir !== home && existsSync(dir));
    if (found.length) folders[role] = [...new Set(found)];
  }
  return folders;
}

/** Case- and accent-insensitive: "contrato" finds "Contrató_final.PDF". */
function fold(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'Library', 'AppData']);

/**
 * Files whose name contains every word of `query`, newest first. Bounded in
 * depth, in entries visited and in results, so a huge Documents folder costs
 * a fraction of a second, not a full disk scan.
 */
export async function findFiles({
  query = '',
  roots,
  modifiedWithinDays,
  limit = 20,
  maxDepth = 4,
  maxVisited = 20000,
  now = Date.now(),
} = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const since = modifiedWithinDays ? now - modifiedWithinDays * 86400000 : null;
  const matches = [];
  let visited = 0;
  let truncated = false;

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > maxVisited) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = fold(entry.name);
      if (!words.every((w) => name.includes(w))) continue;
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (since !== null && info.mtimeMs < since) continue;
      matches.push({ path, name: entry.name, size_bytes: info.size, modified: new Date(info.mtimeMs).toISOString() });
    }
  }

  for (const root of roots) {
    if (visited > maxVisited) break;
    await walk(root, 1);
  }

  matches.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return { files: matches.slice(0, limit), total: matches.length, truncated };
}
