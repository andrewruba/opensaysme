import type { DesktopAdapter } from './types.js';

export async function desktopAdapter(platform = process.platform): Promise<DesktopAdapter> {
  switch (platform) {
    case 'darwin': {
      const m = await import('./platforms/macos.js');
      return { permissions: m.macOSPermissions, probe: m.probeMacOS, listWindows: m.listMacOSWindows, inspectWindow: m.inspectMacOSWindow,
        captureWindow: m.captureMacOSWindow, input: m.macOSInput, inspect: m.inspectMacOS, focus: m.focusMacOS,
        testHotkey: m.testMacOSHotkey, testMicrophone: m.testMacOSMicrophone,
        voiceHelper: m.macOSVoiceHelper, feedbackHelper: m.macOSFeedbackHelper,
        captureContext: m.captureMacOSContext, captureFrame: m.captureMacOSFrame };
    }
    case 'win32': {
      const w = await import('./platforms/windows.js');
      return { probe: w.probeWindows, listWindows: w.listWindowsWindows, inspect: w.inspectWindows, focus: w.focusWindows,
        testHotkey: w.testWindowsHotkey, testMicrophone: w.testWindowsMicrophone,
        voiceHelper: w.windowsVoiceHelper, captureContext: w.captureWindowsContext, captureFrame: w.captureWindowsFrame };
    }
    case 'linux': {
      const l = await import('./platforms/linux.js');
      return { probe: l.probeLinux, listWindows: l.listLinuxWindows, inspect: l.inspectLinux, focus: l.focusLinux,
        testHotkey: l.testLinuxHotkey, testMicrophone: l.testLinuxMicrophone,
        voiceHelper: l.linuxVoiceHelper, captureContext: l.captureLinuxContext, captureFrame: l.captureLinuxFrame };
    }
    default: throw new Error(`Unsupported platform: ${platform}. Supported targets are macOS, Windows, and Linux.`);
  }
}
