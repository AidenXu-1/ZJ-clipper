Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$HostName = 'com.nomo.clipper.transcriber'
$InstallDir = Join-Path $env:LOCALAPPDATA 'NomoClipper\NativeHost'
foreach ($key in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)) {
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
}

$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NomoClipper'))
$resolved = [IO.Path]::GetFullPath($InstallDir)
if ($resolved.StartsWith($expectedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath $resolved -PathType Container)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

Write-Host ''
Write-Host 'Nomo local transcript helper uninstalled.' -ForegroundColor Green
Write-Host 'Downloaded models and caches were kept under LocalAppData\NomoClipper\Transcriber.'
