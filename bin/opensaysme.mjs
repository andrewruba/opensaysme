#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const entry = new URL('../dist/cli.js', import.meta.url);
try {
  await access(entry);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  process.stderr.write(`OpenSaysMe's CLI build is missing. Run npm run build in ${JSON.stringify(fileURLToPath(new URL('..', import.meta.url)))}.\n`);
  process.exit(1);
}

// Import in this process so arguments, terminal input and cancellation stay intact.
await import(entry.href);
