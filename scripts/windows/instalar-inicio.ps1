# Registra la tarea "contrato-bot" del Programador de tareas de Windows: al iniciar sesión abre el bot sin
# ventana (con iniciar-bot.ps1, que lo reinicia si se cae) y lo deja corriendo. Uso:  npm run pc:instalar
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'iniciar-bot.ps1'
$raiz = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path (Join-Path $raiz 'dist\index.js'))) { throw 'Falta compilar el bot. Ejecuta primero: npm run build' }
if (-not (Test-Path (Join-Path $raiz '.env'))) { throw 'Falta el archivo .env (copia .env.example y complétalo).' }

$accion = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $raiz `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$disparador = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'contrato-bot' -Action $accion -Trigger $disparador -Settings $ajustes `
  -Description 'Bot de contratos de arrendamiento (Telegram)' -Force | Out-Null
Start-ScheduledTask -TaskName 'contrato-bot'
Write-Host 'Listo: el bot quedó corriendo y arrancará solo cada vez que inicies sesión.'
Write-Host "Registro: $raiz\data\logs"
