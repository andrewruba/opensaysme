import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

if (process.platform === 'darwin') {
  const script = fileURLToPath(new URL('../native/macos/build.sh', import.meta.url));
  const result = spawnSync('/bin/sh', [script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  process.stderr.write('OpenSaysMe currently supports macOS 14+ only. Build on macOS with Xcode Command Line Tools.\n');
  process.exitCode = 1;
}
