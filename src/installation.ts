import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { configPath, configSchema } from './config.js';
import { workContextSchema } from './work-context.js';

export const packageRoot = '/Library/Application Support/OpenSaysMe';
export const packageAppRoot = `${packageRoot}/OpenSaysMe.bundle/Contents/Resources`;
export const applicationRoot = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
const installationSchema = z.object({
  version: z.literal(1), kind: z.literal('macos-pkg'), root: z.literal(packageRoot),
  architecture: z.enum(['arm64', 'x64']),
}).strict();
export type PackageInstallation = z.infer<typeof installationSchema> & { appRoot: string };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function readInstallation(root = applicationRoot): Promise<PackageInstallation | null> {
  const path = join(root, 'installation.json');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid installation metadata.');
    const installation = { ...installationSchema.parse(JSON.parse(await readFile(path, 'utf8'))), appRoot: await realpath(root) };
    if (installation.appRoot === packageAppRoot) {
      try {
        await lstat(join(packageRoot, '.operation'));
        throw new Error('OpenSaysMe installation is being changed. Wait for Installer to finish, or reinstall the package if it was interrupted.');
      } catch (error) { if (!absent(error)) throw error; }
    }
    return installation;
  } catch (error) {
    if (absent(error)) return null;
    if (error instanceof Error && error.message.startsWith('OpenSaysMe installation is being changed.')) throw error;
    throw new Error('OpenSaysMe installation metadata is invalid. Reinstall the Mac package.', { cause: error });
  }
}

/** Check every executable ancestor before asking macOS to run the helper as root. */
export async function validatePackageInstallation(installation: PackageInstallation): Promise<void> {
  if (process.platform !== 'darwin' || installation.appRoot !== packageAppRoot) {
    throw new Error('This command must run from the installed Mac package.');
  }
  const directories = ['/Library', '/Library/Application Support', packageRoot,
    `${packageRoot}/OpenSaysMe.bundle`, `${packageRoot}/OpenSaysMe.bundle/Contents`, packageAppRoot];
  for (const path of [...directories, `${packageRoot}/manage.sh`, `${packageRoot}/.opensaysme-package`]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0
      || (directories.includes(path) ? !info.isDirectory() : !info.isFile())) {
      throw new Error('The Mac installation has unsafe permissions. Reinstall the package.');
    }
  }
  if (await readFile(`${packageRoot}/.opensaysme-package`, 'utf8') !== 'dev.opensaysme.cli\n') {
    throw new Error('The Mac installation is unrecognized. Reinstall the package.');
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** The command is constructed only from a fixed helper, a typed action and validated arguments. */
export function administrationScript(action: 'uninstall' | 'update', args: string[] = []): string {
  if (action === 'uninstall' ? args.length !== 0 : args.length !== 2
    || !args[0]?.startsWith('/') || !/^[a-f0-9]{64}$/.test(args[1] ?? '')) {
    throw new Error('Invalid package operation.');
  }
  if (args.some((value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new Error('Invalid package operation.');
  }
  const command = [join(packageRoot, 'manage.sh'), action, ...args].map(shellQuote).join(' ');
  const literal = command.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `with timeout of 600 seconds\n  do shell script "${literal}" with administrator privileges\nend timeout`;
}

export async function administerPackage(installation: PackageInstallation, action: 'uninstall' | 'update',
  args: string[] = [], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await validatePackageInstallation(installation);
  signal?.throwIfAborted();
  const script = administrationScript(action, args);
  // Once authorization begins, let Installer finish. Killing osascript cannot
  // reliably cancel its elevated child and could leave a half-applied update.
  const onAbort = () => process.stderr.write('Waiting for macOS to finish the package operation before exiting.\n');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (process.getuid?.() === 0) {
      await execute(join(packageRoot, 'manage.sh'), [action, ...args], { timeout: 600_000, maxBuffer: 1024 * 1024 });
    } else {
      await execute('/usr/bin/osascript', ['-e', script], { timeout: 610_000, maxBuffer: 1024 * 1024 });
    }
  } catch (error) {
    const details = String((error as { stderr?: string }).stderr ?? '');
    if (details.includes('(-128)')) throw new Error('Administrator authorization was cancelled.', { cause: error });
    throw new Error('macOS could not finish the package operation. Check the installed version before retrying.', { cause: error });
  } finally { signal?.removeEventListener('abort', onAbort); }
}

/** Never recursively remove a user-selected configuration directory. */
export async function purgeUserSettings(signal?: AbortSignal): Promise<string[]> {
  const directory = dirname(configPath());
  const files = [
    { path: join(directory, 'config.json'), schema: configSchema },
    { path: join(directory, 'work-context.json'), schema: z.object({ version: z.literal(1), references: workContextSchema }).strict() },
  ];
  const inspected = [];
  for (const { path, schema } of files) {
    signal?.throwIfAborted();
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 128 * 1024 || !schema.safeParse(JSON.parse(await readFile(path, 'utf8'))).success) {
        throw new Error('Unrecognized settings file.');
      }
      inspected.push({ path, inode: info.ino, device: info.dev });
    } catch (error) {
      if (!absent(error)) throw new Error(`Cannot safely remove ${path}. Remove that file manually if it belongs to OpenSaysMe.`, { cause: error });
    }
  }
  const removed = [];
  for (const file of inspected) {
    signal?.throwIfAborted();
    const info = await lstat(file.path);
    if (!info.isFile() || info.ino !== file.inode || info.dev !== file.device) throw new Error('Settings changed during removal.');
    await unlink(file.path);
    removed.push(file.path);
  }
  return removed;
}
