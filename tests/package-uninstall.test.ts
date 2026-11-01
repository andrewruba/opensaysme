import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uninstall } from '../src/uninstall.js';

const mocks = vi.hoisted(() => ({ installation: vi.fn(), administer: vi.fn(), purge: vi.fn(), maintenance: vi.fn() }));
vi.mock('../src/installation.js', () => ({ readInstallation: mocks.installation, administerPackage: mocks.administer, purgeUserSettings: mocks.purge }));
vi.mock('../src/installation-runtime.js', () => ({ withInstallationMaintenance: mocks.maintenance }));
const directories: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.maintenance.mockImplementation(async (_root, _signal, operation) => operation());
  vi.spyOn(process, 'getuid').mockReturnValue(501);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-package-uninstall-'));
  directories.push(directory);
  const root = join(directory, 'install'), appRoot = join(root, 'app');
  await mkdir(appRoot, { recursive: true });
  mocks.installation.mockResolvedValue({ root, appRoot });
  return { root, appRoot };
}

it('uses maintenance and native authorization, verifies removal, and preserves settings by default', async () => {
  const f = await fixture();
  mocks.administer.mockImplementation(async () => rm(f.root, { recursive: true }));
  expect(await uninstall()).toEqual([f.root]);
  expect(mocks.maintenance.mock.calls[0]![0]).toBe(f.appRoot);
  expect(mocks.administer.mock.calls[0]!.slice(1, 3)).toEqual(['uninstall', []]);
  expect(mocks.purge).not.toHaveBeenCalled();
});

it('does not report success or purge if package removal cannot be verified', async () => {
  await fixture();
  mocks.administer.mockResolvedValue(undefined);
  await expect(uninstall(undefined, { purge: true })).rejects.toThrow('still present');
  expect(mocks.purge).not.toHaveBeenCalled();
});

it('purges only when explicitly requested and refuses to purge as root', async () => {
  const f = await fixture();
  mocks.administer.mockImplementation(async () => rm(f.root, { recursive: true }));
  mocks.purge.mockResolvedValue(['settings/config.json']);
  expect(await uninstall(undefined, { purge: true })).toEqual([f.root, 'settings/config.json']);
  expect(mocks.purge).toHaveBeenCalledOnce();
  vi.mocked(process.getuid!).mockReturnValue(0);
  await expect(uninstall(undefined, { purge: true })).rejects.toThrow('without sudo');
  expect(mocks.administer).toHaveBeenCalledOnce();
});
