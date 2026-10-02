# contrato-bot

Bot de Telegram con un agente de IA (API de Claude) que conversa con el arrendatario, recoge los datos del
contrato de arrendamiento de vivienda urbana (Carrera 105 i 67 d 31) y le devuelve el contrato lleno en PDF y Word.

## Cómo funciona

```
Telegram ──► grammY ──► ContratoAgent ──► Claude (tool use)
                             │
                             ├─ registrar_datos   → valida con zod y guarda en la sesión
                             └─ generar_contrato  → docxtemplater + LibreOffice → .docx / .pdf
```

- **El texto del contrato es fijo.** Vive en `templates/contrato-arrendamiento.docx`. El LLM nunca redacta
  cláusulas: solo extrae datos de la conversación y llama herramientas.
- **Todo dato pasa por validación** (`src/contract/schema.ts`): cédula, celular colombiano, correo, fechas
  reales, rangos razonables de canon. Si algo falla, el agente le pide al usuario que lo corrija.
- **Valores en letras deterministas** (`numero-a-letras.ts`): "UN MILLÓN QUINIENTOS MIL PESOS ($1.500.000)",
  "doce (12) meses", "dos (2) personas". No dependen del modelo.
- **Confirmación obligatoria:** el agente muestra un resumen y solo genera cuando el usuario confirma.
- **Habeas data:** antes de pedir datos, el bot solicita autorización (Ley 1581 de 2012).
- **Copia al arrendador:** si configuras `ARRENDADOR_CHAT_ID`, cada contrato generado le llega también a él.

## Puesta en marcha

Requisitos: Node 20+, y LibreOffice para generar el PDF (sin él, el bot envía solo el Word).

```bash
npm install
cp .env.example .env      # completa TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY y los datos del arrendador
npm run dev               # long polling, recarga al guardar
```

Comandos del bot: `/start`, `/nuevo`, `/cancelar`.

Otros scripts:

| Script | Qué hace |
|---|---|
| `npm test` | Pruebas de validación, letras y del ciclo del agente con un cliente simulado |
| `npm run ejemplo` | Genera un contrato con datos ficticios en `out/` (sin Telegram ni API) |
| `npm run plantilla` | Regenera la plantilla Word desde `scripts/build-template.py` |
| `npm run build && npm start` | Compila y ejecuta en producción |

## Cambiar el contrato

Abre `templates/contrato-arrendamiento.docx` en Word y edítalo como cualquier documento. Los campos variables
están entre llaves, por ejemplo `{canon_texto}`; no partas una llave con formatos distintos. Para agregar un
campo nuevo: añádelo en `schema.ts` (validación + descripción) y en `construirContexto` de `render.ts`.

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

- Cambiar `InMemorySessionStore` por Redis o PostgreSQL (implementa la interfaz `SessionStore`); hoy las
  sesiones se pierden al reiniciar.
- Pasar de long polling a webhook si se despliega en un servicio serverless.
- Política de tratamiento de datos publicada (enlace en el mensaje de autorización) y retención de contratos.
- Revisión de la plantilla por un abogado.
