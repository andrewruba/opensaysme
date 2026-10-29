# Windows desktop and voice helpers

The adapter uses Windows PowerShell 5.1 and the installed .NET Framework. Small
C# declarations are compiled by `Add-Type`; users do not install a separate
compiler or download native packages. Run in an unlocked, logged-in desktop.
PowerShell must permit these local scripts. Execution policy and enterprise
restrictions are respected, never changed by the tool.

- `desktop.ps1` reads the foreground Win32 window, focuses a verified window
  handle, and optionally reads selection through UI Automation `TextPattern`.
  Selection is unavailable for controls without that pattern and password fields.
  Selections over 16,384 characters are rejected instead of silently truncated.
  No clipboard reads or synthesized copy shortcuts are used.
- The separate `context` operation captures the foreground window, cursor
  coordinates, and top-level window under the cursor before reading optional
  selection. Unsupported or protected selection becomes a warning; strict
  `desktop inspect --selection` continues to report an error. Focus never changes.
- `voice.ps1` / `voice.cs` keep Ctrl+Shift+Space registered with repeat suppression.
  A `start` command opens the default microphone and streams 100 ms chunks of
  24 kHz mono signed 16-bit little-endian PCM over the local pipe. No audio files
  are created. Escape is registered only during a turn and remains available
  while transcription finishes after `stop`; `cancel` or `settled` releases it.
  Cancellation discards pending device audio and acknowledges cleanup. Stale
  commands cannot stop a newer turn. Capture is capped at 120 seconds; command
  lines and pipe queues are bounded. EOF, shutdown, and capture failure clean up
  registrations and audio handles. The parent sends audio to its configured
  transcription provider; desktop context is not included in that request.
- `input.ps1` / `input.cs` test Ctrl+Shift+Space registration and default microphone
  input for at most 30 seconds. Audio is counted in memory and discarded; only
  byte counts and recording format are returned. Cleanup unregisters the hotkey
  and resets, unprepares, and closes audio buffers. Stopping the helper releases
  its process-owned resources.

Focus may be denied by Windows foreground restrictions. Elevated apps and secure
desktops may be inaccessible. Successful native compilation or unit tests do not
establish interactive support: manually test focus, selection, shortcut conflicts,
microphone permission denial, cancellation, and capture on a Windows desktop.
The default recording device must support 24 kHz PCM. Startup reports a clear
failure when capture or shortcut registration is unavailable. An application that
already owns Escape can prevent starting a turn. Context capture uses a separate
PowerShell process, so its timestamp reflects capture shortly after activation,
not an atomic desktop snapshot at the exact keypress. UI Automation may be slow
or unavailable; the parent bounds and cancels that operation independently.

From the repository root, these PowerShell checks compile the input helper, parse
the scripts, and run a read-only foreground/API probe. They do not register a
shortcut, change focus, or capture audio or selected text:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -Path ./native/windows/input.cs
Add-Type -Path ./native/windows/voice.cs -ReferencedAssemblies System.dll, System.Core.dll, System.Web.Extensions.dll
foreach ($file in Get-ChildItem ./native/windows/*.ps1) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "PowerShell parse failed: $($file.Name)" }
}
powershell.exe -NoLogo -NoProfile -NonInteractive -File ./native/windows/desktop.ps1 -Operation probe
powershell.exe -NoLogo -NoProfile -NonInteractive -File ./native/windows/test-voice.ps1
```

The last command checks protocol validation, cancellation acknowledgments, stale
turn isolation, and output backpressure without calling any Windows desktop or
microphone APIs. Native capture and hotkey delivery still require manual Windows
verification; compiling on another OS does not establish that they work.

The implementation follows Microsoft's documentation for
[foreground activation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow),
[UI Automation selection](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.textpattern.getselection),
[global shortcuts](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey),
[pointer targeting](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint), and
[audio buffer cleanup](https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/nf-mmeapi-waveinreset).
