# contrato-bot

Bot de Telegram para que el arrendador cree contratos de arrendamiento de vivienda urbana desde el chat:
envía la foto de la cédula del arrendatario, elige con botones el inmueble, el canon, el depósito y la duración,
y recibe el contrato listo en PDF y Word.

## Cómo funciona

```
📷 Foto de la cédula ──► Claude (visión) lee nombre y número ──► ✅ confirmar
                                                                    │
           ┌────────────── ¿hay contratos anteriores? ──────────────┤
           ▼ sí                                                     ▼ no
  💡 Sugerencia completa                              Paso a paso con botones:
  [Usar sugerencia] [Paso a paso]                     🏠 Edificio   [Dir. 1] [Dir. 2] [➕ Otra]
           │                                          🚪 Apto       [201] [501] [Sin apto] [➕ Otro]
           │                                          💰 Canon      [$1.5M] [$1.3M] [➕ Otro]
           │                                          🔐 Depósito   [$500k] [Sin depósito] [➕ Otro]
           │                                          📅 Duración   [3 meses] [6 meses] [➕ Otro]
           │                                          🗓️ Inicio     [Hoy] [1 del próximo mes] [➕ Otra]
           │                                          👥 Ocupantes, 📱 celular y correo, 📬 notificación
           └──────────────────────────► 📄 Resumen [✅ Generar] [✏️ Corregir] [❌ Cancelar]
```

- **Una tarjeta por contrato:** el bot edita un solo mensaje que va mostrando lo ya respondido (con fecha de
  fin y total a pagar al iniciar) y la pregunta actual, con botón ⬅️ Atrás. Al terminar queda como constancia.
- **Canon** es el arriendo mensual (como en el contrato y la Ley 820); **depósito** es el pago único al inicio.
  Si no hay depósito, su parágrafo no aparece en el contrato.
- **Edificio y apartamento por separado:** primero se elige el edificio y luego el apartamento (los ya usados
  salen como botón). Un edificio escrito se guarda de inmediato.
- **Informe de inmuebles (`/inmuebles`):** cada edificio con su ocupación; al tocarlo, sus apartamentos con estado
  (🔴 ocupado, 🟡 vence en ≤ 30 días, 🔵 contrato por iniciar, 🟢 libre) y al tocar uno, el contrato vigente con
  botones para reenviarlo, renovarlo o hacer uno nuevo ahí. `/libres` (o escribir "apartamentos vacíos")
  muestra solo los libres. El estado sale del historial de contratos guardado en el catálogo.
- **⚙️ Ajustes:** lo que cambia o borra datos va aparte del menú normal. Cada pantalla (inmuebles, edificio,
  apartamento, contrato) tiene un botón ⚙️ Ajustes con: agregar edificios o apartamentos ("401, 402"), corregir
  la dirección de un edificio o el número de un apartamento (el historial de contratos se actualiza y el
  informe sigue cuadrando), quitar apartamentos, borrar edificios y borrar contratos (con confirmación).
- **Borrar contratos hechos por error:** `/contratos` lista los últimos (o 🗂 Contratos en cada apartamento);
  se borran desde ⚙️ Ajustes del contrato, con confirmación. Al borrarlo se deshace lo aprendido: el inmueble queda
  libre si no tiene otro contrato, el arrendatario vuelve a su contrato anterior (o se olvida) y los valores
  que solo se usaron ahí dejan de sugerirse. Los archivos ya enviados por el chat no se borran.
- **Aprende de lo que usas.** Cada dirección nueva se guarda al escribirla, y al generar un contrato se guardan
  canon, depósito, duración y los datos del arrendatario (`data/catalogo.json`). Los botones muestran primero lo
  más reciente; el canon sugerido es el último usado en ese inmueble.
- **Varios arrendatarios:** se envía una cédula por persona (hasta 4). Desde la segunda, el bot pregunta
  "👥 Agregar como otro arrendatario" o "🔄 Reemplazar". Todos aparecen en el encabezado, se obligan
  solidariamente y firman; las notificaciones van al principal. Se quitan desde ✏️ Corregir.
- **Renovar:** `/renovar` lista los últimos contratos (el que vence primero arriba); al elegir uno, el nuevo
  contrato copia todo, empieza el día siguiente al vencimiento y va sin depósito (ya se entregó). Enviar la foto
  de un arrendatario con contrato anterior propone lo mismo.
- **Sin "otro valor" obligatorio:** en cualquier paso se puede escribir directamente ("1,5 millones",
  "un año", "15 de noviembre"). Los textos se interpretan con código determinista (`src/flujo/interpretar.ts`)
  y todo dato pasa por la validación de `src/contract/schema.ts`.
- **Varios datos en un mensaje:** "apto 501, 750 mil, 200 de depósito, 3 meses desde el 15" llena todo de una vez
  y solo se pregunta lo que falta. También sirve para corregir desde el resumen ("cambia el canon a 800 mil").
  Esos mensajes los interpreta Claude (`src/ia/extractor-datos.ts`); los de un solo dato, el código local.
  Los mensajes que llegan seguidos (menos de 1,5 s entre uno y otro, p. ej. un texto pegado en varias partes) se
  juntan y se interpretan como uno solo (`src/session/agrupador.ts`).
- **Fechas con un toque:** la fecha de inicio ofrece hoy, mañana, el próximo 15 y el 1 del mes siguiente;
  "📅 Otra fecha" abre un calendario del mes con ◀️ ▶️. Al corregir un dato desde el resumen, "↩️ Volver al
  resumen" regresa sin cambiarlo.
- **Verificación antes de enviar:** el Word generado se compara con la plantilla y los datos confirmados
  (`src/contract/verificar.ts`, sin IA). Si algo no cuadra no se envía: se pide el dato que falta o se da un
  mensaje general, y el detalle queda en la bitácora.
- **Avisos de fallas:** si la IA falla 3 veces seguidas, se rechaza un contrato o hay un error al generar, el bot
  avisa por Telegram a `AVISOS_CHAT_ID` (o al chat de respaldos). `/estado` muestra si la IA responde, desde
  cuándo corre el bot, los contratos de hoy y el último respaldo.
- **Nada se pierde al reiniciar:** el contrato en curso de cada chat se guarda en `data/sesiones.json` (24 h).
- **Claude no redacta el contrato:** solo lee la foto y los mensajes libres, con salidas estructuradas. El texto
  del contrato es fijo (`templates/contrato-arrendamiento.docx`) y los valores en letras los calcula
  `numero-a-letras.ts`.
- **Bot privado:** solo responde a los IDs de `USUARIOS_AUTORIZADOS`. A cualquier otro le dice su ID.

## Puesta en marcha

Requisitos: Node 20+, y LibreOffice para generar el PDF (sin él, el bot envía solo el Word).

```bash
npm install
cp .env.example .env      # completa TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY y USUARIOS_AUTORIZADOS
npm run dev               # long polling, recarga al guardar
```

Comandos del bot: `/nuevo`, `/renovar`, `/inmuebles` (también `/direcciones`), `/libres`, `/contratos`, `/respaldo`, `/estado` y `/cancelar`. También basta con enviar la foto de una cédula para empezar.

Otros scripts:

| Script | Qué hace |
|---|---|
| `npm test` | Pruebas de validación, letras, interpretación de textos y del flujo completo con botones |
| `npm run ejemplo` | Genera un contrato con datos ficticios en `out/` (sin Telegram ni API) |
| `npm run plantilla` | Regenera la plantilla Word desde `scripts/build-template.py` (requiere `pip install python-docx`) |
| `npm run build && npm start` | Compila y ejecuta en producción |

## Cambiar el contrato

Abre `templates/contrato-arrendamiento.docx` en Word y edítalo como cualquier documento. Los campos variables
están entre llaves, por ejemplo `{precio_texto}`; no partas una llave con formatos distintos. Para agregar un
campo nuevo: añádelo en `schema.ts` (validación + etiqueta), en `construirContexto` de `render.ts` y, si se
debe preguntar, en `ORDEN` y `PREGUNTAS` de `src/flujo/asistente.ts`.

## Dejarlo corriendo en tu PC (Windows)

Con pocos usuarios y contratos, el PC propio basta: no cuesta nada y no hace falta servidor. El bot funciona
mientras el PC esté encendido y con la sesión iniciada.

1. Usa la carpeta principal del proyecto (no una copia de trabajo): ahí vive `data/` con todo lo guardado.
2. Actualiza y compila:
   ```bash
   git pull && npm ci && npm run build
   ```
3. En `.env`, si quieres PDF: `SOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe`.
4. Instala el inicio automático (una sola vez):
   ```bash
   npm run pc:instalar
   ```
   Crea la tarea "contrato-bot" en el Programador de tareas: abre el bot sin ventana al iniciar sesión y lo
   vuelve a abrir si se cae. El registro queda en `data/logs/bot-AAAA-MM.log`.
5. En Windows, Configuración → Sistema → Inicio/apagado → Suspender: **Nunca** (con el cargador conectado);
   si el PC se suspende, el bot deja de responder hasta que despierte.

Para actualizar: `git pull && npm ci && npm run build && npm run pc:reiniciar`. Para quitarlo:
`npm run pc:desinstalar`. No corras `npm run dev` al mismo tiempo: Telegram solo admite un bot conectado y
el segundo falla con "409 Conflict".

### Respaldos

- Cada 7 días el bot envía por Telegram el archivo `respaldo-contratos-AAAA-MM-DD.json` (edificios,
  apartamentos, historial de contratos y arrendatarios) a **un solo chat**: `RESPALDO_CHAT_ID`, o el primer ID de
  `USUARIOS_AUTORIZADOS` si no se define. Solo en ese chat funciona `/respaldo` para pedir uno en cualquier
  momento. Contiene datos personales: no lo reenvíes.
- Para recuperar todo en otro PC: instala el bot, copia ese archivo a `data/catalogo.json` y arráncalo.
- Los PDF y Word de cada contrato se guardan en `data/contratos/` y "📄 Reenviar" manda exactamente esos
  (los de antes de este cambio se vuelven a generar). No van en el respaldo semanal: también quedaron en el
  chat cuando se generaron.

### Bitácora de interacciones

Cada interacción queda registrada en `data/logs/interacciones/AAAA-MM-DD.jsonl` (fecha de Bogotá), una línea
JSON por evento, para poder revisar o reconstruir más adelante qué hizo cada usuario y qué respondió el bot:

| `tipo` | Qué guarda |
|---|---|
| `actualizacion` | La actualización de Telegram tal como llegó: texto, botón tocado (`callback_query.data`), comando, foto (sus `file_id`, no la imagen) |
| `salida` | Cada llamada del bot a Telegram: método (`sendMessage`, `editMessageText`, `sendDocument`…), texto, botones y el `message_id` devuelto. Los archivos, solo por nombre |
| `ia` | Lo que respondió Claude: `lector` (datos leídos de la cédula) o `extractor` (datos entendidos de un mensaje libre), con su duración |
| `estado` | Cómo quedó la conversación después de cada actualización: paso, datos del contrato en curso, estado del informe |
| `error`, `arranque` | Errores (con su traza) y cada vez que el bot arranca |

Todos llevan `v` (versión del formato), `ts` (hora UTC) y, si vienen de una actualización, `update_id`, `chat` y
`usuario`, para agruparlos por conversación. Las imágenes de las cédulas no se guardan; los logs no se borran
solos y contienen datos personales: quedan solo en este PC, dentro de `data/` (que no se sube al repositorio).

Para revisarlos en PowerShell:

```powershell
Get-Content -Encoding UTF8 data\logs\interacciones\2026-10-04.jsonl | ConvertFrom-Json | Where-Object tipo -eq 'actualizacion'
```

`data/logs/bot-AAAA-MM.log` es otra cosa: la salida de consola del bot cuando corre con `npm run pc:instalar`.

## Despliegue en un servidor

El bot usa long polling: no necesita dominio ni HTTPS, solo un equipo encendido con Node y LibreOffice.
Cualquier VPS o contenedor sirve. Ejemplo de Dockerfile mínimo:

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

`data/` guarda el catálogo (edificios, apartamentos, historial de contratos y arrendatarios): móntala como
volumen para que sobreviva a reinicios y reconstrucciones, y respáldala.

```bash
docker run -d --restart unless-stopped --env-file .env -v "$PWD/data:/app/data" contrato-bot
```

## Pendiente

- Guardar en disco el contrato a medio llenar (`SessionStore` en un JSON en `data/`; con tan pocos usuarios no
  hace falta Redis ni PostgreSQL): hoy se pierde si el bot se reinicia. El catálogo sí persiste en `data/`.
- Guardar los respaldos que llegan por Telegram: `data/` contiene datos personales de arrendatarios.
- El depósito: la Ley 820 de 2003 (art. 16) prohíbe exigir depósitos en dinero en vivienda
  urbana; validarlo con un abogado.
- Pasar de long polling a webhook si se despliega en un servicio serverless.
- Habeas data (Ley 1581 de 2012): el bot guarda nombre, cédula y contacto de los arrendatarios. Obtener su
  autorización (p. ej. una cláusula en el contrato) y definir cuánto tiempo se conservan los contratos.
- Revisión de la plantilla por un abogado.
