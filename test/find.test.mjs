import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findFiles, userFolders } from '../src/find.mjs';

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'sellat-home-'));
  await mkdir(join(home, '.config'), { recursive: true });
  await writeFile(join(home, '.config', 'user-dirs.dirs'), 'XDG_DOWNLOAD_DIR="$HOME/Descargas"\nXDG_DESKTOP_DIR="$HOME/Escritorio"\nXDG_DOCUMENTS_DIR="$HOME"\n');
  for (const dir of ['Descargas', 'Escritorio', 'Downloads', 'Descargas/viejos', 'Descargas/.oculto', 'Descargas/node_modules']) {
    await mkdir(join(home, dir), { recursive: true });
  }
  return home;
}

test('userFolders reads the localized XDG names and ignores a folder set to home itself', async () => {
  const home = await fakeHome();
  const folders = userFolders(home);
  assert.deepEqual(folders.downloads, [join(home, 'Descargas'), join(home, 'Downloads')]);
  assert.deepEqual(folders.desktop, [join(home, 'Escritorio')]);
  assert.equal(folders.documents, undefined);
});

test('findFiles: every word, any case or accent, newest first; skips hidden and node_modules', async () => {
  const home = await fakeHome();
  const d = join(home, 'Descargas');
  await writeFile(join(d, 'Contrató_Alquiler.PDF'), 'a');
  await writeFile(join(d, 'viejos', 'contrato alquiler 2019.pdf'), 'b');
  await writeFile(join(d, 'contrato-trabajo.pdf'), 'c');
  await writeFile(join(d, '.oculto', 'contrato alquiler.pdf'), 'd');
  await writeFile(join(d, 'node_modules', 'contrato alquiler.pdf'), 'e');
  const old = new Date('2019-05-01T00:00:00Z');
  await utimes(join(d, 'viejos', 'contrato alquiler 2019.pdf'), old, old);

  const result = await findFiles({ query: 'CONTRATO alquiler', roots: [d] });
  assert.deepEqual(
    result.files.map((f) => f.name),
    ['Contrató_Alquiler.PDF', 'contrato alquiler 2019.pdf']
  );

  const recent = await findFiles({ query: 'contrato', roots: [d], modifiedWithinDays: 2 });
  assert.deepEqual(recent.files.map((f) => f.name).sort(), ['Contrató_Alquiler.PDF', 'contrato-trabajo.pdf']);
});

test('findFiles stops at its bounds and says so', async () => {
  const home = await fakeHome();
  const d = join(home, 'Escritorio');
  for (let i = 0; i < 30; i++) await writeFile(join(d, `foto-${i}.jpg`), 'x');
  const result = await findFiles({ query: 'foto', roots: [d], maxVisited: 10, limit: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.files.length, 5);
});
