# Pure protocol checks: no hotkey registration, window access, or microphone use.
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'voice.cs'), (Join-Path $PSScriptRoot 'visual.cs') -ReferencedAssemblies System.dll, System.Core.dll, System.Drawing.dll, System.Web.Extensions.dll
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

# Simulate delayed delivery and a partial final buffer without touching WinMM.
$clockType = $type.GetNestedType('AudioClock', [System.Reflection.BindingFlags]'NonPublic')
$stamp = $clockType.GetMethod('Stamp', [System.Reflection.BindingFlags]'Public,Instance')
$epoch = [DateTime]::SpecifyKind([DateTime]'2026-01-01T00:00:00', [DateTimeKind]::Utc)
$audioClock = [Activator]::CreateInstance($clockType, @($epoch))
$firstChunk = $stamp.Invoke($audioClock, (, [byte[]]::new(4800)))
$tailChunk = $stamp.Invoke($audioClock, (, [byte[]]::new(960)))
if ($firstChunk.StartSample -ne 0 -or $firstChunk.CapturedAt -ne $epoch -or
    $tailChunk.StartSample -ne 2400 -or $tailChunk.CapturedAt -ne $epoch.AddMilliseconds(100)) {
    throw 'PCM capture offsets or tail timing were incorrect.'
}
$freshClock = [Activator]::CreateInstance($clockType, @($epoch.AddSeconds(5)))
$freshChunk = $stamp.Invoke($freshClock, (, [byte[]]::new(4800)))
if ($freshChunk.StartSample -ne 0 -or $freshChunk.CapturedAt -ne $epoch.AddSeconds(5)) { throw 'New turn did not reset timing.' }
$timedHelper = New-Object OpenSaysMeVoice
$turn.SetValue($timedHelper, 'timed-turn')
$emitAudio = $type.GetMethod('EmitAudio', $instance)
$null = $emitAudio.Invoke($timedHelper, @($tailChunk))
$timedEvent = $output.GetValue($timedHelper).Take() | ConvertFrom-Json
if ($timedEvent.startSample -ne 2400 -or $timedEvent.timing -ne 'estimated' -or
    [DateTime]::Parse($timedEvent.capturedAt).ToUniversalTime() -ne $epoch.AddMilliseconds(100)) {
    throw 'Audio timing metadata was lost when emitting the event.'
}
Write-Output 'Windows synthetic audio timing checks passed.'

# A stalled ring must fail before emitting falsely continuous PCM. Construct
# synthetic headers without calling the Capture constructor or any driver API.
$captureType = $type.GetNestedType('Capture', [System.Reflection.BindingFlags]'NonPublic')
$headerType = $type.GetNestedType('WaveHeader', [System.Reflection.BindingFlags]'NonPublic')
$fakeCapture = [System.Runtime.Serialization.FormatterServices]::GetUninitializedObject($captureType)
$headers = [IntPtr[]]::new(4)
try {
    for ($i = 0; $i -lt 4; $i++) {
        $header = [Activator]::CreateInstance($headerType)
        $header.Flags = 1
        $header.BytesRecorded = 4800
        $headers[$i] = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($header))
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($header, $headers[$i], $false)
    }
    $captureType.GetField('headers', $instance).SetValue($fakeCapture, $headers)
    $rejected = $false
    try { $captureType.GetMethod('Drain').Invoke($fakeCapture, @($null, $true)) }
    catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        $rejected = $failure -is [InvalidOperationException]
    }
    if (-not $rejected) { throw 'A full capture ring was not rejected.' }
} finally {
    foreach ($header in $headers) {
        if ($header -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($header) }
    }
}
Write-Output 'Windows capture discontinuity check passed.'

# Encode a synthetic image; this never calls a screen capture API.
$bitmap = New-Object System.Drawing.Bitmap(3200, 1600)
try {
    $encoded = [OpenSaysMeVisual]::Encode($bitmap)
    if ($encoded.width -ne 1600 -or $encoded.height -ne 800) { throw 'Image bounds were not preserved.' }
    $bytes = [Convert]::FromBase64String($encoded.data)
    if ($bytes.Length -gt 700000 -or $bytes[0] -ne 255 -or $bytes[1] -ne 216) { throw 'JPEG encoding was invalid or unbounded.' }
} finally { $bitmap.Dispose() }
Write-Output 'Windows synthetic visual encoding checks passed.'
