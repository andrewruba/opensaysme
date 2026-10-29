# Pure protocol checks: no hotkey registration, window access, or microphone use.
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'voice.cs') -ReferencedAssemblies System.dll, System.Core.dll, System.Web.Extensions.dll
$static = [System.Reflection.BindingFlags]'Static,NonPublic'
$instance = [System.Reflection.BindingFlags]'Instance,NonPublic'
$type = [OpenSaysMeVoice]
$parse = $type.GetMethod('ParseCommand', $static)
$handle = $type.GetMethod('Handle', $instance)
$turn = $type.GetField('turnId', $instance)
$output = $type.GetField('output', $instance)
$shutdown = $type.GetField('shutdown', $instance)

foreach ($line in @(
    '{"type":"start","turnId":"turn-1"}', '{"type":"stop","turnId":"turn-1"}',
    '{"type":"cancel","turnId":"turn-1"}', '{"type":"settled","turnId":"turn-1"}',
    '{"type":"shutdown"}'
)) {
    if ($null -eq $parse.Invoke($null, @($line))) { throw 'Valid command was rejected.' }
}
foreach ($line in @(
    'private invalid JSON', '{"type":"start"}', '{"type":"start","turnId":123}',
    '{"type":"start","turnId":"unsafe; command"}', '{"type":"shutdown","turnId":"extra"}',
    '{"type":"start","turnId":"ok","extra":true}', '{"type":"unknown","turnId":"ok"}',
    ('{"type":"start","turnId":"' + ('a' * 65) + '"}'), (' ' * 1025)
)) {
    if ($null -ne $parse.Invoke($null, @($line))) { throw 'Invalid command was accepted.' }
}

$helper = New-Object OpenSaysMeVoice
$queue = $output.GetValue($helper)
$cancel = $parse.Invoke($null, @('{"type":"cancel","turnId":"old-turn"}'))
$null = $handle.Invoke($helper, @($cancel))
$event = $queue.Take() | ConvertFrom-Json
if ($event.type -ne 'audio-stopped' -or $event.turnId -ne 'old-turn') { throw 'Idle cancellation was not acknowledged.' }

$turn.SetValue($helper, 'new-turn')
$null = $handle.Invoke($helper, @($cancel))
if ($queue.Count -ne 0 -or $turn.GetValue($helper) -ne 'new-turn') { throw 'Stale cancellation affected a new turn.' }
$cancel = $parse.Invoke($null, @('{"type":"cancel","turnId":"new-turn"}'))
$null = $handle.Invoke($helper, @($cancel))
$event = $queue.Take() | ConvertFrom-Json
if ($event.type -ne 'audio-stopped' -or $event.turnId -ne 'new-turn' -or $null -ne $turn.GetValue($helper)) {
    throw 'Matching cancellation was not acknowledged and cleared.'
}

# A parent that stops reading cannot cause an unbounded audio/event queue.
for ($i = 0; $i -lt 65; $i++) { $null = $handle.Invoke($helper, @($cancel)) }
if ($queue.Count -ne 64 -or -not $shutdown.GetValue($helper)) { throw 'Output backpressure was not bounded.' }
Write-Output 'Windows voice protocol checks passed (no desktop or microphone access).'
