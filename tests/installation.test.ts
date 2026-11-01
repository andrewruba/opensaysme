import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { administrationScript, packageRoot, purgeUserSettings, readInstallation } from '../src/installation.js';
import { writeConfig } from '../src/config.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opensaysme-installation-test-'));
  directories.push(root);
  return root;
}

it('distinguishes a source tree from a package and validates installation metadata', async () => {
  const root = await fixture();
  expect(await readInstallation(root)).toBeNull();
  const metadata = { version: 1, kind: 'macos-pkg', root: packageRoot, architecture: 'arm64' };
  await writeFile(join(root, 'installation.json'), JSON.stringify(metadata));
  expect(await readInstallation(root)).toMatchObject(metadata);
  await writeFile(join(root, 'installation.json'), JSON.stringify({ ...metadata, root: '/tmp/other-installation' }));
  await expect(readInstallation(root)).rejects.toThrow('metadata is invalid');
  await rm(join(root, 'installation.json'));
  await writeFile(join(root, 'other'), JSON.stringify(metadata));
  await symlink(join(root, 'other'), join(root, 'installation.json'));
  await expect(readInstallation(root)).rejects.toThrow('metadata is invalid');
});

it('accepts only typed administrator operations and safely quotes package paths', () => {
  expect(administrationScript('uninstall')).toContain('with administrator privileges');
  const script = administrationScript('update', ["/tmp/a'b.pkg", 'a'.repeat(64)]);
  expect(script).toContain("a'\\\\''b.pkg");
  expect(() => administrationScript('uninstall', ['extra'])).toThrow('Invalid');
  expect(() => administrationScript('update', ['relative.pkg', 'a'.repeat(64)])).toThrow('Invalid');
  expect(() => administrationScript('update', ['/tmp/a\npkg', 'a'.repeat(64)])).toThrow('Invalid');
  expect(() => administrationScript('update', ['/tmp/a.pkg', 'invalid'])).toThrow('Invalid');
});

it('purges only recognized settings and history without deleting their containing directory', async () => {
  const root = await fixture();
  vi.stubEnv('OPENSAYSME_CONFIG_DIR', root);
  await writeConfig({ version: 1, shareVisualContext: true,
    speech: { provider: 'openai', model: 'speech', apiKeyEnv: 'KEY' },
    reasoning: { provider: 'openai', model: 'reasoning', apiKeyEnv: 'KEY' },
  }, join(root, 'config.json'));
  await writeFile(join(root, 'work-context.json'), '{"version":1,"references":[]}');
  await writeFile(join(root, 'keep.txt'), 'unrelated');
  await mkdir(join(root, '.opensaysme-debug'));
  await writeFile(join(root, '.opensaysme-debug', 'capture.json'), 'private capture');
  expect(await purgeUserSettings()).toEqual([join(root, 'config.json'), join(root, 'work-context.json')]);
  expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('unrelated');
  expect(await readFile(join(root, '.opensaysme-debug', 'capture.json'), 'utf8')).toBe('private capture');
  expect(await purgeUserSettings()).toEqual([]);
});

it('does not purge symlinked or unrelated JSON files in a custom configuration directory', async () => {
  const root = await fixture();
  vi.stubEnv('OPENSAYSME_CONFIG_DIR', root);
  await writeFile(join(root, 'config.json'), '{"someOtherApplication":true}');
  await expect(purgeUserSettings()).rejects.toThrow('Cannot safely remove');
  expect(await readFile(join(root, 'config.json'), 'utf8')).toContain('someOtherApplication');
  await rm(join(root, 'config.json'));
  await writeFile(join(root, 'target.json'), '{"version":1,"references":[]}');
  await symlink(join(root, 'target.json'), join(root, 'work-context.json'));
  await expect(purgeUserSettings()).rejects.toThrow('Cannot safely remove');
  expect(await readFile(join(root, 'target.json'), 'utf8')).toContain('references');
});
