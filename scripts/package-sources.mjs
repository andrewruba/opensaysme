import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { run } from './package-process.mjs';
import { copyPackageLicenses } from './package-licenses.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const packaging = join(repository, 'packaging/macos');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function build() {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/package-sources.mjs');
  const manifest = JSON.parse(await readFile(join(packaging, 'native-sources.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(repository, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/sharp'].version, manifest.sharp);
  for (const architecture of ['arm64', 'x64']) {
    assert.equal(lock.packages[`node_modules/@img/sharp-libvips-darwin-${architecture}`].version, manifest.libvipsBundle);
  }
  assert.equal(manifest.version, 1);
  assert.equal(manifest.inputs.length, 392, 'Review the complete source closure when updating dependencies.');
  const names = new Set();
  for (const input of manifest.inputs) {
    assert.match(input.path, /^(archives|patches|crates)\/[A-Za-z0-9_.+-]+$/);
    assert.ok(!names.has(input.path)); names.add(input.path);
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(input.size) && input.size > 0 && input.size < 256 * 1024 * 1024);
    const url = new URL(input.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(!url.username && !url.password);
  }

  const output = join(repository, 'release');
  const cache = join(output, '.source-cache');
  await mkdir(cache, { recursive: true });
  let next = 0, downloaded = 0;
  const fetchInput = async (input) => {
    const destination = join(cache, input.path);
    try {
      const bytes = await readFile(destination);
      if (bytes.length === input.size && digest(bytes) === input.sha256) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(destination), { recursive: true });
    // curl is used only as a bounded HTTPS downloader; downloaded code is never executed.
    const partial = `${destination}.${randomUUID()}.partial`;
    try {
      await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
        '--proto-redir', '=https', '--retry', '2', '--max-time', '180', '--max-filesize', String(input.size),
        input.url, '--output', partial], { timeout: 200_000 });
      const bytes = await readFile(partial);
      assert.equal(bytes.length, input.size, `Unexpected source size: ${input.path}`);
      assert.equal(digest(bytes), input.sha256, `Source checksum mismatch: ${input.path}`);
      await rename(partial, destination);
      downloaded++;
    } finally { await rm(partial, { force: true }); }
  };
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < manifest.inputs.length) await fetchInput(manifest.inputs[next++]);
  }));
  const temporary = await mkdtemp(join(tmpdir(), 'opensaysme-sources-'));
  try {
    const bundle = join(temporary, 'OpenSaysMe-native-sources');
    await mkdir(bundle);
    for (const input of manifest.inputs) {
      await mkdir(dirname(join(bundle, input.path)), { recursive: true });
      await copyFile(join(cache, input.path), join(bundle, input.path));
    }
    await copyFile(join(packaging, 'native-sources.json'), join(bundle, 'manifest.json'));
    await copyFile(join(packaging, 'source-companion/README.md'), join(bundle, 'README.md'));
    await copyFile(join(packaging, 'source-companion/prepare.py'), join(bundle, 'prepare.py'));
    await copyPackageLicenses(join(bundle, 'licenses'));
    await writeFile(join(bundle, 'SHA256SUMS'), manifest.inputs.map((input) => `${input.sha256}  ${input.path}\n`).join(''));
    const filename = 'OpenSaysMe-native-sources.tar.gz';
    const built = join(temporary, filename);
    await run('/usr/bin/tar', ['-czf', built, '-C', temporary, 'OpenSaysMe-native-sources'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const listing = await run('/usr/bin/tar', ['-tzf', built], { capture: true });
    assert.ok(!listing.split('\n').some((name) => name.split('/').some((part) => part.startsWith('._'))),
      'Do not include macOS metadata in the source companion.');
    for (const input of manifest.inputs) assert.ok(listing.includes(`OpenSaysMe-native-sources/${input.path}\n`));
    const bytes = await readFile(built);
    assert.ok(bytes.length < 512 * 1024 * 1024, 'Release assets must stay within the updater metadata size limit.');
    await copyFile(built, join(output, filename));
    await writeFile(join(output, `${filename}.sha256`), `${digest(bytes)}  ${filename}\n`);
    process.stdout.write(`Verified ${manifest.inputs.length} source inputs (${downloaded} downloaded).\nSource companion: ${join(output, filename)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try { await build(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode ||= 1;
}
