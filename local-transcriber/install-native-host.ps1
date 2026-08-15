param(
    [string[]]$ExtensionPath = @(),
    [string[]]$ExtensionId = @()
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$HostName = 'com.nomo.clipper.transcriber'
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA 'NomoClipper\NativeHost'
$ToolsDir = Join-Path $InstallDir 'tools'
$ManifestPath = Join-Path $InstallDir ($HostName + '.json')

function Copy-NomoFile([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required file not found: $Source"
    }
    $sourceFull = [IO.Path]::GetFullPath($Source)
    $destinationFull = [IO.Path]::GetFullPath($Destination)
    if (-not [String]::Equals($sourceFull, $destinationFull, [StringComparison]::OrdinalIgnoreCase)) {
        Copy-Item -LiteralPath $sourceFull -Destination $destinationFull -Force
    }
}

function Find-NomoTool([string]$Name, [string[]]$KnownPaths) {
    $bundled = Join-Path (Join-Path $SourceDir 'tools') $Name
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    foreach ($known in $KnownPaths) {
        if ($known -and (Test-Path -LiteralPath $known -PathType Leaf)) { return $known }
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return $command.Source
    }
    throw "$Name was not found. Use the complete Nomo Windows package and run this installer again."
}

function Get-ChromiumExtensionId([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.Length -ge 2 -and $full[1] -eq ':') {
        $full = $full.Substring(0, 1).ToUpperInvariant() + $full.Substring(1)
    }
    $bytes = [Text.Encoding]::Unicode.GetBytes($full)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $alphabet = 'abcdefghijklmnop'
    $builder = New-Object Text.StringBuilder
    for ($index = 0; $index -lt 16; $index++) {
        [void]$builder.Append($alphabet[($hash[$index] -shr 4)])
        [void]$builder.Append($alphabet[($hash[$index] -band 15)])
    }
    return $builder.ToString()
}

function Test-NomoExtensionPath([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    $manifest = Join-Path $Path 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    try {
        $data = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$data.name -like '*Nomo*Clipper*'
    } catch { return $false }
}

function Read-Exact([IO.Stream]$Stream, [int]$Length) {
    $buffer = New-Object byte[] $Length
    $offset = 0
    while ($offset -lt $Length) {
        $read = $Stream.Read($buffer, $offset, $Length - $offset)
        if ($read -le 0) { throw 'Native host ended before returning a complete response.' }
        $offset += $read
    }
    return ,$buffer
}

function Test-NomoNativeHost([string]$Executable) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start the native host.' }
        $payload = [Text.Encoding]::UTF8.GetBytes('{"type":"ping"}')
        $header = [BitConverter]::GetBytes([int]$payload.Length)
        $process.StandardInput.BaseStream.Write($header, 0, $header.Length)
        $process.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
        $process.StandardInput.BaseStream.Flush()
        $process.StandardInput.Close()
        $replyHeader = Read-Exact $process.StandardOutput.BaseStream 4
        $replyLength = [BitConverter]::ToInt32($replyHeader, 0)
        if ($replyLength -le 0 -or $replyLength -gt 1048576) { throw 'Native host returned an invalid response length.' }
        $reply = [Text.Encoding]::UTF8.GetString((Read-Exact $process.StandardOutput.BaseStream $replyLength)) | ConvertFrom-Json
        if (-not $reply.ok) { throw 'Native host self-test returned an error.' }
        if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Native host self-test timed out.' }
    } finally {
        $process.Dispose()
    }
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null

foreach ($name in @('NomoNativeHost.exe', 'worker.py', 'server.py', 'pyproject.toml')) {
    Copy-NomoFile (Join-Path $SourceDir $name) (Join-Path $InstallDir $name)
}

$uv = Find-NomoTool 'uv.exe' @(
    (Join-Path $env:USERPROFILE 'Tools\uv-0.12.3\uv.exe'),
    (Join-Path $env:USERPROFILE '.local\bin\uv.exe')
)
$ffmpeg = Find-NomoTool 'ffmpeg.exe' @(
    (Join-Path $env:USERPROFILE 'Tools\ffmpeg-9.0-essentials_build\bin\ffmpeg.exe')
)
Copy-NomoFile $uv (Join-Path $ToolsDir 'uv.exe')
Copy-NomoFile $ffmpeg (Join-Path $ToolsDir 'ffmpeg.exe')

$ids = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$idFile = Join-Path $SourceDir 'allowed-extension-ids.txt'
if (Test-Path -LiteralPath $idFile -PathType Leaf) {
    foreach ($line in (Get-Content -LiteralPath $idFile -Encoding ASCII)) {
        $value = $line.Trim().ToLowerInvariant()
        if ($value -match '^[a-p]{32}$') { [void]$ids.Add($value) }
    }
}
foreach ($value in $ExtensionId) {
    $normalized = $value.Trim().ToLowerInvariant()
    if ($normalized -notmatch '^[a-p]{32}$') { throw "Invalid Chrome extension ID: $value" }
    [void]$ids.Add($normalized)
}

$candidatePaths = New-Object 'Collections.Generic.List[string]'
foreach ($value in $ExtensionPath) { if ($value) { $candidatePaths.Add($value) } }
$packageRoot = Split-Path $SourceDir -Parent
$candidatePaths.Add((Join-Path $packageRoot 'Chrome extension'))
$chromeFolderName = 'Chrome' + [char]0x6269 + [char]0x5c55
$candidatePaths.Add((Join-Path $packageRoot $chromeFolderName))
foreach ($candidate in $candidatePaths) {
    if (Test-NomoExtensionPath $candidate) { [void]$ids.Add((Get-ChromiumExtensionId $candidate)) }
}
if ($ids.Count -eq 0) {
    throw "No Nomo extension ID was found. Run install-native-host.ps1 -ExtensionPath '<unpacked extension folder>'."
}

$origins = @($ids | Sort-Object | ForEach-Object { 'chrome-extension://' + $_ + '/' })
$manifest = [ordered]@{
    name = $HostName
    description = 'Nomo Clipper local speech-to-text helper'
    path = (Join-Path $InstallDir 'NomoNativeHost.exe')
    type = 'stdio'
    allowed_origins = $origins
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($ManifestPath, $manifest, (New-Object Text.UTF8Encoding($false)))

foreach ($key in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $ManifestPath
}

Test-NomoNativeHost (Join-Path $InstallDir 'NomoNativeHost.exe')

Write-Host ''
Write-Host 'Nomo local transcript helper installed successfully.' -ForegroundColor Green
Write-Host ("Installed at: " + $InstallDir)
Write-Host ("Allowed extension IDs: " + (($ids | Sort-Object) -join ', '))
Write-Host 'Reload Nomo Clipper once on chrome://extensions, then use the transcript button directly.'
