import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const licenses = fileURLToPath(new URL('../packaging/macos/licenses', import.meta.url));

export async function copyPackageLicenses(destination) {
  await cp(licenses, destination, { recursive: true, filter: (path) => !path.endsWith('.gz') });
  // These notices stay compressed in Git, but distributions retain their
  // original readable filenames and contents. Missing/corrupt inputs fail the build.
  for (const name of ['native-source-notices.txt', 'Rust-COPYRIGHT-library.html']) {
    const compressed = await readFile(join(licenses, `${name}.gz`));
    await writeFile(join(destination, name), gunzipSync(compressed), { flag: 'wx' });
  }
}
