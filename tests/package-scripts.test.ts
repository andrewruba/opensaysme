import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'opensaysme-installer-fixture-'));
  roots.push(temporary);
  const root = join(temporary, 'install');
  const commands = join(temporary, 'commands');
  const operation = join(root, '.operation');
  await mkdir(root); await mkdir(commands);
  await writeFile(join(root, '.opensaysme-package'), 'dev.opensaysme.cli\n');
  await writeFile(join(temporary, 'processes'), '');
  // These scripts run without elevation: substitute only the owned fixture paths,
  // simulated root ownership and process evidence. Real shell/mode checks remain.
  const stat = join(temporary, 'stat');
  await writeFile(stat, '#!/bin/sh\nif [ "$2" = %u ]; then echo 0; else exec /usr/bin/stat "$@"; fi\n');
  const ps = join(temporary, 'ps');
  await writeFile(ps, `#!/bin/sh
if [ "$1" = -axo ]; then
  [ ! -f ${quote(join(temporary, 'ps-failure'))} ] || exit 1
  /bin/cat ${quote(join(temporary, 'processes'))}
else
  printf 'fixture-start-%s\\n' "$2"
fi
`);
  await chmod(stat, 0o755); await chmod(ps, 0o755);
  for (const name of ['preinstall', 'postinstall']) {
    const source = (await readFile(join(process.cwd(), 'packaging/macos', name), 'utf8'))
      .replaceAll('/Library/Application Support/OpenSaysMe', root)
      .replace('command_directory=/usr/local/bin', `command_directory=${quote(commands)}`)
      .replaceAll('/usr/bin/stat', quote(stat))
      .replaceAll('/bin/ps', quote(ps));
    await writeFile(join(temporary, name), source);
  }
  const run = (name: string) => execute('/bin/sh', [join(temporary, name)], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  const marker = async (action = 'update') => {
    await mkdir(operation, { mode: 0o700 });
    await writeFile(join(operation, 'pid'), `${process.pid}\n`, { mode: 0o600 });
    await writeFile(join(operation, 'started'), `fixture-start-${process.pid}\n`, { mode: 0o600 });
    await writeFile(join(operation, 'action'), `${action}\n`, { mode: 0o600 });
  };
  return { root, temporary, operation, run, marker };
}

describe.skipIf(process.platform !== 'darwin')('package Installer handoff', () => {
  it('retains a direct update marker through payload replacement, then clears its dead process', async () => {
    const { operation, run } = await fixture();
    await run('preinstall');
    expect(Number(await readFile(join(operation, 'pid'), 'utf8'))).toBeGreaterThan(1);
    await run('postinstall');
    await expect(access(operation)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only its own marker when a running helper rejects preflight', async () => {
    const { root, temporary, operation, run, marker } = await fixture();
    await writeFile(join(temporary, 'processes'), `${root}/OpenSaysMe.bundle/Contents/Resources/native/macos/bin/opensaysme-desktop\n`);
    await expect(run('preinstall')).rejects.toThrow('Close OpenSaysMe');
    await expect(access(operation)).rejects.toMatchObject({ code: 'ENOENT' });
    await marker();
    await expect(run('preinstall')).rejects.toThrow('Close OpenSaysMe');
    expect((await readFile(join(operation, 'pid'), 'utf8')).trim()).toBe(String(process.pid));
  });

  it('preserves an active updater marker and recovers a reused PID after reinstall', async () => {
    const { operation, run, marker } = await fixture();
    await marker();
    await run('preinstall'); await run('postinstall');
    expect((await readFile(join(operation, 'pid'), 'utf8')).trim()).toBe(String(process.pid));
    await writeFile(join(operation, 'started'), 'previous process with the same PID\n');
    await run('postinstall');
    await expect(access(operation)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed and releases its marker if the process list is unavailable', async () => {
    const { temporary, operation, run } = await fixture();
    await writeFile(join(temporary, 'ps-failure'), '');
    await expect(run('preinstall')).rejects.toThrow('Cannot check whether OpenSaysMe is running');
    await expect(access(operation)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a live uninstall before payload replacement and preserves its marker', async () => {
    const { operation, run, marker } = await fixture();
    await marker('uninstall');
    await expect(run('preinstall')).rejects.toThrow('Another package operation is active');
    expect((await readFile(join(operation, 'action'), 'utf8')).trim()).toBe('uninstall');
    await writeFile(join(operation, 'started'), 'stale uninstall identity\n');
    await run('preinstall'); await run('postinstall');
    await expect(access(operation)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
