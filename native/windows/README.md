# Windows desktop proof

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
- `input.ps1` / `input.cs` test Ctrl+Shift+Space registration and default microphone
  input for at most 30 seconds. Audio is counted in memory and discarded; only
  byte counts and recording format are returned. Cleanup unregisters the hotkey
  and resets, unprepares, and closes audio buffers. Stopping the helper releases
  its process-owned resources.

Focus may be denied by Windows foreground restrictions. Elevated apps and secure
desktops may be inaccessible. Successful native compilation or unit tests do not
establish interactive support: manually test focus, selection, shortcut conflicts,
microphone permission denial, cancellation, and capture on a Windows desktop.

From the repository root, these PowerShell checks compile the input helper, parse
both scripts, and run a read-only foreground/API probe. They do not register a
shortcut, change focus, or capture audio or selected text:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -Path ./native/windows/input.cs
foreach ($path in @('./native/windows/desktop.ps1', './native/windows/input.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path $path).Path, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "PowerShell parse failed: $path" }
}
powershell.exe -NoLogo -NoProfile -NonInteractive -File ./native/windows/desktop.ps1 -Operation probe
```

The implementation follows Microsoft's documentation for
[foreground activation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow),
[UI Automation selection](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.textpattern.getselection),
[global shortcuts](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey), and
[audio buffer cleanup](https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/nf-mmeapi-waveinreset).
