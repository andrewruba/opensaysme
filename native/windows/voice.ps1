$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'voice.cs') -ReferencedAssemblies System.dll, System.Core.dll, System.Web.Extensions.dll
    [OpenSaysMeVoice]::Run()
} catch {
    # Never expose native exception text or command payloads.
    [Console]::WriteLine('{"type":"error","code":"internal-error"}')
    exit 1
}
