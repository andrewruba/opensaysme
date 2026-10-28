param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('globalHotkey', 'microphone')]
    [string]$Capability,
    [ValidateRange(1, 30)]
    [int]$DurationSeconds = 10
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'input.cs')
    if ($Capability -eq 'globalHotkey') {
        $activated = [OpenSaysMeInput]::TestHotkey($DurationSeconds * 1000)
        $status = if ($activated) { 'passed' } else { 'not-observed' }
        $detail = if ($activated) { 'Ctrl+Shift+Space was observed.' } else { 'No Ctrl+Shift+Space activation was observed before the deadline.' }
        $result = @{ capability = $Capability; status = $status; detail = $detail }
    } else {
        $bytes = [OpenSaysMeInput]::TestMicrophone($DurationSeconds * 1000)
        $status = if ($bytes -gt 0) { 'passed' } else { 'not-observed' }
        $result = @{
            capability = $Capability; status = $status
            detail = 'The default microphone was opened; captured PCM buffers were discarded without saving audio.'
            metrics = @{ bytes = $bytes; sampleRate = 16000; channels = 1; durationSeconds = $DurationSeconds }
        }
    }
    $result | ConvertTo-Json -Compress -Depth 3
} catch {
    # Keep native exception text out of the result; no audio or input text is logged.
    $detail = if ($Capability -eq 'globalHotkey') {
        'Could not register Ctrl+Shift+Space. Another app may own the shortcut, or this session may not have desktop access.'
    } else {
        'Could not capture the default microphone. Check the recording device and Windows microphone privacy settings.'
    }
    @{ capability = $Capability; status = 'unavailable'; detail = $detail } | ConvertTo-Json -Compress
}
