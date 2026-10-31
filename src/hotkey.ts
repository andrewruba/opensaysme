import { z } from 'zod';

export const defaultActivationHotkey = 'Ctrl+Shift+Space';
const modifiers = ['Ctrl', 'Alt', 'Cmd', 'Shift'];
export const hotkeyHelp = 'Use Ctrl, Alt, Shift or Cmd plus Space, A–Z, 0–9 or F1–F12 (for example Cmd+Shift+Space). Include Ctrl, Alt or Cmd. Escape and Ctrl+C are reserved.';

/** Normalize user spelling before passing the bounded shortcut to the native helper. */
function normalize(value: string): string | undefined {
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined;
  const parts = value.split('+').map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  const selected = parts.map((part) => modifiers.find((modifier) => modifier.toLowerCase() === part));
  if (!key || !/^(?:space|[a-z0-9]|f(?:[1-9]|1[0-2]))$/.test(key)
    || selected.some((part) => !part) || new Set(selected).size !== selected.length
    || !selected.some((part) => part === 'Ctrl' || part === 'Alt' || part === 'Cmd')
    || (key === 'c' && selected.includes('Ctrl'))) return undefined;
  return [...modifiers.filter((modifier) => selected.includes(modifier)), key === 'space' ? 'Space' : key.toUpperCase()].join('+');
}

export const activationHotkeySchema = z.string().max(128).transform((value, ctx) => {
  const normalized = normalize(value);
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: hotkeyHelp });
    return z.NEVER;
  }
  return normalized;
});
