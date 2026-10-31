import { lstat, readlink, realpath, unlink } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type InstalledLink = { path: string; target: string; inode: number; device: number };
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

async function matchingLink(path: string, expected: string): Promise<InstalledLink | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || await realpath(path) !== expected) return;
    return { path, target: await readlink(path), inode: info.ino, device: info.dev };
  } catch (error) {
    if (absent(error)) return;
    throw new Error(`Cannot inspect installation link ${path}. Check access to its directory.`, { cause: error });
  }
}

/** Remove this checkout's command/package links; never remove their targets. */
export async function uninstallLinks(repository: string, commandDirectories: string[], signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const root = await realpath(repository);
  const launcher = await realpath(join(root, 'bin', 'opensaysme.mjs'));
  const commands: InstalledLink[] = [], packages: InstalledLink[] = [];
  const seen = new Set<string>();
  for (const directory of commandDirectories) {
    signal?.throwIfAborted();
    let canonical: string;
    try { canonical = await realpath(directory); } catch (error) {
      if (absent(error)) continue;
      throw new Error(`Cannot inspect command directory ${directory}. Check directory access.`, { cause: error });
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    for (const name of ['osm', 'opensaysme']) {
      const link = await matchingLink(join(canonical, name), launcher);
      if (link) commands.push(link);
    }
    const packageLink = await matchingLink(resolve(canonical, '..', 'lib', 'node_modules', 'opensaysme'), root);
    if (packageLink) packages.push(packageLink);
  }

  // Inspect every alias before removing anything: npm's aliases traverse the package link.
  const removed: string[] = [];
  for (const link of [...commands, ...packages]) {
    signal?.throwIfAborted();
    try {
      const info = await lstat(link.path);
      if (!info.isSymbolicLink() || info.ino !== link.inode || info.dev !== link.device
        || await readlink(link.path) !== link.target) {
        throw new Error(`Installation link changed: ${link.path}. Run osm uninstall again.`);
      }
      signal?.throwIfAborted();
      await unlink(link.path);
      removed.push(link.path);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (absent(error)) continue;
      throw new Error(`Cannot remove installation link ${link.path}. Check write access to its directory and retry.`, { cause: error });
    }
  }
  return removed;
}

export async function uninstall(signal?: AbortSignal): Promise<string[]> {
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
  if (process.argv[1]) directories.unshift(dirname(resolve(process.argv[1])));
  return uninstallLinks(fileURLToPath(new URL('..', import.meta.url)), directories, signal);
}
