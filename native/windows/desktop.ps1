param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('probe', 'inspect', 'focus', 'context', 'list-windows')]
    [string]$Operation,
    [switch]$IncludeSelection,
    [string]$TargetId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Only documented Win32 APIs are used. No injected keystrokes or clipboard reads.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OpenSaysMeDesktop {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);
    public static bool MatchesAutomationHandle(IntPtr window, int automationHandle) {
        // UI Automation exposes an Int32 HWND, even in a 64-bit client.
        return (window.ToInt64() & 0xffffffffL) == unchecked((uint)automationHandle);
    }
    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    public static IntPtr[] VisibleWindows() {
        var handles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
            if (IsWindowVisible(handle)) handles.Add(handle);
            return handles.Count < 256;
        }, IntPtr.Zero);
        return handles.ToArray();
    }
}
'@

function Write-Response($Value) {
    $Value | ConvertTo-Json -Compress -Depth 6
}

function Load-Automation {
    try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        return $true
    } catch {
        return $false
    }
}

function Read-Window([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return $null }
    if (-not [OpenSaysMeDesktop]::IsWindow($Handle)) { throw 'Window unavailable.' }
    [uint32]$ownerProcess = 0
    $null = [OpenSaysMeDesktop]::GetWindowThreadProcessId($Handle, [ref]$ownerProcess)
    $windowProcess = Get-Process -Id $ownerProcess
    $application = $windowProcess.ProcessName
    $started = $windowProcess.StartTime.ToUniversalTime().Ticks
    $title = New-Object System.Text.StringBuilder(16385)
    $null = [OpenSaysMeDesktop]::GetWindowText($Handle, $title, $title.Capacity)
    return @{
        id = "win32:${ownerProcess}:$($Handle.ToInt64()):${started}"
        application = $application; title = $title.ToString()
    }
}

function Read-Selection([IntPtr]$Foreground) {
    $script:failureCode = 'selection-unavailable'
    if (-not (Load-Automation)) { throw 'Windows UI Automation is unavailable.' }
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $element -or $element.Current.IsPassword) { throw 'Selection protected or unavailable.' }
    $ancestor = $element
    $belongsToForeground = $false
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    for ($depth = 0; $depth -lt 128 -and $null -ne $ancestor; $depth++) {
        if ($ancestor.Current.IsPassword) { throw 'Selection protected.' }
        if ([OpenSaysMeDesktop]::MatchesAutomationHandle($Foreground, $ancestor.Current.NativeWindowHandle)) {
            $belongsToForeground = $true
            break
        }
        $ancestor = $walker.GetParent($ancestor)
    }
    if (-not $belongsToForeground) {
        $script:failureCode = 'focus-changed'
        throw 'Desktop focus changed.'
    }
    [object]$pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern) -or
        $pattern.SupportedTextSelection -eq [System.Windows.Automation.SupportedTextSelection]::None) {
        throw 'Selection unavailable.'
    }
    $parts = @()
    $remaining = 16384
    foreach ($range in $pattern.GetSelection()) {
        $part = $range.GetText($remaining + 1)
        if ($part.Length -gt $remaining) {
            $script:failureCode = 'selection-too-large'
            throw 'Selected text exceeds the capture limit.'
        }
        $parts += $part
        $remaining -= $part.Length
    }
    if ([OpenSaysMeDesktop]::GetForegroundWindow() -ne $Foreground -or
        -not $element.Equals([System.Windows.Automation.AutomationElement]::FocusedElement)) {
        $script:failureCode = 'focus-changed'
        throw 'Desktop focus changed.'
    }
    return @{ selectedText = ($parts -join '') }
}

$failureCode = 'native-failure'
try {
    $foreground = [OpenSaysMeDesktop]::GetForegroundWindow()
    if ($Operation -eq 'probe') {
        $drawing = $false
        try { Add-Type -AssemblyName System.Drawing; $drawing = $true } catch { }
        Write-Response @{
            version = 1; operation = 'probe'
            interactive = [Environment]::UserInteractive -and $foreground -ne [IntPtr]::Zero
            automation = Load-Automation
            screenCapture = $drawing
        }
        exit 0
    }

    if ($Operation -eq 'focus') {
        $failureCode = 'invalid-target'
        if ($TargetId -notmatch '^win32:([1-9][0-9]{0,9}):([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$') {
            throw 'Invalid Windows window identifier.'
        }
        $expectedProcess = [uint32]::Parse($Matches[1])
        $target = [IntPtr]::new([long]::Parse($Matches[2]))
        $expectedStart = [long]::Parse($Matches[3])
        [uint32]$actualProcess = 0
        $null = [OpenSaysMeDesktop]::GetWindowThreadProcessId($target, [ref]$actualProcess)
        if (-not [OpenSaysMeDesktop]::IsWindow($target) -or
            -not [OpenSaysMeDesktop]::IsWindowVisible($target) -or
            $actualProcess -ne $expectedProcess -or
            (Get-Process -Id $actualProcess).StartTime.ToUniversalTime().Ticks -ne $expectedStart) {
            throw 'The target window is no longer available.'
        }
        if ([OpenSaysMeDesktop]::IsIconic($target)) {
            $null = [OpenSaysMeDesktop]::ShowWindowAsync($target, 9)
        }
        $failureCode = 'focus-denied'
        $null = [OpenSaysMeDesktop]::SetForegroundWindow($target)
        # Foreground activation can complete asynchronously across input queues.
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if ([OpenSaysMeDesktop]::GetForegroundWindow() -eq $target) {
                Write-Response @{ version = 1; operation = 'focus'; focused = $true }
                exit 0
            }
            Start-Sleep -Milliseconds 50
        }
        throw 'Windows refused foreground activation. Activate the tool deliberately and try again.'
    }

    if ($Operation -eq 'list-windows') {
        if (-not [Environment]::UserInteractive -or $foreground -eq [IntPtr]::Zero) {
            throw 'No interactive desktop is available.'
        }
        $windows = @()
        $warnings = @()
        $omitted = $false
        $handles = [OpenSaysMeDesktop]::VisibleWindows()
        foreach ($handle in $handles) {
            if ($windows.Count -ge 128) { break }
            try {
                $window = Read-Window $handle
                if ($null -ne $window -and -not [String]::IsNullOrWhiteSpace($window.title)) { $windows += $window }
            } catch { $omitted = $true }
        }
        if ($omitted) { $warnings += 'Some inaccessible or closing windows were omitted.' }
        if ($windows.Count -ge 128 -or $handles.Length -ge 256) { $warnings += 'Window discovery reached its limit; some windows may be missing.' }
        Write-Response @{ version = 1; operation = 'list-windows'; inventory = @{ windows = @($windows); warnings = @($warnings) } }
        exit 0
    }

    if ($Operation -eq 'context') {
        # Freeze coordinates and window identities before the slower optional UIA read.
        $context = @{
            platform = 'win32'; capturedAt = [DateTime]::UtcNow.ToString('o')
            activeWindow = $null; warnings = @()
        }
        $position = New-Object OpenSaysMeDesktop+Point
        $physical = $false
        try { $physical = [OpenSaysMeDesktop]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -ne [IntPtr]::Zero } catch { }
        if ($physical -and [OpenSaysMeDesktop]::GetCursorPos([ref]$position)) {
            $pointed = [OpenSaysMeDesktop]::WindowFromPoint($position)
            if ($pointed -ne [IntPtr]::Zero) {
                $pointed = [OpenSaysMeDesktop]::GetAncestor($pointed, 2) # GA_ROOT
            }
            $context.pointer = @{ x = $position.X; y = $position.Y; window = $null }
            try { $context.pointer.window = Read-Window $pointed }
            catch { $context.warnings += 'The window under the pointer was unavailable.' }
        } else { $context.warnings += 'Pointer position in physical desktop coordinates was unavailable.' }
        try {
            $context.activeWindow = Read-Window $foreground
            if ($null -eq $context.activeWindow) { $context.warnings += 'No active window was available.' }
        }
        catch { $context.warnings += 'The active window was unavailable.' }
        if ($null -ne $context.activeWindow) {
            try { $context.selectedText = (Read-Selection $foreground).selectedText }
            catch {
                # Context is best-effort; strict desktop inspect still fails on unavailable selection.
                $context.warnings += 'Selected text was unavailable, protected, too large, or changed during capture.'
            }
        }
        Write-Response $context
        exit 0
    }

    $response = @{ version = 1; operation = 'inspect'; window = (Read-Window $foreground) }
    if ($IncludeSelection -and $null -ne $response.window) {
        $response.selectedText = (Read-Selection $foreground).selectedText
    }
    Write-Response $response
} catch {
    # Return a fixed error code; native exception messages can expose app content.
    Write-Response @{ version = 1; operation = 'error'; code = $failureCode }
}
