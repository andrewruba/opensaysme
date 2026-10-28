import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

if (process.platform === 'darwin') {
  const script = fileURLToPath(new URL('../native/macos/build.sh', import.meta.url));
  const result = spawnSync('/bin/sh', [script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  process.stdout.write('No native build required on this platform. Run doctor for runtime prerequisites.\n');
}
