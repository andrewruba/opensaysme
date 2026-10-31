import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const readJson = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));
const [pkg, lock] = await Promise.all([readJson('package.json'), readJson('package-lock.json')]);

assert.equal(typeof pkg.version, 'string', 'package.json must declare a version.');
assert.ok(pkg.version.length > 0, 'package.json must declare a version.');
assert.equal(lock.version, pkg.version, 'package-lock.json version must match package.json. Use npm version to update both.');
assert.equal(lock.packages?.['']?.version, pkg.version, 'The root lockfile package version must match package.json.');

if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, 'Release tag must match the package version.');
}

process.stdout.write(`Version ${pkg.version} is consistent.\n`);
