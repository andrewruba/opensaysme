import type { DesktopAdapter } from './types.js';

export async function desktopAdapter(platform = process.platform): Promise<DesktopAdapter> {
  switch (platform) {
    case 'darwin': {
      const m = await import('./platforms/macos.js');
      return { probe: m.probeMacOS, inspect: m.inspectMacOS, focus: m.focusMacOS,
        testHotkey: m.testMacOSHotkey, testMicrophone: m.testMacOSMicrophone };
    }
    case 'win32': {
      const w = await import('./platforms/windows.js');
      return { probe: w.probeWindows, inspect: w.inspectWindows, focus: w.focusWindows,
        testHotkey: w.testWindowsHotkey, testMicrophone: w.testWindowsMicrophone };
    }
    case 'linux': {
      const l = await import('./platforms/linux.js');
      return { probe: l.probeLinux, inspect: l.inspectLinux, focus: l.focusLinux,
        testHotkey: l.testLinuxHotkey, testMicrophone: l.testLinuxMicrophone };
    }
    default: throw new Error(`Unsupported platform: ${platform}. Supported targets are macOS, Windows, and Linux.`);
  }
}
