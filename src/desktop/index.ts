import type { DesktopAdapter } from './types.js';

export async function desktopAdapter(platform = process.platform): Promise<DesktopAdapter> {
  switch (platform) {
    case 'darwin': {
      const m = await import('./platforms/macos.js');
      return { probe: m.probeMacOS, listWindows: m.listMacOSWindows, inspectWindow: m.inspectMacOSWindow,
        activateApplication: m.activateMacOSApplication,
        captureWindow: m.captureMacOSWindow, input: m.macOSInput, keyboard: m.macOSKeyboard, inspect: m.inspectMacOS, focus: m.focusMacOS,
        voiceHelper: m.macOSVoiceHelper, feedbackHelper: m.macOSFeedbackHelper,
        recordHotkey: m.recordMacOSHotkey, readText: m.readMacOSText,
        captureContext: m.captureMacOSContext, captureFrame: m.captureMacOSFrame };
    }
    default: throw new Error(`Unsupported platform: ${platform}. OpenSaysMe currently supports macOS 14+ only.`);
  }
}
