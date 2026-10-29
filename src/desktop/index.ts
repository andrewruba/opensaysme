import type { DesktopAdapter } from './types.js';

export async function desktopAdapter(platform = process.platform): Promise<DesktopAdapter> {
  switch (platform) {
    case 'darwin': {
      const m = await import('./platforms/macos.js');
      return { probe: m.probeMacOS, inspect: m.inspectMacOS, focus: m.focusMacOS,
        testHotkey: m.testMacOSHotkey, testMicrophone: m.testMacOSMicrophone,
        voiceHelper: m.macOSVoiceHelper, captureContext: m.captureMacOSContext };
    }
    case 'win32': {
      const w = await import('./platforms/windows.js');
      return { probe: w.probeWindows, inspect: w.inspectWindows, focus: w.focusWindows,
        testHotkey: w.testWindowsHotkey, testMicrophone: w.testWindowsMicrophone,
        voiceHelper: w.windowsVoiceHelper, captureContext: w.captureWindowsContext };
    }
    case 'linux': {
      const l = await import('./platforms/linux.js');
      return { probe: l.probeLinux, inspect: l.inspectLinux, focus: l.focusLinux,
        testHotkey: l.testLinuxHotkey, testMicrophone: l.testLinuxMicrophone,
        voiceHelper: l.linuxVoiceHelper, captureContext: l.captureLinuxContext };
    }
    default: throw new Error(`Unsupported platform: ${platform}. Supported targets are macOS, Windows, and Linux.`);
  }
}
