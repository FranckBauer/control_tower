# ============================================
# Control Tower - Setup agent Windows
# Installe l'agent dans C:\ProgramData\ControlTowerAgent\
# (juste les fichiers necessaires, pas de clone git)
# Active OpenSSH Server pour permettre la mise a jour a distance depuis le Pi
# A lancer en Administrateur depuis le repo (le script trouve les sources tout seul)
# ============================================

[CmdletBinding()]
param(
    [string] $Source = $PSScriptRoot,
    [string] $InstallDir = "C:\ProgramData\ControlTowerAgent",
    [int]    $Port = 3002,
    [string] $PiPubKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBVL2PGXMe5gKVSoJL7aFXprNl/j9+fZqdSLcAUG0oZE fbauer@yacast.fr"
)

$ErrorActionPreference = "Stop"
$taskName = "ControlTowerAgent"

Write-Host "=== Control Tower - Setup agent Windows ===" -ForegroundColor Cyan
Write-Host "Source     : $Source"
Write-Host "Installation : $InstallDir"
Write-Host "Port       : $Port"
Write-Host ""

# Verif admin
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Le script doit etre lance en Administrateur."
    exit 1
}

# Verif sources
$srcAgent = Join-Path $Source "agent"
$srcReqs  = Join-Path $Source "requirements.txt"
if (-not (Test-Path $srcAgent) -or -not (Test-Path $srcReqs)) {
    Write-Error "Sources introuvables dans $Source (attendu : agent/, requirements.txt)"
    exit 1
}

# --- 1. Python ---
# On cherche Python a plusieurs endroits car SYSTEM n'a pas le meme LOCALAPPDATA que les users
Write-Host "[1/6] Verification Python..."
$pythonExe = $null
$candidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "C:\Program Files\Python313\python.exe",
    "C:\Python313\python.exe"
)
# Plus tous les profils users ou Python est typiquement installe
$candidates += Get-ChildItem -Path "C:\Users\*\AppData\Local\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
foreach ($c in $candidates) {
    if (Test-Path $c) { $pythonExe = $c; break }
}
if (-not $pythonExe) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $pythonExe = $cmd.Source }
}
if (-not $pythonExe -or -not (Test-Path $pythonExe)) {
    Write-Error "Python introuvable. Installer Python 3.13 (https://www.python.org/downloads/)."
    exit 1
}
Write-Host "  $pythonExe"

# --- 2. Copie des fichiers ---
Write-Host "[2/6] Copie des fichiers vers $InstallDir..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "agent") | Out-Null
Copy-Item -Force (Join-Path $srcAgent "*.py") (Join-Path $InstallDir "agent\")
Copy-Item -Force $srcReqs (Join-Path $InstallDir "requirements.txt")
Copy-Item -Force $PSCommandPath (Join-Path $InstallDir "setup_windows.ps1")
Write-Host "  OK"

# --- 3. venv + deps ---
Write-Host "[3/6] Venv Python + dependances..."
$venvDir = Join-Path $InstallDir "venv"
if (-not (Test-Path $venvDir)) {
    & $pythonExe -m venv $venvDir
}
$venvPython = Join-Path $venvDir "Scripts\python.exe"
& $venvPython -m pip install --upgrade pip --quiet
& $venvPython -m pip install -r (Join-Path $InstallDir "requirements.txt") --quiet
Write-Host "  OK"

# --- 4. Tache planifiee SYSTEM ---
Write-Host "[4/6] Tache planifiee $taskName (SYSTEM, AtStartup)..."
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$action = New-ScheduledTaskAction `
    -Execute $venvPython `
    -Argument "-m uvicorn agent.main:app --host 0.0.0.0 --port $Port" `
    -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description "Control Tower Agent (port $Port)" | Out-Null

# Suppression du raccourci legacy si present
$legacyLnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ControlTowerAgent.lnk"
if (Test-Path $legacyLnk) {
    Remove-Item -Force $legacyLnk
    Write-Host "  Raccourci legacy supprime : $legacyLnk"
}
# Suppression du dossier legacy pi-dashboard-agent si present
$legacyDir = "$env:USERPROFILE\pi-dashboard-agent"
if (Test-Path $legacyDir) {
    Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$legacyDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $legacyDir
    Write-Host "  Dossier legacy supprime : $legacyDir"
}

# Demarrage
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4
Write-Host "  OK"

# --- 5. OpenSSH Server (pour update a distance depuis le Pi) ---
Write-Host "[5/6] OpenSSH Server..."
$sshCap = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Select-Object -First 1
if ($sshCap.State -ne "Installed") {
    Add-WindowsCapability -Online -Name $sshCap.Name | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd -ErrorAction SilentlyContinue
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
# Cle publique du Pi dans administrators_authorized_keys (admin SSH)
# IMPORTANT : owner doit etre Administrators ou SYSTEM, sinon sshd ignore le fichier silencieusement
$adminKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
$existing = if (Test-Path $adminKeys) { Get-Content $adminKeys -ErrorAction SilentlyContinue } else { @() }
if (-not ($existing -contains $PiPubKey)) {
    $newContent = ($existing + $PiPubKey) -join "`n"
    # Ecriture en ASCII (pas de BOM UTF-16/UTF-8 que sshd refuse)
    [System.IO.File]::WriteAllText($adminKeys, $newContent + "`n", [System.Text.Encoding]::ASCII)
}
# Owner = Administrators + permissions Administrators+SYSTEM uniquement
icacls $adminKeys /setowner "BUILTIN\Administrators" | Out-Null
icacls $adminKeys /inheritance:r | Out-Null
icacls $adminKeys /grant "BUILTIN\Administrators:F" "SYSTEM:F" | Out-Null
Write-Host "  OK"

# --- 6. Verification ---
Write-Host "[6/6] Verification..."
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 5
    Write-Host ""
    Write-Host "=== Setup OK ===" -ForegroundColor Green
    Write-Host "Agent up - hostname: $($resp.hostname), port: $Port"
    Write-Host "OpenSSH Server actif sur le port 22 (admin via cle Pi)"
    Write-Host ""
    Write-Host "Mise a jour future depuis le Pi :"
    Write-Host "  scp agent/*.py <host>:C:/ProgramData/ControlTowerAgent/agent/"
    Write-Host "  ssh <host> powershell Restart-ScheduledTask -TaskName ControlTowerAgent"
} catch {
    Write-Host ""
    Write-Host "=== Agent ne repond pas ===" -ForegroundColor Red
    Write-Host "Verifier : Get-ScheduledTaskInfo -TaskName $taskName"
    exit 1
}
