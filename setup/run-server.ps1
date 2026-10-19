# Start the stage server with the settings written by setup-server.ps1.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) { throw "Run setup\setup-server.cmd first." }
$envFile = Join-Path $Root "server.env"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match "^\s*([A-Z_]+)=(.*)$") {
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")) { $value = $value.Substring(1, $value.Length - 2) }
      Set-Item -Path "Env:$($Matches[1])" -Value $value
    }
  }
}
& $VenvPython server.py
