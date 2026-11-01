import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './package-process.mjs';

export async function smokePackage(packageFile) {
  assert.equal(process.platform, 'darwin', 'Package extraction requires macOS.');
  const temporary = await mkdtemp(join(tmpdir(), 'opensaysme-package-smoke-'));
  try {
    const expanded = join(temporary, 'expanded');
    await run('/usr/sbin/pkgutil', ['--expand-full', resolve(packageFile), expanded]);
    const payload = join(expanded, 'OpenSaysMe.pkg/Payload');
    const root = join(payload, 'Library/Application Support/OpenSaysMe');
    const app = join(root, 'OpenSaysMe.bundle/Contents/Resources');
    const metadata = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    const node = join(app, 'runtime/bin/node');
    const launcher = join(app, 'bin/opensaysme.mjs');
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: temporary, TMPDIR: temporary,
      OPENSAYSME_CONFIG_DIR: join(temporary, 'config') };
    const options = { cwd: temporary, env, capture: true, timeout: 30_000 };
    assert.equal((await run(node, [launcher, '--version'], options)).trim(), metadata.version);
    const help = await run(node, [launcher, '--help'], options);
    assert.match(help, /update/);
    assert.ok(!help.includes('npm run install:cli'), 'Packaged setup must not require a source checkout.');
    const doctor = JSON.parse(await run(node, [launcher, 'doctor', '--json'], options));
    assert.equal(doctor.configuration.configured, false);
    assert.equal(doctor.desktop.platform, 'darwin');
    assert.notEqual(doctor.desktop.session, 'not assessed', 'The CLI must resolve and execute its packaged helper.');
    const probe = JSON.parse(await run(join(app, 'native/macos/bin/opensaysme-desktop'), ['--probe'], options));
    assert.equal(probe.platform, 'darwin');
    // Exercise the actual native dependency with synthetic pixels only.
    const image = `import sharp from 'sharp';
const buffer = await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).resize(1,1).png().toBuffer();
if ((await sharp(buffer).metadata()).width !== 1) throw new Error('Image resize failed');`;
    await run(node, ['--input-type=module', '-e', image], { ...options, cwd: app });
    assert.deepEqual(JSON.parse(await readFile(join(app, 'installation.json'), 'utf8')),
      { version: 1, kind: 'macos-pkg', root: '/Library/Application Support/OpenSaysMe', architecture: process.arch });
    assert.equal(await readFile(join(root, '.opensaysme-package'), 'utf8'), 'dev.opensaysme.cli\n');
    for (const name of ['osm', 'opensaysme']) {
      assert.equal(await readlink(join(payload, 'usr/local/bin', name)), '/Library/Application Support/OpenSaysMe/bin/osm');
    }
    for (const path of ['runtime/LICENSE', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await access(join(app, path));
    await access(join(root, 'manage.sh'));
    const packageInfo = await readFile(join(expanded, 'OpenSaysMe.pkg/PackageInfo'), 'utf8');
    assert.match(packageInfo, /<upgrade-bundle>\s*<bundle id="dev\.opensaysme\.runtime"\/>\s*<\/upgrade-bundle>/,
      'Updates must replace the entire runtime bundle.');
    assert.match(packageInfo, /relocatable="false"/, 'The installation must stay at its protected path.');
    for (const path of ['node_modules/typescript', 'node_modules/vitest', '.env', '.opensaysme-debug']) {
      await assert.rejects(access(join(app, path)), { code: 'ENOENT' });
    }
    process.stdout.write(`Package smoke test passed (${metadata.version}, ${process.arch}).\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/smoke-package.mjs <installer.pkg>');
    await smokePackage(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode ||= 1;
  }
}
