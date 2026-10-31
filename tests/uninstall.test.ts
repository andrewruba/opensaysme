import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { uninstallLinks } from '../src/uninstall.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opensaysme-uninstall-')));
  directories.push(root);
  const repository = join(root, 'source checkout'), bin = join(root, 'prefix', 'bin');
  const packageLink = join(root, 'prefix', 'lib', 'node_modules', 'opensaysme');
  const launcher = join(repository, 'bin', 'opensaysme.mjs');
  await Promise.all([
    mkdir(join(repository, 'bin'), { recursive: true }), mkdir(bin, { recursive: true }),
    mkdir(join(root, 'prefix', 'lib', 'node_modules'), { recursive: true }),
  ]);
  await writeFile(launcher, '// fixture launcher');
  await writeFile(join(repository, 'config.json'), 'keep settings');
  await mkdir(join(repository, '.opensaysme-debug'));
  await writeFile(join(repository, '.opensaysme-debug', 'capture.json'), 'keep captures');
  return { root, repository, launcher, bin, packageLink };
}

it('removes npm-style command and package links, preserving source, settings and debug files', async () => {
  const f = await fixture();
  await symlink(f.repository, f.packageLink);
  for (const name of ['osm', 'opensaysme']) {
    await symlink(relative(f.bin, join(f.packageLink, 'bin', 'opensaysme.mjs')), join(f.bin, name));
  }
  const removed = await uninstallLinks(f.repository, [f.bin, f.bin]);
  expect(removed).toEqual([join(f.bin, 'osm'), join(f.bin, 'opensaysme'), f.packageLink]);
  for (const path of removed) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(f.launcher, 'utf8')).toBe('// fixture launcher');
  expect(await readFile(join(f.repository, 'config.json'), 'utf8')).toBe('keep settings');
  expect(await readFile(join(f.repository, '.opensaysme-debug', 'capture.json'), 'utf8')).toBe('keep captures');
  expect(await uninstallLinks(f.repository, [f.bin])).toEqual([]);
});

it('removes direct launcher links in custom command directories', async () => {
  const f = await fixture();
  const custom = join(f.root, 'custom commands');
  await mkdir(custom);
  await symlink(f.launcher, join(custom, 'osm'));
  await symlink(f.launcher, join(f.bin, 'opensaysme'));
  expect(await uninstallLinks(f.repository, [custom, f.bin])).toEqual([
    join(custom, 'osm'), join(f.bin, 'opensaysme'),
  ]);
});

it('preserves unrelated commands, regular files, broken links and other checkouts', async () => {
  const f = await fixture();
  const other = join(f.root, 'other checkout');
  await mkdir(other);
  await writeFile(join(other, 'launcher'), 'other app');
  await symlink(join(other, 'launcher'), join(f.bin, 'osm'));
  await writeFile(join(f.bin, 'opensaysme'), 'regular file');
  await symlink(other, f.packageLink);
  const brokenBin = join(f.root, 'broken bin');
  await mkdir(brokenBin);
  await symlink(join(f.root, 'missing'), join(brokenBin, 'osm'));
  expect(await uninstallLinks(f.repository, [f.bin, brokenBin, join(f.root, 'missing bin')])).toEqual([]);
  expect(await realpath(join(f.bin, 'osm'))).toBe(join(other, 'launcher'));
  expect(await readFile(join(f.bin, 'opensaysme'), 'utf8')).toBe('regular file');
  expect(await realpath(f.packageLink)).toBe(other);
  expect((await lstat(join(brokenBin, 'osm'))).isSymbolicLink()).toBe(true);
});

it('cleans up a matching package link when command links are already absent', async () => {
  const f = await fixture();
  await symlink(f.repository, f.packageLink);
  expect(await uninstallLinks(f.repository, [f.bin])).toEqual([f.packageLink]);
});

it('deduplicates command directories reached through symlinks', async () => {
  const f = await fixture();
  const alias = join(f.root, 'bin alias');
  await symlink(f.bin, alias);
  await symlink(f.launcher, join(f.bin, 'osm'));
  expect(await uninstallLinks(f.repository, [alias, f.bin])).toEqual([join(f.bin, 'osm')]);
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
});

it('makes no changes when cancelled', async () => {
  const f = await fixture();
  await symlink(f.launcher, join(f.bin, 'osm'));
  const controller = new AbortController(); controller.abort();
  await expect(uninstallLinks(f.repository, [f.bin], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await realpath(join(f.bin, 'osm'))).toBe(f.launcher);
});

it.skipIf(process.getuid?.() === 0)('reports unwritable installation directories without deleting source files', async () => {
  const f = await fixture();
  await symlink(f.launcher, join(f.bin, 'osm'));
  await chmod(f.bin, 0o555);
  try {
    await expect(uninstallLinks(f.repository, [f.bin])).rejects.toThrow('Check write access');
    expect(await realpath(join(f.bin, 'osm'))).toBe(f.launcher);
    expect(await readFile(f.launcher, 'utf8')).toBe('// fixture launcher');
  } finally { await chmod(f.bin, 0o755); }
});
