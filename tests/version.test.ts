import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(lockVersion = '0.2.0', rootVersion = lockVersion) {
  const root = await mkdtemp(join(tmpdir(), 'opensaysme-version-'));
  directories.push(root);
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts', 'check-version.mjs');
  await copyFile(new URL('../scripts/check-version.mjs', import.meta.url), script);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: lockVersion, packages: { '': { version: rootVersion } } }));
  return script;
}

it.each([
  ['branch', 'main'],
  ['tag', 'v0.2.0'],
])('accepts consistent metadata for %s %s', async (type, ref) => {
  const script = await fixture();
  const { stdout } = await execute(process.execPath, [script], {
    env: { ...process.env, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: ref },
  });
  expect(stdout).toContain('0.2.0');
});

it.each([
  ['0.1.0', '0.2.0'],
  ['0.2.0', '0.1.0'],
])('rejects stale lockfile versions (%s, %s)', async (lockVersion, rootVersion) => {
  const script = await fixture(lockVersion, rootVersion);
  await expect(execute(process.execPath, [script])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('must match package.json') });
});

it('rejects a release tag that disagrees with the package version', async () => {
  const script = await fixture();
  await expect(execute(process.execPath, [script], {
    env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.0.0' },
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Release tag must match') });
});
