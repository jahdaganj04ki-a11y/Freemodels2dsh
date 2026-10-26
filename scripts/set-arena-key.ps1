<#
.SYNOPSIS
    Speichert den Arena-API-Key fuer das freemodels2dsh-Gateway.

.DESCRIPTION
    Der Key wird an genau einer Stelle abgelegt:
      * als Benutzer-Umgebungsvariable ARENA_API_KEY (Registry, HKCU\Environment), und/oder
      * in einer Key-Datei mit ausschliesslichem Zugriff fuer den aktuellen Benutzer
        (%LOCALAPPDATA%\freemodels2dsh\arena.key).

    Ohne -FileOnly wird beides geschrieben: Die Umgebungsvariable wirkt sofort in
    neu gestarteten Programmen (also auch in DSH Desktop), die Key-Datei bleibt
    nutzbar, wenn DSH Desktop aus einer anderen Umgebung heraus gestartet wird.

.PARAMETER Key
    Der Key. Ohne diesen Parameter wird er verdeckt abgefragt.

.PARAMETER FileOnly
    Nur die Key-Datei schreiben, keine Umgebungsvariable setzen.

.PARAMETER Remove
    Key loeschen (Umgebungsvariable und Key-Datei).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\set-arena-key.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\set-arena-key.ps1 -Key "arena_..."
#>
[CmdletBinding()]
param(
    [string]$Key,
    [switch]$FileOnly,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$envName = 'ARENA_API_KEY'
$keyFile = Join-Path $env:LOCALAPPDATA 'freemodels2dsh\arena.key'

function Write-Step([string]$message) { Write-Host "  $message" }

if ($Remove) {
    [Environment]::SetEnvironmentVariable($envName, $null, 'User')
    Remove-Item Env:\ARENA_API_KEY -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $keyFile -Force }
    Write-Host 'Arena-Key entfernt (Umgebungsvariable und Key-Datei).'
    exit 0
}

if (-not $PSBoundParameters.ContainsKey('Key')) {
    $secure = Read-Host -AsSecureString 'Arena-API-Key (Eingabe bleibt unsichtbar)'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

$Key = ($Key -replace '^\s*Bearer\s+', '').Trim()
if ($Key.Length -lt 8 -or $Key.Length -gt 4096 -or $Key -match '[\s"]') {
    throw 'Der Key sieht nicht gueltig aus (zu kurz, zu lang oder enthaelt Leerzeichen/Anfuehrungszeichen).'
}

if (-not $FileOnly) {
    [Environment]::SetEnvironmentVariable($envName, $Key, 'User')
    Write-Step "Umgebungsvariable $envName fuer den aktuellen Benutzer gesetzt."
    Write-Step 'DSH Desktop muss danach vollstaendig beendet und neu gestartet werden.'
}

$directory = Split-Path -Parent $keyFile
if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Set-Content -LiteralPath $keyFile -Value $Key -NoNewline -Encoding ASCII
Write-Step "Key-Datei geschrieben: $keyFile"

# Zugriff auf den aktuellen Benutzer beschraenken (Vererbung abschalten).
try {
    & icacls.exe $keyFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    Write-Step 'Dateirechte auf den aktuellen Benutzer beschraenkt.'
} catch {
    Write-Warning "Dateirechte konnten nicht gesetzt werden: $($_.Exception.Message)"
}

$repo = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Host ''
    Write-Host 'Key wird gegen Arena geprueft ...'
    & $node.Source (Join-Path $repo 'bin\arena-gateway.mjs') --check
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Die Pruefung ist fehlgeschlagen. Laeuft ein Gateway bereits, ist das normal, wenn dieses seinen eigenen Key hat.'
    }
} else {
    Write-Step 'Node.js nicht gefunden - Pruefung uebersprungen (im DSH-Plugin-Betrieb nicht noetig).'
}

Write-Host ''
Write-Host 'Fertig. Naechste Schritte:'
Write-Host '  1. DSH Desktop vollstaendig beenden und neu starten.'
Write-Host '  2. Einstellungen -> Modelle -> Provider hinzufuegen:'
Write-Host '     Base-URL: http://127.0.0.1:8787/v1   (API-Key: beliebig, z. B. "local")'
Write-Host '     Modellliste laden und ein Arena-Modell auswaehlen.'
Write-Host '  3. Status pruefen: http://127.0.0.1:8787/'
