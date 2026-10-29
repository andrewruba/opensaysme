$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'visual.cs') -ReferencedAssemblies System.dll, System.Core.dll, System.Drawing.dll, System.Web.Extensions.dll
    [Console]::WriteLine([OpenSaysMeVisual]::Capture())
} catch {
    [Console]::WriteLine('{"error":"screen-capture-unavailable"}')
}
