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
- **Claude no redacta el contrato:** solo lee la foto y los mensajes libres, con salidas estructuradas. El texto
  del contrato es fijo (`templates/contrato-arrendamiento.docx`) y los valores en letras los calcula
  `numero-a-letras.ts`.
- **Bot privado:** solo responde a los IDs de `USUARIOS_AUTORIZADOS`. A cualquier otro le dice su ID.

## Puesta en marcha

Requisitos: Node 20+, y LibreOffice para generar el PDF (sin él, el bot envía solo el Word).

```bash
npm install
cp .env.example .env      # completa TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, y USUARIOS_AUTORIZADOS
npm run dev               # long polling, recarga al guardar
```

Comandos del bot: `/nuevo`, `/renovar`, `/inmuebles` (también `/direcciones`), `/libres`, `/contratos` y `/cancelar`. También basta con enviar la foto de una cédula para empezar.

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

## Despliegue

Cualquier VPS o contenedor con LibreOffice sirve. Ejemplo de Dockerfile mínimo:

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

## Pendiente para producción

- Cambiar `InMemorySessionStore` por Redis o PostgreSQL (implementa la interfaz `SessionStore`); hoy un
  contrato a medio llenar se pierde al reiniciar (el catálogo sí persiste en `data/`).
- Respaldar `data/catalogo.json`: contiene datos personales de arrendatarios.
- El depósito: la Ley 820 de 2003 (art. 16) prohíbe exigir depósitos en dinero en vivienda
  urbana; validarlo con un abogado.
- Pasar de long polling a webhook si se despliega en un servicio serverless.
- Política de tratamiento de datos publicada (enlace en el mensaje de autorización) y retención de contratos.
- Revisión de la plantilla por un abogado.
