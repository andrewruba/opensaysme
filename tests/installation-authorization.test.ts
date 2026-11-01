import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { administerPackage, packageAppRoot, packageRoot, type PackageInstallation } from '../src/installation.js';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), lstat: vi.fn(), readFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execute }));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(), lstat: mocks.lstat, readFile: mocks.readFile,
}));
const installation: PackageInstallation = { version: 1, kind: 'macos-pkg', architecture: 'arm64', root: packageRoot, appRoot: packageAppRoot };
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process, 'getuid').mockReturnValue(501);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  mocks.lstat.mockImplementation(async (path: string) => ({
    uid: 0, mode: 0o755, isSymbolicLink: () => false,
    isDirectory: () => !path.endsWith('manage.sh') && !path.endsWith('.opensaysme-package'),
    isFile: () => path.endsWith('manage.sh') || path.endsWith('.opensaysme-package'),
  }));
  mocks.readFile.mockResolvedValue('dev.opensaysme.cli\n');
});
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(process.platform !== 'darwin')('native package authorization', () => {
  it('honors cancellation before authorization without launching a child', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(administerPackage(installation, 'uninstall', [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('waits for privileged work to finish after cancellation instead of abandoning Installer', async () => {
    let finish: ((error: Error | null, value?: string) => void) | undefined;
    mocks.execute.mockImplementation((_path, _args, _options, callback) => { finish = callback; });
    const controller = new AbortController();
    let completed = false;
    const pending = administerPackage(installation, 'uninstall', [], controller.signal).then(() => { completed = true; });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const call = mocks.execute.mock.calls[0]!;
    expect(call[0]).toBe('/usr/bin/osascript');
    expect(call[1][0]).toBe('-e');
    expect(call[2]).not.toHaveProperty('signal');
    controller.abort();
    await Promise.resolve();
    expect(completed).toBe(false);
    finish!(null, '');
    await pending;
    expect(completed).toBe(true);
  });

  it('reports denied authorization and rejects writable helper installations before prompting', async () => {
    mocks.execute.mockImplementation((_path, _args, _options, callback) => {
      callback(Object.assign(new Error('user cancelled'), { stderr: 'User canceled. (-128)' }));
    });
    await expect(administerPackage(installation, 'uninstall')).rejects.toThrow('authorization was cancelled');
    mocks.execute.mockClear();
    mocks.lstat.mockResolvedValue({ uid: 501, mode: 0o777, isSymbolicLink: () => false });
    await expect(administerPackage(installation, 'uninstall')).rejects.toThrow('unsafe permissions');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
