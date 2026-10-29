#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { configPath, providerStatus, readConfig } from './config.js';
import { desktopAdapter } from './desktop/index.js';
import { cancelDesktopCommands } from './desktop/process.js';
import { capabilityNames, type DesktopReport } from './desktop/types.js';
import { setup } from './setup.js';
import { runVoice } from './voice.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const stop = new AbortController();
const stopAll = () => { stop.abort(); cancelDesktopCommands(); };
process.once('SIGINT', stopAll);
process.once('SIGTERM', stopAll);

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const safeText = (value: string) => JSON.stringify(value).slice(1, -1);
function seconds(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 30) {
    throw new InvalidArgumentError('Duration must be a whole number from 1 to 30 seconds.');
  }
  return Number(value);
}
function printReport(report: DesktopReport): void {
  console.log(`Desktop: ${safeText(report.platform)} / ${safeText(report.session)}`);
  for (const name of capabilityNames) {
    const value = report.capabilities[name];
    console.log(`  ${name}: ${value.status} — ${safeText(value.detail)}`);
  }
  for (const note of report.notes) console.log(`  ${safeText(note)}`);
}

const program = new Command()
  .name('opensaysme')
  .description('Tap-to-talk with visual context and attention history')
  .version(version)
  .showHelpAfterError()
  .action(async () => {
    const config = await readConfig();
    if (!config) throw new Error('Run opensaysme setup first. Desktop probes work without provider configuration.');
    process.stderr.write('OpenSaysMe voice mode. Ctrl+Shift+Space starts/stops; Escape cancels; Ctrl+C quits.\n');
    process.stderr.write('Activated audio streams to OpenAI. Screen/context and cursor history are captured while recording.\n');
    process.stderr.write('After stopping, selected frames and context go to your reasoning provider for a response. No actions are executed.\n');
    await runVoice(config, stop.signal, (event) => {
      if (event.type === 'state') {
        if (event.state === 'listening' && process.stderr.isTTY) process.stderr.write('\x07');
        process.stderr.write(`${event.state}\n`);
      } else if (event.type === 'partial') {
        process.stderr.write(`Transcript: ${JSON.stringify(event.text)}\n`);
      } else if (event.type === 'transcript') {
        process.stderr.write(`Final transcript: ${JSON.stringify(event.text)}\n`);
      } else if (event.type === 'result') {
        process.stderr.write(`Response: ${safeText(event.response)}\n`);
        json(event);
      }
      else if (event.type === 'cancelled') process.stderr.write('Cancelled.\n');
      else process.stderr.write(`Error: ${safeText(event.message)}\n`);
    });
    console.log('Stopped.');
  });

program.command('setup').description('Configure speech, visual sharing, and reasoning without storing keys')
  .option('--replace', 'Replace existing configuration after interactive setup')
  .action((options: { replace?: boolean }) => setup(stop.signal, Boolean(options.replace)));
program.command('doctor')
  .description('Read-only desktop and configuration checks; does not record or request permissions')
  .option('--json', 'Print a machine-readable report')
  .action(async (options: { json?: boolean }) => {
    const desktop = await (await desktopAdapter()).probe();
    if (stop.signal.aborted) { process.exitCode = 130; return; }
    let configuration: Record<string, unknown>;
    try {
      const config = await readConfig();
      configuration = { path: configPath(), configured: config !== null,
        providers: config ? providerStatus(config) : null,
        note: 'Key presence only; no authentication or model request is performed.' };
    } catch (error) {
      configuration = { path: configPath(), configured: false,
        error: error instanceof Error ? error.message : 'Could not read configuration.' };
    }
    if (options.json) json({ desktop, configuration });
    else {
      printReport(desktop);
      console.log(`Configuration: ${safeText(String(configuration.path))}`);
      if (!configuration.configured) console.log('  Not configured or invalid. Run opensaysme setup or inspect the configuration.');
      if (configuration.error) console.log(`  ${safeText(String(configuration.error))}`);
      if (configuration.providers) json(configuration.providers);
      console.log('  Provider credentials have not been authenticated.');
    }
  });

const desktop = program.command('desktop').description('Explicit, local desktop-access experiments');
desktop.command('inspect')
  .description('Print active-window metadata as JSON (can contain private titles)')
  .option('--selection', 'Also read selected text; printed locally and never uploaded')
  .option('--delay <seconds>', 'Wait so you can focus the target application', seconds)
  .action(async (options: { selection?: boolean; delay?: number }) => {
    if (options.delay) await delay(options.delay);
    if (stop.signal.aborted) { process.exitCode = 130; return; }
    json(await (await desktopAdapter()).inspect(Boolean(options.selection)));
  });
desktop.command('focus <target-id>')
  .description('Focus an exact window ID returned by inspect; never types or submits input')
  .action(async (id: string) => {
    await (await desktopAdapter()).focus(id);
    console.log('Target focused.');
  });
for (const kind of ['hotkey', 'microphone'] as const) {
  desktop.command(`test-${kind}`)
    .description(kind === 'hotkey' ? 'Explicitly test global Ctrl+Shift+Space' : 'Explicitly capture and discard microphone audio; output only metrics')
    .option('--seconds <seconds>', 'Bounded test duration (1–30)', seconds, kind === 'hotkey' ? 10 : 3)
    .action(async (options: { seconds: number }) => {
      process.stderr.write(kind === 'hotkey'
        ? `Press Ctrl+Shift+Space within ${options.seconds} seconds.\n`
        : `Testing microphone for ${options.seconds} seconds; audio is discarded locally.\n`);
      const adapter = await desktopAdapter();
      const result = await (kind === 'hotkey' ? adapter.testHotkey(options.seconds) : adapter.testMicrophone(options.seconds));
      if (stop.signal.aborted) { process.exitCode = 130; return; }
      json(result);
      if (result.status !== 'passed') process.exitCode = result.status === 'unavailable' ? 2 : 1;
    });
}

async function delay(duration: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, duration * 1000);
    function done() {
      clearTimeout(timer);
      stop.signal.removeEventListener('abort', done);
      resolve();
    }
    if (stop.signal.aborted) done();
    else stop.signal.addEventListener('abort', done, { once: true });
  });
}

program.parseAsync().catch((error: unknown) => {
  if (stop.signal.aborted) { process.exitCode = 130; return; }
  process.stderr.write(`Error: ${safeText(error instanceof Error ? error.message : 'Unexpected failure.')}\n`);
  process.exitCode = 1;
});
