<#
.SYNOPSIS
    Richtet das freemodels2dsh Arena-Gateway unter Windows ein.

.DESCRIPTION
    Zwei Betriebsarten:

    Plugin-Modus (Empfehlung): Das Paket wird als DSH-Plugin installiert; DSH
    Desktop startet das Gateway selbst mit seiner eigenen Laufzeit. Dieses Skript
    setzt dann nur den Key und gibt die Einstellungen fuer die Modellliste aus.

    Autostart-Modus (-Autostart): Zusaetzlich wird eine geplante Aufgabe
    angelegt, die das Gateway bei der Anmeldung startet. Das braucht eine
    separate Node.js-Installation (>= 20) und ist der Fallback, wenn das Plugin
    nicht installiert werden kann.

.PARAMETER Key
    Arena-API-Key. Ohne Angabe wird er verdeckt abgefragt.

.PARAMETER Port
    Loopback-Port des Gateways (Standard 8787).

.PARAMETER Autostart
    Geplante Aufgabe fuer den Gateway-Start bei der Anmeldung anlegen.

.PARAMETER SkipKey
    Key-Eingabe ueberspringen (Key ist bereits gesetzt).

.PARAMETER Uninstall
    Autostart-Aufgabe und gespeicherten Key entfernen.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Autostart -Port 8787
#>
[CmdletBinding()]
param(
    [string]$Key,
    [int]$Port = 8787,
    [switch]$Autostart,
    [switch]$SkipKey,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'freemodels2dsh Arena Gateway'
$repo = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repo 'bin\arena-gateway.mjs'
$envPort = 'FREEMODELS_GATEWAY_PORT'
$envKey = 'ARENA_API_KEY'
$keyFile = Join-Path $env:LOCALAPPDATA 'freemodels2dsh\arena.key'

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

Write-Host ''
Write-Host ' freemodels2dsh - Arena fuer DSH Desktop' -ForegroundColor Cyan
Write-Host ' ---------------------------------------'

if ($Uninstall) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Autostart-Aufgabe entfernt: $taskName"
    } else {
        Write-Host 'Keine Autostart-Aufgabe vorhanden.'
    }
    [Environment]::SetEnvironmentVariable($envKey, $null, 'User')
    [Environment]::SetEnvironmentVariable($envPort, $null, 'User')
    if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $keyFile -Force }
    Write-Host 'Key und Port-Konfiguration entfernt.'
    Write-Host ''
    Write-Host 'Das DSH-Plugin selbst wird in DSH Desktop unter Einstellungen -> Plugins entfernt.'
    exit 0
}

if (-not (Test-Path -LiteralPath $entry)) {
    throw "Gateway-Einstiegspunkt nicht gefunden: $entry"
}

if (-not $SkipKey) {
    $keyScript = Join-Path $PSScriptRoot 'set-arena-key.ps1'
    & $keyScript -Key $Key
}

if ($Port -ne 8787) {
    [Environment]::SetEnvironmentVariable($envPort, "$Port", 'User')
    $env:FREEMODELS_GATEWAY_PORT = "$Port"
    Write-Host "Port $Port als Benutzer-Umgebungsvariable $envPort gespeichert."
    Write-Host "Wichtig: Die Provider-Base-URL in DSH muss dann http://127.0.0.1:$Port/v1 sein."
}

if ($Autostart) {
    $node = Find-Node
    if (-not $node) {
        throw 'Node.js (>= 20) wurde nicht gefunden. Installiere es von https://nodejs.org/ oder nutze den Plugin-Modus (ohne -Autostart).'
    }
    $version = (& $node --version).TrimStart('v')
    if ([version]($version.Split('-')[0]) -lt [version]'20.0.0') {
        throw "Node.js $version ist zu alt. Das Gateway braucht Node.js >= 20."
    }

    $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" --port {1}' -f $entry, $Port) -WorkingDirectory $repo
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Autostart-Aufgabe angelegt und gestartet: $taskName (Node $version)"
    Start-Sleep -Seconds 2
}

$baseUrl = "http://127.0.0.1:$Port/v1"
Write-Host ''
Write-Host ' Einrichtung abgeschlossen.' -ForegroundColor Green
Write-Host ''
Write-Host ' In DSH Desktop eintragen (Einstellungen -> Modelle -> Provider hinzufuegen):'
Write-Host "   Base-URL : $baseUrl"
Write-Host '   API-Key  : beliebig, z. B. "local"'
Write-Host '   Modelle  : Liste laden, dann ein Arena-Modell waehlen'
Write-Host ''
Write-Host " Status: http://127.0.0.1:$Port/   Health: http://127.0.0.1:$Port/health"
if (-not $Autostart) {
    Write-Host ''
    Write-Host ' Plugin-Modus: Das Gateway startet mit DSH Desktop, sobald das Paket'
    Write-Host ' unter Einstellungen -> Plugins installiert ist. Kein Node.js noetig.'
}
Write-Host ''
