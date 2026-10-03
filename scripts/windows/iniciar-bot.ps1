# Mantiene el bot corriendo en este PC: si se cierra o falla, lo vuelve a abrir a los 10 segundos.
# El registro queda en data/logs/bot-AAAA-MM.log. Lo lanza la tarea de Windows (instalar-inicio.ps1);
# también se puede correr a mano:  powershell -ExecutionPolicy Bypass -File scripts\windows\iniciar-bot.ps1
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $raiz

$logs = Join-Path $raiz 'data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

if (-not (Test-Path (Join-Path $raiz 'dist\index.js'))) {
  Write-Host 'Falta compilar el bot. Ejecuta primero: npm run build'
  exit 1
}

while ($true) {
  $log = Join-Path $logs ('bot-{0}.log' -f (Get-Date -Format 'yyyy-MM'))
  Add-Content -Encoding utf8 $log "`n=== $(Get-Date -Format s) Iniciando bot ==="
  # cmd escribe la salida de Node tal cual (UTF-8); PowerShell 5.1 la recodifica y envuelve los errores.
  cmd /c "node dist\index.js >> `"$log`" 2>&1"
  Add-Content -Encoding utf8 $log "=== $(Get-Date -Format s) El bot se cerró (código $LASTEXITCODE). Reinicio en 10 s ==="
  Start-Sleep -Seconds 10
}
