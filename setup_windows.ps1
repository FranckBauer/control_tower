# ============================================
# Control Tower - Setup Windows
# Cree la tache planifiee SYSTEM qui lance l'agent au boot
# A executer en tant qu'Administrateur depuis le repo clone
# ============================================

$ErrorActionPreference = "Stop"
$repoDir = $PSScriptRoot
$taskName = "ControlTowerAgent"
$port = 3002

Write-Host "=== Control Tower - Setup Windows ===" -ForegroundColor Cyan
Write-Host "Repo: $repoDir"
Write-Host ""

# Verif droits admin
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Ce script doit etre lance en tant qu'Administrateur."
    exit 1
}

# --- 1. Verif Python ---
Write-Host "[1/5] Verification Python..."
$pythonExe = "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe"
if (-not (Test-Path $pythonExe)) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $pythonExe = $cmd.Source }
}
if (-not (Test-Path $pythonExe)) {
    Write-Error "Python introuvable. Installer Python 3.13 d'abord (https://www.python.org/downloads/)."
    exit 1
}
Write-Host "  Python: $pythonExe"

# --- 2. Venv ---
Write-Host "[2/5] Venv Python..."
$venvDir = Join-Path $repoDir "venv"
if (-not (Test-Path $venvDir)) {
    & $pythonExe -m venv $venvDir
    Write-Host "  venv cree"
} else {
    Write-Host "  venv existe deja"
}
$venvPython = Join-Path $venvDir "Scripts\python.exe"

# --- 3. Dependances ---
Write-Host "[3/5] Installation dependances..."
& $venvPython -m pip install --upgrade pip --quiet
& $venvPython -m pip install -r (Join-Path $repoDir "requirements.txt") --quiet
Write-Host "  OK"

# --- 4. Tache planifiee ---
Write-Host "[4/5] Tache planifiee $taskName (SYSTEM, AtStartup)..."
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "  ancienne tache supprimee"
}

$action = New-ScheduledTaskAction `
    -Execute $venvPython `
    -Argument "-m uvicorn agent.main:app --host 0.0.0.0 --port $port" `
    -WorkingDirectory $repoDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Control Tower Agent (port $port)" | Out-Null
Write-Host "  OK"

# --- 5. Demarrage ---
Write-Host "[5/5] Demarrage agent..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4

try {
    $resp = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 5
    Write-Host ""
    Write-Host "=== Setup OK ===" -ForegroundColor Green
    Write-Host "Agent up - hostname: $($resp.hostname), port: $port"
    Write-Host ""
    Write-Host "Commandes utiles :"
    Write-Host "  Get-ScheduledTask $taskName"
    Write-Host "  Stop-ScheduledTask $taskName"
    Write-Host "  Start-ScheduledTask $taskName"
    Write-Host "  Invoke-RestMethod http://localhost:$port/health"
} catch {
    Write-Host ""
    Write-Host "=== Agent ne repond pas ===" -ForegroundColor Red
    Write-Host "Verifier l'etat de la tache :"
    Write-Host "  Get-ScheduledTaskInfo -TaskName $taskName"
    exit 1
}
