# Detiene el bot de este proyecto. Con -Desinstalar también quita la tarea de inicio automático.
#   npm run pc:reiniciar     -> cierra el bot; la tarea lo vuelve a abrir en 10 s (p. ej. tras actualizar)
#   npm run pc:desinstalar   -> lo cierra y quita el inicio automático
param([switch]$Desinstalar)
$raiz = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if ($Desinstalar) {
  Stop-ScheduledTask -TaskName 'contrato-bot' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'contrato-bot' -Confirm:$false -ErrorAction SilentlyContinue
  # El ciclo de iniciar-bot.ps1 también se cierra para que no lo vuelva a abrir.
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*iniciar-bot.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$bots = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist*index.js*' -and $_.CommandLine -notlike '*tsx*' }
foreach ($p in $bots) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

if ($Desinstalar) { Write-Host 'Bot detenido y sin inicio automático.' }
elseif ($bots) { Write-Host 'Bot cerrado; la tarea lo vuelve a abrir en unos 10 segundos.' }
else { Write-Host 'No había un bot corriendo.' }
Write-Host "Carpeta: $raiz"
