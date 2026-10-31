#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { configPath, providerStatus, readConfig } from './config.js';
import { defaultActivationHotkey, hotkeyHelp } from './hotkey.js';
import { desktopAdapter } from './desktop/index.js';
import { cancelDesktopCommands } from './desktop/process.js';
import { capabilityNames, type DesktopReport } from './desktop/types.js';
import { setup } from './setup.js';
import { setupHotkey } from './setup-hotkey.js';
import { uninstall } from './uninstall.js';
import { runVoice } from './voice.js';
import { createDesktopTools } from './tools/desktop.js';
import { formatToolSummary } from './tool-summary.js';
import { clearWorkContext, openWorkContext, workContextPath } from './work-context.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const stop = new AbortController();
const stopAll = () => { stop.abort(); cancelDesktopCommands(); };
process.once('SIGINT', stopAll);
process.once('SIGTERM', stopAll);

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const safeText = (value: string) => JSON.stringify(value).slice(1, -1);
const quickStart = `Quick start from the repository (macOS 14+, Node.js 26.13+, Xcode Command Line Tools):
  npm ci
  npm run install:cli
  osm setup
  export OPENAI_API_KEY='your-key'
  osm doctor
  osm

The install command builds the app and makes osm and opensaysme available in your terminal.
Both commands run files from this repository folder, even from another directory.
Keep the folder on your computer. If you move it, rerun npm run install:cli there.
Setup saves key environment-variable names, never keys. Export the names you chose
in the same terminal used to launch voice mode; OPENAI_API_KEY is the default.
Allow Microphone, Accessibility and Screen Recording for your terminal/helper in
System Settings > Privacy & Security. Restart your terminal if grants do not apply.
Doctor checks access and key presence without recording or making a provider call.
`;
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
  .description('Tap-to-talk with desktop context (also available as osm)')
  .version(version)
  .option('--debug [directory]', 'Save local context, model inputs, responses, and diagnostics (default: .opensaysme-debug)', (value: string) => {
    if (!value.trim()) throw new InvalidArgumentError('Enter a nonempty debug directory.');
    return resolve(value);
  })
  .addHelpText('after', `\n${quickStart}
Activation shortcuts:
  osm hotkey                       Record the shortcut you press, then save it
  osm hotkey --show                 Show the saved shortcut
  osm hotkey --help                 Supported keys and modifiers

Using voice:
  Wait for ready, switch to your work, then tap ${defaultActivationHotkey} (default).
  Speak while showing the relevant content; tap again to finish. No need to hold it.
  Try: "Explain this error" or "Put this error into the agent's input; leave it unsent."
  Escape cancels pending work (in the CLI terminal when idle); Ctrl+C quits.
  Activated audio and screen/context go to your configured providers; charges apply.
  Recent app/window names are remembered locally across restarts; osm context shows them.
  Stop voice mode, then run osm context --clear to forget those names.
`)
  .showHelpAfterError()
  .action(async (options: { debug?: true | string }) => {
    const config = await readConfig();
    if (!config) {
      process.stderr.write(`${quickStart}\n`);
      throw new Error('Run osm setup first. See osm --help for shortcuts and examples.');
    }
    process.stderr.write(`OpenSaysMe voice mode. ${config.activationHotkey ?? defaultActivationHotkey} starts/stops; Escape cancels; Ctrl+C quits.\n`);
    process.stderr.write(`Configuration: ${safeText(configPath())}\n`);
    process.stderr.write(`Models: reasoning ${safeText(config.reasoning.model)}; speech ${safeText(config.speech.model)}.\n`);
    process.stderr.write('Change your shortcut: osm hotkey (interactive). Setup/access help: osm --help\n');
    process.stderr.write('Wait for ready, switch to your work, tap to talk, then tap again to finish. Try: "Explain this error."\n');
    process.stderr.write('Activated audio streams to OpenAI. Screen/context and cursor history are captured while recording.\n');
    process.stderr.write('After stopping, your agent can inspect windows, point, click, scroll, type and use keyboard shortcuts within your request.\n');
    process.stderr.write('Selected frames, context, and requested tool results go to your reasoning provider.\n');
    process.stderr.write('While idle, app/window names are saved locally and used as context and speech hints for up to 8 hours. View or clear them with osm context.\n');
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
      } else if (event.type === 'tool-summary') {
        process.stderr.write(`${formatToolSummary(event.summary)}\n`);
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
program.command('uninstall').description('Remove the installed osm and opensaysme commands')
  .addHelpText('after', '\nKeeps your repository folder, saved settings and debug captures.')
  .action(async () => {
    const removed = await uninstall(stop.signal);
    console.log(removed.length ? 'OpenSaysMe commands uninstalled.' : 'No installed OpenSaysMe commands found.');
    console.log('Your repository folder, saved settings and debug captures were kept.');
  });
program.command('hotkey').description('Record a pressed activation shortcut; Escape and Ctrl+C stay fixed')
  .option('--show', 'Show the saved shortcut without prompting or changing it')
  .addHelpText('after', `\n${hotkeyHelp}\nDefault: ${defaultActivationHotkey}. Letter/digit keys use US physical key positions.
Record: osm hotkey (press and release a shortcut, then confirm; Escape or Ctrl+C cancels)
Recording requires macOS Accessibility access. Keep this terminal focused.
Show: osm hotkey --show
Restart voice mode after saving. If the shortcut is already in use, choose another.`)
  .action(async (options: { show?: boolean }) => {
    if (!options.show) { await setupHotkey(stop.signal); return; }
    const config = await readConfig();
    console.log(`Activation shortcut: ${config?.activationHotkey ?? defaultActivationHotkey}`);
  });
program.command('tools').description('List available agent tools and their schemas without reading the desktop')
  .action(async () => {
    const host = createDesktopTools(await desktopAdapter());
    try { json(host.list()); } finally { host.close(); }
  });
program.command('context').description('Show recent remembered app/window names without reading the desktop')
  .option('--clear', 'Forget saved app/window names; stop voice mode first')
  .addHelpText('after', '\nNames are used for up to eight hours; expired entries are removed on the next context access.\nThey are context clues, never permission to act.\nStop voice mode before clearing; a running instance can record new observations.')
  .action(async (options: { clear?: boolean }) => {
    if (options.clear) {
      await clearWorkContext();
      console.log('Saved app/window context cleared.');
      return;
    }
    const context = await openWorkContext({ path: workContextPath(), onWarning: (message) => process.stderr.write(`${message}\n`) });
    try { json(context.recent()); } finally { await context.close(); }
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
