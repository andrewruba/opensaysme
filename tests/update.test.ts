import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadUpdate, isNewerVersion, parseUpdateRelease, update } from '../src/update.js';

const mocks = vi.hoisted(() => ({ installation: vi.fn(), administer: vi.fn(), maintenance: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/installation.js', () => ({ readInstallation: mocks.installation, administerPackage: mocks.administer }));
vi.mock('../src/installation-runtime.js', () => ({ withInstallationMaintenance: mocks.maintenance }));
const directories: string[] = [];
const bytes = Buffer.from('fixture installer');
const digest = createHash('sha256').update(bytes).digest('hex');
const filename = 'OpenSaysMe-arm64.pkg';
const base = 'https://github.com/andrewruba/opensaysme/releases/download/v0.6.0/';
const release = () => ({ tag_name: 'v0.6.0', draft: false, prerelease: false, assets: [
  { name: filename, browser_download_url: `${base}${filename}`, size: bytes.length },
  { name: `${filename}.sha256`, browser_download_url: `${base}${filename}.sha256`, size: 86 },
] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.maintenance.mockImplementation(async (_root, _signal, operation) => operation());
  mocks.fetch.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify(release()));
    if (url.endsWith('.sha256')) return new Response(`${digest}  ${filename}\n`);
    return new Response(bytes);
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(version = '0.5.0') {
  const root = await mkdtemp(join(tmpdir(), 'opensaysme-update-test-'));
  directories.push(root);
  const appRoot = join(root, 'app');
  await mkdir(appRoot);
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ version }));
  mocks.installation.mockResolvedValue({ version: 1, kind: 'macos-pkg', root: '/fixture', architecture: 'arm64', appRoot });
  return { root, appRoot };
}

it('downloads a matching package, maintains the installation, verifies completion and removes the download', async () => {
  const f = await fixture();
  let download = '';
  mocks.administer.mockImplementation(async (_installation, action, args) => {
    expect(action).toBe('update');
    expect(args[1]).toBe(digest);
    download = args[0];
    expect(await readFile(download)).toEqual(bytes);
    await writeFile(join(f.appRoot, 'package.json'), '{"version":"0.6.0"}');
  });
  expect(await update()).toEqual({ status: 'updated', version: '0.6.0' });
  expect(mocks.maintenance).toHaveBeenCalledOnce();
  expect(mocks.maintenance.mock.calls[0]![0]).toBe(f.appRoot);
  expect(mocks.administer).toHaveBeenCalledOnce();
  await expect(access(download)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not reinstall or downgrade when already current', async () => {
  await fixture('0.7.0');
  expect(await update()).toEqual({ status: 'current', version: '0.7.0' });
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.administer).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});

it('rejects a checksum mismatch before stopping the app or asking for administrator access', async () => {
  await fixture();
  mocks.fetch.mockImplementation(async (input) => String(input).endsWith('/latest')
    ? new Response(JSON.stringify(release())) : String(input).endsWith('.sha256')
      ? new Response(`${'0'.repeat(64)}  ${filename}\n`) : new Response(bytes));
  await expect(update()).rejects.toThrow('does not match its checksum');
  expect(mocks.administer).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});

it('does not claim success when Installer returns without installing the requested version', async () => {
  await fixture();
  mocks.administer.mockResolvedValue(undefined);
  await expect(update()).rejects.toThrow('did not apply the expected version');
});

it('reports unavailable releases and source installations without mutating anything', async () => {
  mocks.installation.mockResolvedValue(null);
  await expect(update()).rejects.toThrow('source installation');
  expect(mocks.fetch).not.toHaveBeenCalled();
  await fixture();
  mocks.fetch.mockResolvedValue(new Response('', { status: 404 }));
  await expect(update()).rejects.toThrow('No published package release');
  expect(mocks.administer).not.toHaveBeenCalled();
});

it('rejects cancelled checks before performing network or system operations', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(update(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.installation).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('stops on an untrusted download redirect without fetching its destination', async () => {
  const f = await fixture();
  mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://untrusted.example/package' } }));
  await expect(downloadUpdate(parseUpdateRelease(release(), 'arm64'), f.root, new AbortController().signal))
    .rejects.toThrow('unsupported location');
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it('rejects same-host redirects to a different repository or unexpected asset path', async () => {
  const f = await fixture();
  mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: {
    location: 'https://github.com/other/project/releases/download/v0.6.0/OpenSaysMe-arm64.pkg',
  } }));
  await expect(downloadUpdate(parseUpdateRelease(release(), 'arm64'), f.root, new AbortController().signal))
    .rejects.toThrow('unsupported location');
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it('allows the GitHub release CDN and rejects oversized installer bodies', async () => {
  const f = await fixture();
  mocks.fetch.mockImplementation(async (input) => {
    if (String(input).endsWith('.sha256')) return new Response(`${digest}  ${filename}\n`);
    if (String(input).includes('github.com/')) return new Response(null, {
      status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?token=fixture' },
    });
    return new Response(Buffer.concat([bytes, bytes]));
  });
  await expect(downloadUpdate(parseUpdateRelease(release(), 'arm64'), f.root, new AbortController().signal))
    .rejects.toThrow('exceeded its expected size');
});

it('selects only the exact architecture, release path and one unambiguous checksum', () => {
  expect(parseUpdateRelease(release(), 'arm64').version).toBe('0.6.0');
  expect(() => parseUpdateRelease(release(), 'x64')).toThrow('valid installer');
  const duplicate = release(); duplicate.assets.push(duplicate.assets[0]!);
  expect(() => parseUpdateRelease(duplicate, 'arm64')).toThrow('valid installer');
  const wrong = release(); wrong.assets[0]!.browser_download_url = 'https://github.com/other/project/releases/download/v0.6.0/OpenSaysMe-arm64.pkg';
  expect(() => parseUpdateRelease(wrong, 'arm64')).toThrow('valid installer');
  expect(() => parseUpdateRelease({ ...release(), prerelease: true }, 'arm64')).toThrow('invalid release');
  expect(() => parseUpdateRelease({ ...release(), tag_name: 'v0.6.0-beta' }, 'arm64')).toThrow('version is invalid');
});

it('compares numeric versions and rejects malformed or oversized version components', () => {
  expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
  expect(isNewerVersion('0.6.0', '1.0.0')).toBe(false);
  expect(isNewerVersion('0.6.0', '0.6.0')).toBe(false);
  expect(() => isNewerVersion('00.6.0', '0.5.0')).toThrow('invalid');
  expect(() => isNewerVersion('999999999999999.0.0', '0.5.0')).toThrow('invalid');
});
