import type { DesktopAdapter } from './types.js';

export async function desktopAdapter(platform = process.platform): Promise<DesktopAdapter> {
  switch (platform) {
    case 'darwin': {
      const m = await import('./platforms/macos.js');
      return { probe: m.probeMacOS, listWindows: m.listMacOSWindows, inspectWindow: m.inspectMacOSWindow,
        captureWindow: m.captureMacOSWindow, input: m.macOSInput, inspect: m.inspectMacOS, focus: m.focusMacOS,
        voiceHelper: m.macOSVoiceHelper, feedbackHelper: m.macOSFeedbackHelper,
        captureContext: m.captureMacOSContext, captureFrame: m.captureMacOSFrame };
    }
    default: throw new Error(`Unsupported platform: ${platform}. OpenSaysMe currently supports macOS 14+ only.`);
  }
}
