import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// Run a copy against temporary fixtures, substituting privileged system tools.
// These tests never request authorization or change the host installation.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'opensaysme-management-'));
  directories.push(directory);
  const root = join(directory, 'Application Support', 'OpenSaysMe'), commands = join(directory, 'commands');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(commands);
  await writeFile(join(root, '.opensaysme-package'), 'dev.opensaysme.cli\n');
  await writeFile(join(root, 'bin', 'osm'), 'fixture');
  const executable = async (name: string, body: string) => {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
    return path;
  };
  const id = await executable('id', 'printf "%s\\n" "${TEST_UID:-0}"');
  const stat = await executable('stat', 'if [ "$2" = %u ]; then printf "%s\\n" "${TEST_OWNER:-0}"; else exec /usr/bin/stat "$@"; fi');
  const ps = await executable('ps', 'if [ "$1" = -axo ]; then [ "${TEST_PS_FAIL:-0}" = 0 ] || exit 1; printf "%s\\n" "${TEST_HELPER:-}"; else printf "%s\\n" "Sun Nov 1 10:00:00 2026"; fi');
  const installer = await executable('installer', 'printf "%s\\n" "$2" > "$TEST_DIRECTORY/installer-path"\n/bin/cp "$2" "$TEST_DIRECTORY/installed.pkg"\nexit "${TEST_INSTALLER_STATUS:-0}"');
  const pkgutil = await executable('pkgutil', 'if [ "$1" = --forget ]; then printf "%s\\n" "$2" > "$TEST_DIRECTORY/forgot"; fi');
  const source = await readFile(new URL('../packaging/macos/manage.sh', import.meta.url), 'utf8');
  const script = source.replaceAll('/Library/Application Support/OpenSaysMe', root)
    .replaceAll("/Library '/Library/Application Support'", `'${directory}' '${join(directory, 'Application Support')}'`)
    .replaceAll('command_directory=/usr/local/bin', `command_directory='${commands}'`)
    .replaceAll('for path in /usr /usr/local "$command_directory";', `for path in '${directory}' "$command_directory";`)
    .replaceAll('/usr/bin/id', `'${id}'`).replaceAll('/usr/bin/stat', `'${stat}'`)
    .replaceAll('/bin/ps', `'${ps}'`).replaceAll('/usr/sbin/installer', `'${installer}'`)
    .replaceAll('/usr/sbin/pkgutil', `'${pkgutil}'`)
    .replaceAll('/private/tmp/opensaysme-installer.XXXXXX', `'${directory}/stage.XXXXXX'`);
  const path = join(root, 'manage.sh');
  await writeFile(path, script, { mode: 0o755 });
  const run = (args: string[], env: Record<string, string> = {}) => execute('/bin/sh', [path, ...args], {
    env: { ...process.env, TEST_DIRECTORY: directory, ...env }, timeout: 5000,
  });
  const packagePath = join(directory, "download's package.pkg");
  const bytes = Buffer.from('fixture package contents');
  await writeFile(packagePath, bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  return { directory, root, commands, path, packagePath, bytes, checksum, run };
}

describe.skipIf(process.platform !== 'darwin')('internal package management', () => {
  it('removes its installation and matching links while preserving unrelated commands', async () => {
    const f = await fixture();
    await symlink(join(f.root, 'bin', 'osm'), join(f.commands, 'osm'));
    await writeFile(join(f.commands, 'opensaysme'), 'unrelated command');
    await f.run(['uninstall']);
    await expect(lstat(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.commands, 'osm'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(f.commands, 'opensaysme'), 'utf8')).toBe('unrelated command');
    expect(await readFile(join(f.directory, 'forgot'), 'utf8')).toBe('dev.opensaysme.cli\n');
  });

  it('verifies a private staged copy and cleans staging and the operation marker', async () => {
    const f = await fixture();
    await f.run(['update', f.packagePath, f.checksum]);
    expect(await readFile(join(f.directory, 'installed.pkg'))).toEqual(f.bytes);
    const staged = (await readFile(join(f.directory, 'installer-path'), 'utf8')).trim();
    expect(staged).not.toBe(f.packagePath);
    await expect(lstat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.root, '.operation'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never invokes Installer on a bad checksum, and cleans temporary files', async () => {
    const f = await fixture();
    await expect(f.run(['update', f.packagePath, 'a'.repeat(64)])).rejects.toMatchObject({ stderr: expect.stringContaining('checksum does not match') });
    await expect(lstat(join(f.directory, 'installed.pkg'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.directory)).filter((name) => name.startsWith('stage.'))).toEqual([]);
    await expect(lstat(join(f.root, '.operation'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains recovery state after an Installer failure that may have changed payload files', async () => {
    const f = await fixture();
    await expect(f.run(['update', f.packagePath, f.checksum], { TEST_INSTALLER_STATUS: '1' })).rejects.toMatchObject({ code: 1 });
    expect(await readFile(join(f.root, '.operation', 'pid'), 'utf8')).toMatch(/^\d+\n$/);
    expect((await readFile(join(f.root, '.operation', 'started'), 'utf8')).trim()).not.toBe('');
    expect(await readFile(join(f.root, '.operation', 'action'), 'utf8')).toBe('update\n');
    expect((await readdir(f.directory)).filter((name) => name.startsWith('stage.'))).toEqual([]);
  });

  it('refuses non-root, unsafe ownership and unsafe writable helpers', async () => {
    const f = await fixture();
    await expect(f.run(['uninstall'], { TEST_UID: '501' })).rejects.toMatchObject({ stderr: expect.stringContaining('Administrator authorization') });
    await expect(f.run(['uninstall'], { TEST_OWNER: '501' })).rejects.toMatchObject({ stderr: expect.stringContaining('owned by root') });
    await chmod(f.path, 0o777);
    await expect(f.run(['uninstall'])).rejects.toMatchObject({ stderr: expect.stringContaining('unsafe permissions') });
    expect((await lstat(f.root)).isDirectory()).toBe(true);
  });

  it('refuses an unrecognized installation and concurrent management', async () => {
    const f = await fixture();
    await writeFile(join(f.root, '.opensaysme-package'), 'another application\n');
    await expect(f.run(['uninstall'])).rejects.toMatchObject({ stderr: expect.stringContaining('Unrecognized package') });
    await writeFile(join(f.root, '.opensaysme-package'), 'dev.opensaysme.cli\n');
    await mkdir(join(f.root, '.operation'));
    await writeFile(join(f.root, '.operation', 'pid'), 'existing operation');
    await expect(f.run(['uninstall'])).rejects.toMatchObject({ stderr: expect.stringContaining('Another package operation') });
    expect(await readFile(join(f.root, '.operation', 'pid'), 'utf8')).toBe('existing operation');
  });

  it('refuses removal while another session runs its helper, or process inspection fails', async () => {
    const f = await fixture();
    const helper = join(f.root, 'OpenSaysMe.bundle/Contents/Resources/native/macos/bin/opensaysme-desktop');
    await expect(f.run(['uninstall'], { TEST_HELPER: helper })).rejects.toMatchObject({ stderr: expect.stringContaining('all logged-in sessions') });
    await expect(f.run(['uninstall'], { TEST_PS_FAIL: '1' })).rejects.toMatchObject({ stderr: expect.stringContaining('Cannot check') });
    expect((await lstat(f.root)).isDirectory()).toBe(true);
  });

  it('rejects symlinked package input and command directories without removing their targets', async () => {
    const f = await fixture();
    const linked = join(f.directory, 'linked.pkg');
    await symlink(f.packagePath, linked);
    await expect(f.run(['update', linked, f.checksum])).rejects.toMatchObject({ stderr: expect.stringContaining('missing or unsafe') });
    await rm(f.commands, { recursive: true });
    await symlink(f.directory, f.commands);
    await expect(f.run(['uninstall'])).rejects.toMatchObject({ stderr: expect.stringContaining('symbolic link') });
    expect(await readFile(f.packagePath)).toEqual(f.bytes);
  });
});
