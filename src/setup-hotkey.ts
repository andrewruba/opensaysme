import { cancel, confirm, intro, isCancel, note, outro } from '@clack/prompts';
import { configPath, readConfig, writeConfig } from './config.js';
import { activationHotkeySchema, defaultActivationHotkey, hotkeyHelp } from './hotkey.js';
import { desktopAdapter } from './desktop/index.js';

const cancelled = 'Hotkey setup cancelled. No configuration was written.';
const unavailable = {
  'accessibility-permission-required': 'Allow Accessibility for your terminal/helper in System Settings → Privacy & Security, then retry osm hotkey. You can also set it directly with osm hotkey "Cmd+Shift+Space".',
  'capture-unavailable': 'Could not record the shortcut. Run osm hotkey in a focused local terminal with Accessibility access; disable Secure Keyboard Entry if enabled. You can also set it directly with osm hotkey "Cmd+Shift+Space".',
  timeout: 'No shortcut was recorded within 30 seconds. Run osm hotkey to try again.',
  'focus-changed': 'Shortcut recording stopped because this terminal is not focused. Focus the terminal and run osm hotkey again.',
};

export async function setupHotkey(signal?: AbortSignal): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Hotkey setup needs an interactive terminal. Use osm hotkey "Cmd+Shift+Space" to set it directly, or osm hotkey --show to display it.');
  }
  if (signal?.aborted) throw new Error(cancelled);
  const config = await readConfig();
  if (signal?.aborted) throw new Error(cancelled);
  if (!config) throw new Error('Run osm setup before choosing a shortcut.');
  const adapter = await desktopAdapter();
  if (!adapter.recordHotkey) throw new Error('Physical shortcut recording is unavailable on this desktop. Use osm hotkey "Cmd+Shift+Space" to set it directly.');

  intro('Activation shortcut');
  note(`Current: ${config.activationHotkey ?? defaultActivationHotkey}\n${hotkeyHelp}\n`
    + 'Keep this terminal focused. Press and release your shortcut when ready below.\n'
    + 'Escape or Ctrl+C cancels. Recording stops after 30 seconds.', 'Record a shortcut');

  const stopped = new AbortController();
  const captureSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
  const wasRaw = process.stdin.isRaw, wasFlowing = process.stdin.readableFlowing;
  const onInput = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.includes(3) || bytes.includes(27)) stopped.abort();
  };
  const onEnd = () => stopped.abort();
  let result;
  try {
    // Discard terminal bytes while native capture observes the physical key code.
    // This also keeps uncaptured input from reaching the shell after cancellation.
    process.stdin.setRawMode(true);
    process.stdin.on('data', onInput);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
    result = await adapter.recordHotkey(captureSignal, () => note('Press your shortcut now, then release all keys.', 'Ready'));
  } catch (error) {
    if (captureSignal.aborted) throw new Error(cancelled, { cause: error });
    throw error;
  } finally {
    process.stdin.off('data', onInput);
    process.stdin.off('end', onEnd);
    process.stdin.setRawMode(Boolean(wasRaw));
    if (wasFlowing !== true) process.stdin.pause();
  }
  if (captureSignal.aborted || result.status === 'cancelled') {
    cancel(cancelled);
    throw new Error(cancelled);
  }
  if (result.status === 'unavailable') throw new Error(unavailable[result.reason]);
  const parsed = activationHotkeySchema.safeParse(result.shortcut);
  if (!parsed.success) throw new Error('The shortcut recorder returned an invalid shortcut. No configuration was written.');
  // Native capture has exited and all chord keys are released before this prompt.
  const save = await confirm({ signal, message: `Save ${parsed.data} as your activation shortcut?`, initialValue: true });
  if (signal?.aborted || isCancel(save) || !save) {
    cancel(cancelled);
    throw new Error(cancelled);
  }
  await writeConfig({ ...config, activationHotkey: parsed.data }, configPath(), true);
  outro(`Saved activation shortcut: ${parsed.data}. Restart voice mode to apply it. Escape and Ctrl+C are unchanged.`);
}
