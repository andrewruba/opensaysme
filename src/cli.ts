#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { configPath, providerStatus, readConfig, writeConfig } from './config.js';
import { activationHotkeySchema, defaultActivationHotkey, hotkeyHelp } from './hotkey.js';
import { desktopAdapter } from './desktop/index.js';
import { cancelDesktopCommands } from './desktop/process.js';
import { capabilityNames, type DesktopReport } from './desktop/types.js';
import { setup } from './setup.js';
import { runVoice } from './voice.js';
import { createDesktopTools } from './tools/desktop.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const stop = new AbortController();
const stopAll = () => { stop.abort(); cancelDesktopCommands(); };
process.once('SIGINT', stopAll);
process.once('SIGTERM', stopAll);

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const safeText = (value: string) => JSON.stringify(value).slice(1, -1);
const quickStart = `Quick start from the repository (macOS 14+, Node.js 22.20+, Xcode Command Line Tools):
  npm ci
  npm run build:native
  npm run build
  node dist/cli.js setup
  export OPENAI_API_KEY='your-key'
  node dist/cli.js doctor
  node dist/cli.js

Setup saves key environment-variable names, never keys. Export the names you chose
in the same terminal used to launch voice mode; OPENAI_API_KEY is the default.
Allow Microphone, Accessibility and Screen Recording for your terminal/helper in
System Settings > Privacy & Security. Restart your terminal if grants do not apply.
Doctor checks access and key presence without recording or making a provider call.
`;
function shortcut(value: string): string {
  const parsed = activationHotkeySchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(hotkeyHelp);
  return parsed.data;
}
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
  .description('Tap-to-talk with desktop context')
  .version(version)
  .option('--hotkey <shortcut>', 'Override activation for this run only (saved shortcut stays unchanged)', shortcut)
  .option('--debug [directory]', 'Save local context, model inputs, responses, and diagnostics (default: .opensaysme-debug)', (value: string) => {
    if (!value.trim()) throw new InvalidArgumentError('Enter a nonempty debug directory.');
    return resolve(value);
  })
  .addHelpText('after', `\n${quickStart}
Activation shortcuts:
  node dist/cli.js hotkey "Cmd+Shift+Space"    Save a shortcut for future runs
  node dist/cli.js hotkey                      Show the saved shortcut
  node dist/cli.js --hotkey "Ctrl+Alt+Space"   Use a shortcut for this run only
  node dist/cli.js hotkey --help                Supported keys and modifiers

Using voice:
  Wait for ready, switch to your work, then tap ${defaultActivationHotkey} (default).
  Speak while showing the relevant content; tap again to finish. No need to hold it.
  Try: "Explain this error" or "Put this error into the agent's input; leave it unsent."
  Escape cancels pending work (in the CLI terminal when idle); Ctrl+C quits.
  Activated audio and screen/context go to your configured providers; charges apply.
`)
  .showHelpAfterError()
  .action(async (options: { debug?: true | string; hotkey?: string }) => {
    const savedConfig = await readConfig();
    if (!savedConfig) {
      process.stderr.write(`${quickStart}\n`);
      throw new Error('Run node dist/cli.js setup first. See node dist/cli.js --help for shortcuts and examples.');
    }
    const config = options.hotkey ? { ...savedConfig, activationHotkey: options.hotkey } : savedConfig;
    process.stderr.write(`OpenSaysMe voice mode. ${config.activationHotkey ?? defaultActivationHotkey} starts/stops; Escape cancels; Ctrl+C quits.\n`);
    process.stderr.write(`Configuration: ${safeText(configPath())}\n`);
    process.stderr.write(`Models: reasoning ${safeText(config.reasoning.model)}; speech ${safeText(config.speech.model)}.\n`);
    if (options.hotkey) process.stderr.write('Using --hotkey for this run only; the saved shortcut is unchanged.\n');
    process.stderr.write('Save a shortcut: node dist/cli.js hotkey "Cmd+Shift+Space". Setup/access help: node dist/cli.js --help\n');
    process.stderr.write('Wait for ready, switch to your work, tap to talk, then tap again to finish. Try: "Explain this error."\n');
    process.stderr.write('Activated audio streams to OpenAI. Screen/context and cursor history are captured while recording.\n');
    process.stderr.write('After stopping, your agent can inspect desktop evidence and switch windows to fulfill your request.\n');
    process.stderr.write('Selected frames, context, and requested tool results go to your reasoning provider.\n');
    const debugDirectory = options.debug === true ? resolve('.opensaysme-debug') : options.debug;
    if (debugDirectory) process.stderr.write(`Debug enabled: ${safeText(debugDirectory)}. Context, transcripts, screenshots, prompts, responses, and session diagnostics remain until you delete them.\n`);
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
      else if (event.type === 'debug') process.stderr.write(`Debug files: ${safeText(event.directory)}\n`);
      else if (event.type === 'warning') process.stderr.write(`Warning: ${safeText(event.message)}\n`);
      else if (event.type === 'error') process.stderr.write(`Error: ${safeText(event.message)}\n`);
    }, { debugDirectory });
    console.log('Stopped.');
  });

program.command('setup').description('Configure environment-key references and explain macOS access; retain settings unless --replace')
  .option('--replace', 'Replace existing configuration after interactive setup')
  .action((options: { replace?: boolean }) => setup(stop.signal, Boolean(options.replace)));
program.command('hotkey [shortcut]').description('Show or save the activation shortcut; Escape and Ctrl+C stay fixed')
  .addHelpText('after', `\n${hotkeyHelp}\nDefault: ${defaultActivationHotkey}. Letter/digit keys use US physical key positions.
Save: node dist/cli.js hotkey "Cmd+Shift+Space"
Show: node dist/cli.js hotkey
Restart voice mode after saving. If the shortcut is already in use, choose another.
For one run without saving: node dist/cli.js --hotkey "Ctrl+Alt+Space"`)
  .action(async (value?: string) => {
    const parsed = value === undefined ? undefined : shortcut(value);
    const config = await readConfig();
    if (!parsed) { console.log(`Activation shortcut: ${config?.activationHotkey ?? defaultActivationHotkey}`); return; }
    if (!config) throw new Error('Run node dist/cli.js setup before saving a shortcut.');
    await writeConfig({ ...config, activationHotkey: parsed }, configPath(), true);
    console.log(`Saved activation shortcut: ${parsed}. Restart voice mode to apply it. Escape and Ctrl+C are unchanged.`);
  });
program.command('tools').description('List available agent tools and their schemas without reading the desktop')
  .action(async () => {
    const host = createDesktopTools(await desktopAdapter());
    try { json(host.list()); } finally { host.close(); }
  });
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
        activationHotkey: config?.activationHotkey ?? defaultActivationHotkey,
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
      if (configuration.activationHotkey) console.log(`  Activation shortcut: ${configuration.activationHotkey}`);
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
