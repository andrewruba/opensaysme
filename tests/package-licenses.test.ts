import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('ships the original readable notices and preserves the smaller license files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opensaysme-package-licenses-'));
  try {
    const modulePath = pathToFileURL(join(process.cwd(), 'scripts/package-licenses.mjs')).href;
    const { copyPackageLicenses } = await import(modulePath);
    const destination = join(root, 'licenses');
    await copyPackageLicenses(destination);

    // Hashes of the original, uncompressed notices shipped with v0.6.0.
    const originals = {
      'native-source-notices.txt': 'ed64849a0bc0bd5eff5c8bed07d5ec3b7db461429a5959e36b8f253a59b9b0f0',
      'Rust-COPYRIGHT-library.html': '1232786a7fe0072ed4b970520ff4269c9e686c406311af8350b555ea4e8c040e',
    };
    for (const [name, expected] of Object.entries(originals)) {
      const bytes = await readFile(join(destination, name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    }
    const source = join(process.cwd(), 'packaging/macos/licenses');
    const plainFiles = (await readdir(source)).filter((name) => !name.endsWith('.gz'));
    expect((await readdir(destination)).sort()).toEqual([...plainFiles, ...Object.keys(originals)].sort());
    for (const name of plainFiles) {
      expect(await readFile(join(destination, name))).toEqual(await readFile(join(source, name)));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
