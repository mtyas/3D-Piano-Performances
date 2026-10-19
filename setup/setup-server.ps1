<#
.SYNOPSIS
  One-step setup for the 3D Piano Performances stage server on Windows.
.EXAMPLE
  .\setup\setup-server.ps1
  .\setup\setup-server.ps1 -Origin https://stage.example.com -Port 8765 -Name "Your Name" -StartAtLogon
.NOTES
  Creates .venv, installs dependencies, generates a private performer password and writes server.env.
  Double-click setup\setup-server.cmd to run it without changing the PowerShell execution policy.
#>
param(
  [string]$Origin = "",
  [string]$Port = "",
  [string]$Name = "",
  [switch]$StartAtLogon,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Ask([string]$Value, [string]$Prompt, [string]$Default) {
  if ($Value) { return $Value }
  if ($Yes) { return $Default }
  $answer = Read-Host "$Prompt [$Default]"
  if ($answer) { return $answer } else { return $Default }
}

# Prefer the Python launcher (py.exe) that the python.org installer adds.
$Python = $null
foreach ($candidate in @(@("py", "-3"), @("python"), @("python3"))) {
  $exe = Get-Command $candidate[0] -ErrorAction SilentlyContinue
  if (-not $exe) { continue }
  $extra = @($candidate | Select-Object -Skip 1)
  & $exe.Source @extra -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
  if ($LASTEXITCODE -eq 0) { $Python = @($exe.Source) + $extra; break }
}
if (-not $Python) {
  throw "Python 3.9+ is required. Install it from https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH') and run this again."
}

Write-Host "==> Creating virtual environment in .venv"
$pyExe = $Python[0]; $pyArgs = @($Python | Select-Object -Skip 1)
& $pyExe @pyArgs -m venv .venv
if ($LASTEXITCODE -ne 0) { throw "Could not create the virtual environment." }
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
& $VenvPython -m pip install --quiet --upgrade pip
& $VenvPython -m pip install --quiet -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Installing dependencies failed." }

$Port = Ask $Port "Port for the stage server" "8765"
$Origin = (Ask $Origin "Public URL visitors will use (exact origin, no path)" "http://localhost:$Port").TrimEnd("/")
$Name = Ask $Name "Performer name shown on archived recordings" "Pianist"
if ($Origin -notmatch '^https?://[^/]+$') { throw "Origin must look like https://stage.example.com (no path)." }
if ($Port -notmatch '^\d+$') { throw "Port must be a number." }
if ("$Name$Root" -match "['""``\$]") { throw "The performer name and install folder must not contain quotes, backticks or `$." }

$PasswordFile = Join-Path $Root ".performer-password"
$NewPassword = $false
if (-not (Test-Path $PasswordFile) -or (Get-Item $PasswordFile).Length -eq 0) {
  Write-Host "==> Generating a private performer password"
  $secret = & $VenvPython -c "import secrets; print(secrets.token_urlsafe(24))"
  Set-Content -Path $PasswordFile -Value $secret -NoNewline -Encoding ascii
  $NewPassword = $true
}
# Readable only by the current user.
icacls $PasswordFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

$ArchiveDir = Join-Path $Root "archives"
New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null
@"
# Written by setup\setup-server.ps1. Private: not committed to Git.
PORT='$Port'
HOST=0.0.0.0
PUBLIC_ORIGIN='$Origin'
PERFORMER_NAME='$Name'
PERFORMER_PASSWORD_FILE='$PasswordFile'
ARCHIVE_DIR='$ArchiveDir'
"@ | Set-Content -Path (Join-Path $Root "server.env") -Encoding utf8

if ($StartAtLogon) {
  Write-Host "==> Registering a scheduled task that starts the server when you sign in"
  $runner = Join-Path $PSScriptRoot "run-server.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  Register-ScheduledTask -TaskName "PianoStageServer" -Action $action -Trigger $trigger -Description "3D Piano Performances stage server" -Force | Out-Null
}

Write-Host ""
Write-Host "Setup complete."
if ($NewPassword) {
  Write-Host "Performer password (save it in your password manager; it is stored in .performer-password):"
  Write-Host "    $(Get-Content $PasswordFile)"
}
Write-Host "Start the server:  double-click setup\run-server.cmd  (or .\setup\run-server.ps1)"
Write-Host "Then open:         http://localhost:$Port   (public URL: $Origin)"
Write-Host "Visitors on other computers need Windows Firewall to allow TCP port $Port (Windows asks the first time)."
