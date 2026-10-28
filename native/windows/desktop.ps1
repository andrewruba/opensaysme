param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('probe', 'inspect', 'focus')]
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
}
'@

function Write-Response($Value) {
    $Value | ConvertTo-Json -Compress -Depth 5
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

$failureCode = 'native-failure'
try {
    $foreground = [OpenSaysMeDesktop]::GetForegroundWindow()
    if ($Operation -eq 'probe') {
        Write-Response @{
            version = 1; operation = 'probe'
            interactive = [Environment]::UserInteractive -and $foreground -ne [IntPtr]::Zero
            automation = Load-Automation
        }
        exit 0
    }

    if ($Operation -eq 'focus') {
        $failureCode = 'invalid-target'
        if ($TargetId -notmatch '^win32:([1-9][0-9]{0,9}):([1-9][0-9]{0,18})$') {
            throw 'Invalid Windows window identifier.'
        }
        $expectedProcess = [uint32]::Parse($Matches[1])
        $target = [IntPtr]::new([long]::Parse($Matches[2]))
        [uint32]$actualProcess = 0
        $null = [OpenSaysMeDesktop]::GetWindowThreadProcessId($target, [ref]$actualProcess)
        if (-not [OpenSaysMeDesktop]::IsWindow($target) -or
            -not [OpenSaysMeDesktop]::IsWindowVisible($target) -or
            $actualProcess -ne $expectedProcess) {
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

    if ($foreground -eq [IntPtr]::Zero) {
        Write-Response @{ version = 1; operation = 'inspect'; window = $null }
        exit 0
    }
    [uint32]$ownerProcess = 0
    $null = [OpenSaysMeDesktop]::GetWindowThreadProcessId($foreground, [ref]$ownerProcess)
    $application = (Get-Process -Id $ownerProcess).ProcessName
    $title = New-Object System.Text.StringBuilder(16385)
    $null = [OpenSaysMeDesktop]::GetWindowText($foreground, $title, $title.Capacity)
    $response = @{
        version = 1; operation = 'inspect'
        window = @{
            id = "win32:${ownerProcess}:$($foreground.ToInt64())"
            application = $application; title = $title.ToString()
        }
    }
    if ($IncludeSelection) {
        $failureCode = 'selection-unavailable'
        if (-not (Load-Automation)) { throw 'Windows UI Automation is unavailable.' }
        $element = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $element -or $element.Current.IsPassword) {
            throw 'Selected text is unavailable from the current Windows control.'
        }
        # Reject a focus race instead of associating another window's text with this one.
        $ancestor = $element
        $belongsToForeground = $false
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        while ($null -ne $ancestor) {
            if ([OpenSaysMeDesktop]::MatchesAutomationHandle($foreground, $ancestor.Current.NativeWindowHandle)) {
                $belongsToForeground = $true
                break
            }
            $ancestor = $walker.GetParent($ancestor)
        }
        if (-not $belongsToForeground) {
            $failureCode = 'focus-changed'
            throw 'Desktop focus changed; inspect again.'
        }
        [object]$pattern = $null
        if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            throw 'The focused control does not expose selected text through UI Automation.'
        }
        if ($pattern.SupportedTextSelection -eq [System.Windows.Automation.SupportedTextSelection]::None) {
            throw 'The focused control does not support text selection.'
        }
        $parts = @()
        $remaining = 16384
        foreach ($range in $pattern.GetSelection()) {
            $part = $range.GetText($remaining + 1)
            if ($part.Length -gt $remaining) {
                $failureCode = 'selection-too-large'
                throw 'Selected text exceeds the capture limit.'
            }
            $parts += $part
            $remaining -= $part.Length
        }
        $response.selectedText = $parts -join ''
        if ([OpenSaysMeDesktop]::GetForegroundWindow() -ne $foreground) {
            $failureCode = 'focus-changed'
            throw 'Desktop focus changed; inspect again.'
        }
    }
    Write-Response $response
} catch {
    # Return a fixed error code; native exception messages can expose app content.
    Write-Response @{ version = 1; operation = 'error'; code = $failureCode }
}
