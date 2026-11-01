import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { run } from './package-process.mjs';
import { copyPackageLicenses } from './package-licenses.mjs';
import { smokePackage } from './smoke-package.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const identifier = 'dev.opensaysme.cli';
const installRoot = '/Library/Application Support/OpenSaysMe';
const bundleRelative = 'Library/Application Support/OpenSaysMe/OpenSaysMe.bundle';
const resourceRelative = 'OpenSaysMe.bundle/Contents/Resources';

async function build() {
  assert.equal(process.argv.length, 2, 'Usage: npm run package:macos');
  assert.equal(process.platform, 'darwin', 'Build the installer on macOS with Xcode Command Line Tools.');
  assert.ok(['arm64', 'x64'].includes(process.arch), 'Only Apple Silicon and Intel Macs are supported.');
  const requiredNode = (await readFile(join(repository, '.nvmrc'), 'utf8')).trim();
  assert.equal(process.version, `v${requiredNode}`, 'Use the Node version in .nvmrc (nvm install && nvm use).');
  const metadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/, 'Installer versions must be major.minor.patch.');
  const node = await realpath(process.execPath);
  const nodeLicense = join(dirname(dirname(node)), 'LICENSE');
  assert.ok((await readFile(nodeLicense, 'utf8')).includes('Node.js'),
    'Use an official Node distribution with its LICENSE file (nvm or actions/setup-node).');
  const libraries = (await run('/usr/bin/otool', ['-L', node], { capture: true })).split('\n').slice(1).filter((line) => line.trim());
  assert.ok(libraries.length > 0 && libraries.every((line) => /^\s+(\/usr\/lib\/|\/System\/Library\/)/.test(line)),
    'The bundled Node must depend only on macOS system libraries. Use an official Node distribution.');

  await run(process.execPath, ['scripts/check-version.mjs'], { cwd: repository });
  await run('npm', ['run', 'build'], { cwd: repository });
  await run('npm', ['run', 'build:native'], { cwd: repository });
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const helper = join(repository, 'native/macos/bin/opensaysme-desktop');
  assert.equal((await run('/usr/bin/lipo', ['-archs', helper], { capture: true })).trim(), architecture,
    'The native helper must match the Node architecture; run Node natively on the build Mac.');

  const temporary = await mkdtemp(join(tmpdir(), 'opensaysme-package-'));
  try {
    const payload = join(temporary, 'payload');
    const root = join(payload, installRoot.slice(1));
    const app = join(root, resourceRelative);
    const scripts = join(temporary, 'scripts');
    const resources = join(temporary, 'resources');
    await Promise.all([
      mkdir(join(app, 'runtime/bin'), { recursive: true }), mkdir(join(app, 'bin'), { recursive: true }),
      mkdir(join(root, 'bin'), { recursive: true }), mkdir(scripts), mkdir(resources),
    ]);
    // Explicitly copy runtime inputs only: no source checkout, developer packages,
    // local configuration, secrets or captured desktop data belong in a release.
    for (const name of ['package.json', 'package-lock.json']) await copyFile(join(repository, name), join(app, name));
    await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: app });
    await rm(join(app, 'package-lock.json'));
    await Promise.all([
      cp(join(repository, 'dist'), join(app, 'dist'), { recursive: true, filter: (path) => !path.endsWith('.map') }),
      copyFile(join(repository, 'bin/opensaysme.mjs'), join(app, 'bin/opensaysme.mjs')),
      copyFile(node, join(app, 'runtime/bin/node')), copyFile(nodeLicense, join(app, 'runtime/LICENSE')),
      copyFile(join(repository, 'LICENSE'), join(app, 'LICENSE')),
      copyPackageLicenses(join(app, 'licenses')),
      copyFile(join(repository, 'packaging/macos/THIRD_PARTY_NOTICES.md'), join(app, 'THIRD_PARTY_NOTICES.md')),
      copyFile(join(repository, 'packaging/macos/preinstall'), join(scripts, 'preinstall')),
      copyFile(join(repository, 'packaging/macos/postinstall'), join(scripts, 'postinstall')),
      copyFile(join(repository, 'packaging/macos/manage.sh'), join(root, 'manage.sh')),
    ]);
    const notices = await readFile(join(app, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const sharp = JSON.parse(await readFile(join(app, 'node_modules/sharp/package.json'), 'utf8'));
    const libvipsDirectory = join(app, `node_modules/@img/sharp-libvips-darwin-${process.arch}`);
    const libvips = JSON.parse(await readFile(join(libvipsDirectory, 'package.json'), 'utf8'));
    const libraries = JSON.parse(await readFile(join(libvipsDirectory, 'versions.json'), 'utf8'));
    for (const reference of [`Node.js ${requiredNode}`, `Sharp ${sharp.version}`, `libvips ${libraries.vips}`, `version ${libvips.version}`]) {
      assert.ok(notices.includes(reference), `Update bundled notices and source references for ${reference} before packaging.`);
    }
    const upstreamNotices = join(app, `licenses/sharp-libvips-${libvips.version}-NOTICES.md`);
    await readFile(upstreamNotices);
    await copyFile(join(libvipsDirectory, 'README.md'), upstreamNotices);
    await mkdir(join(app, 'native/macos/bin'), { recursive: true });
    await copyFile(helper, join(app, 'native/macos/bin/opensaysme-desktop'));
    await writeFile(join(app, 'installation.json'), `${JSON.stringify({ version: 1, kind: 'macos-pkg', root: installRoot, architecture: process.arch })}\n`);
    await writeFile(join(root, '.opensaysme-package'), `${identifier}\n`);
    await writeFile(join(root, 'bin/osm'), `#!/bin/sh\nexec '${installRoot}/${resourceRelative}/runtime/bin/node' '${installRoot}/${resourceRelative}/bin/opensaysme.mjs' "$@"\n`);
    for (const path of ['runtime/bin/node', 'native/macos/bin/opensaysme-desktop']) await chmod(join(app, path), 0o755);
    for (const path of ['bin/osm', 'manage.sh']) await chmod(join(root, path), 0o755);
    await chmod(join(scripts, 'preinstall'), 0o755);
    await chmod(join(scripts, 'postinstall'), 0o755);
    await mkdir(join(payload, 'usr/local/bin'), { recursive: true });
    for (const name of ['osm', 'opensaysme']) await symlink(`${installRoot}/bin/osm`, join(payload, 'usr/local/bin', name));
    await writeFile(join(root, 'OpenSaysMe.bundle/Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.opensaysme.runtime</string>
  <key>CFBundleName</key><string>OpenSaysMe</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleVersion</key><string>${metadata.version}</string>
  <key>CFBundleShortVersionString</key><string>${metadata.version}</string>
</dict></plist>
`);
    const components = join(temporary, 'components.plist');
    await writeFile(components, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><dict>
  <key>RootRelativeBundlePath</key><string>${bundleRelative}</string>
  <key>BundleIsRelocatable</key><false/>
  <key>BundleIsVersionChecked</key><true/>
  <key>BundleHasStrictIdentifier</key><true/>
  <key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>
`);
    await writeFile(join(resources, 'welcome.txt'), `OpenSaysMe ${metadata.version}\n\nAfter installation, open Terminal and run osm.\n\nNode and the Mac helper are included. macOS 14 or newer is required.\n\nManage the installation with osm update and osm uninstall.\n\nThis preview is unsigned and not notarized.\n`);
    await copyFile(join(repository, 'LICENSE'), join(resources, 'license.txt'));
    const component = join(temporary, 'OpenSaysMe.pkg');
    await run('/usr/bin/pkgbuild', [
      '--root', payload, '--component-plist', components, '--scripts', scripts, '--identifier', identifier,
      '--version', metadata.version, '--install-location', '/', '--ownership', 'recommended', component,
    ]);
    const distribution = join(temporary, 'Distribution.xml');
    await writeFile(distribution, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>OpenSaysMe ${metadata.version}</title>
  <welcome file="welcome.txt" mime-type="text/plain"/>
  <license file="license.txt" mime-type="text/plain"/>
  <options customize="never" require-scripts="false" hostArchitectures="${architecture}"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="14.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" visible="false"><pkg-ref id="${identifier}"/></choice>
  <pkg-ref id="${identifier}" version="${metadata.version}" onConclusion="none">OpenSaysMe.pkg</pkg-ref>
</installer-gui-script>
`);
    const output = join(repository, 'release');
    await mkdir(output, { recursive: true });
    const filename = `OpenSaysMe-${process.arch}.pkg`;
    const built = join(temporary, filename);
    await run('/usr/bin/productbuild', ['--distribution', distribution, '--package-path', temporary, '--resources', resources, built]);
    await smokePackage(built);
    const digest = createHash('sha256').update(await readFile(built)).digest('hex');
    await copyFile(built, join(output, filename));
    await writeFile(join(output, `${filename}.sha256`), `${digest}  ${filename}\n`);
    process.stdout.write(`Unsigned installer: ${join(output, filename)}\nSHA-256: ${digest}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try { await build(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode ||= 1;
}
