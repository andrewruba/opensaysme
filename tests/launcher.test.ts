import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];
const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>;
};
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opensaysme-launcher-')));
  directories.push(root);
  const project = join(root, 'source checkout');
  const commandDirectory = join(root, 'bin');
  const cwd = join(root, 'other directory');
  await Promise.all([mkdir(join(project, 'dist'), { recursive: true }), mkdir(commandDirectory), mkdir(cwd)]);
  await writeFile(join(project, 'package.json'), '{"type":"module"}\n');
  for (const target of new Set(Object.values(packageMetadata.bin))) {
    const destination = join(project, target);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL('../bin/opensaysme.mjs', import.meta.url), destination);
  }
  for (const name of ['opensaysme', 'osm']) {
    expect(packageMetadata.bin[name], `${name} must be registered as an npm command`).toBeDefined();
    await symlink(join(project, packageMetadata.bin[name]!), join(commandDirectory, name));
  }
  return { project, cwd, command: (name: string) => join(commandDirectory, name) };
}

it('both npm command names resolve the checkout from another directory and preserve arguments and exit status', async () => {
  const f = await fixture();
  await writeFile(join(f.project, 'dist/cli.js'), `
process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
process.exitCode = 7;
`, { mode: 0o644 });
  for (const name of ['opensaysme', 'osm']) {
    await expect(execute(f.command(name), ['hotkey', '--show'], { cwd: f.cwd })).rejects.toMatchObject({
      code: 7, stdout: JSON.stringify({ cwd: f.cwd, args: ['hotkey', '--show'] }), stderr: '',
    });
  }
});

it('linked commands survive a clean rebuild that recreates dist without executable bits', async () => {
  const f = await fixture();
  for (const version of ['first build', 'rebuilt']) {
    await rm(join(f.project, 'dist'), { recursive: true });
    await mkdir(join(f.project, 'dist'));
    await writeFile(join(f.project, 'dist/cli.js'), `process.stdout.write(${JSON.stringify(version)});`, { mode: 0o644 });
    for (const name of ['opensaysme', 'osm']) {
      expect((await execute(f.command(name), ['--version'], { cwd: f.cwd })).stdout).toBe(version);
    }
  }
});

it('explains a missing build without disguising a missing runtime dependency as a build problem', async () => {
  const f = await fixture();
  await expect(execute(f.command('osm'), ['--help'], { cwd: f.cwd })).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining('CLI build is missing. Run npm run build'),
  });
  await writeFile(join(f.project, 'dist/cli.js'), 'import "./missing-runtime-dependency.js";\n');
  try {
    await execute(f.command('osm'), ['--help'], { cwd: f.cwd });
    throw new Error('Expected runtime import failure.');
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining('ERR_MODULE_NOT_FOUND') });
    expect((error as { stderr: string }).stderr).not.toContain('CLI build is missing');
  }
});
