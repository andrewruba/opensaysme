import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { administerPackage, readInstallation, type PackageInstallation } from './installation.js';
import { withInstallationMaintenance } from './installation-runtime.js';

const repository = 'andrewruba/opensaysme';
const releaseEndpoint = `https://api.github.com/repos/${repository}/releases/latest`;
const maximumPackageBytes = 512 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const assetSchema = z.object({ name: z.string().max(128), browser_download_url: z.string().url(), size: z.number().int().positive().max(maximumPackageBytes) });
const releaseSchema = z.object({
  tag_name: z.string().max(64), draft: z.literal(false), prerelease: z.literal(false), assets: z.array(assetSchema).max(128),
});
export interface UpdateRelease { version: string; filename: string; packageUrl: string; checksumUrl: string; size: number }

function versionParts(version: string): number[] {
  if (!versionPattern.test(version)) throw new Error('The release version is invalid.');
  return version.split('.').map(Number);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = versionParts(candidate), b = versionParts(current);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  }
  return false;
}

export function parseUpdateRelease(value: unknown, architecture: PackageInstallation['architecture']): UpdateRelease {
  const parsed = releaseSchema.safeParse(value);
  if (!parsed.success) throw new Error('GitHub returned invalid release information.');
  const release = parsed.data;
  if (!release.tag_name.startsWith('v')) throw new Error('The release tag is invalid.');
  const version = release.tag_name.slice(1);
  versionParts(version);
  const filename = `OpenSaysMe-${architecture}.pkg`;
  const expectedUrl = (name: string) => `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
  const asset = (name: string) => {
    const matches = release.assets.filter((item) => item.name === name);
    if (matches.length !== 1 || matches[0]!.browser_download_url !== expectedUrl(name)) {
      throw new Error('The latest release does not include a valid installer and checksum for this Mac yet.');
    }
    return matches[0]!;
  };
  const pkg = asset(filename), checksum = asset(`${filename}.sha256`);
  if (checksum.size > 4096) throw new Error('The release checksum is invalid.');
  return { version, filename, packageUrl: pkg.browser_download_url, checksumUrl: checksum.browser_download_url, size: pkg.size };
}

async function request(url: string, signal: AbortSignal, metadata = false): Promise<Response> {
  const initial = new URL(url);
  let current = initial;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const allowedHost = metadata ? current.hostname === 'api.github.com'
      : ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname);
    const allowedPath = current.hostname === initial.hostname
      ? current.pathname === initial.pathname && current.search === initial.search
      : current.pathname.startsWith('/github-production-release-asset/');
    if (current.protocol !== 'https:' || current.username || current.password || current.port || !allowedHost || !allowedPath) {
      throw new Error('GitHub redirected the download to an unsupported location.');
    }
    const response = await fetch(current, { signal, redirect: 'manual', headers: {
      'User-Agent': 'OpenSaysMe-updater', Accept: metadata ? 'application/vnd.github+json' : 'application/octet-stream',
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('GitHub returned an invalid download redirect.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && metadata) throw new Error('No published package release is available yet.');
      throw new Error(`The update download failed (HTTP ${response.status}). Try again later.`);
    }
    return response;
  }
  throw new Error('GitHub returned too many download redirects.');
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error('GitHub returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > maximum) throw new Error('The update response exceeded its size limit.');
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function downloadUpdate(release: UpdateRelease, directory: string, signal: AbortSignal): Promise<{ path: string; checksum: string }> {
  const checksumText = (await readBounded(await request(release.checksumUrl, signal), 4096)).toString('utf8');
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9.-]+)\n?$/.exec(checksumText);
  if (!match || match[2] !== release.filename) throw new Error('The release checksum file is invalid.');
  const response = await request(release.packageUrl, signal);
  if (!response.body) throw new Error('GitHub returned an empty installer.');
  const path = join(directory, release.filename);
  const file = await open(path, 'wx', 0o600);
  const reader = response.body.getReader();
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > release.size || bytes > maximumPackageBytes) throw new Error('The downloaded installer exceeded its expected size.');
      digest.update(item.value);
      await file.writeFile(item.value);
    }
    if (bytes !== release.size || digest.digest('hex') !== match[1]) throw new Error('The downloaded installer does not match its checksum. Nothing was installed.');
    return { path, checksum: match[1]! };
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
  }
}

async function installedVersion(appRoot: string): Promise<string> {
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')));
  versionParts(version);
  return version;
}

export async function update(signal?: AbortSignal): Promise<{ status: 'current' | 'updated'; version: string }> {
  signal?.throwIfAborted();
  const installation = await readInstallation();
  if (!installation) throw new Error('This is a source installation. Update your checkout and run npm run install:cli.');
  const current = await installedVersion(installation.appRoot);
  const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(300_000)]);
  let metadata: unknown;
  try {
    metadata = JSON.parse((await readBounded(await request(releaseEndpoint, downloadSignal, true), 1024 * 1024)).toString('utf8'));
  } catch (error) {
    signal?.throwIfAborted();
    if (downloadSignal.aborted) throw new Error('The update check timed out. Try again later.', { cause: error });
    throw error;
  }
  const release = parseUpdateRelease(metadata, installation.architecture);
  if (!isNewerVersion(release.version, current)) return { status: 'current', version: current };
  const temporary = await mkdtemp(join(tmpdir(), 'opensaysme-update-'));
  let installing = false;
  try {
    process.stderr.write(`Downloading OpenSaysMe ${release.version}…\n`);
    const downloaded = await downloadUpdate(release, temporary, downloadSignal);
    signal?.throwIfAborted();
    installing = true;
    return await withInstallationMaintenance(installation.appRoot, signal, async () => {
      process.stderr.write('Installing the update. macOS may ask for administrator authorization.\n');
      await administerPackage(installation, 'update', [downloaded.path, downloaded.checksum], signal);
      const actual = await installedVersion(installation.appRoot);
      if (actual !== release.version) throw new Error('The installer did not apply the expected version. Check osm --version before retrying.');
      return { status: 'updated', version: actual };
    });
  } catch (error) {
    if (!installing && downloadSignal.aborted && !signal?.aborted) {
      throw new Error('The update download timed out. Try again later.', { cause: error });
    }
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
