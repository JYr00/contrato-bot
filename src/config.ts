import 'dotenv/config';
import { z } from 'zod';

const esquema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Falta TELEGRAM_BOT_TOKEN'),
  ANTHROPIC_API_KEY: z.string().min(1, 'Falta ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  ARRENDADOR_CORREO: z.string().default(''),
  ARRENDADOR_CELULAR: z.string().default(''),
  /** IDs de Telegram (separados por coma) que pueden usar el bot. Vacío = nadie, el bot responde con el ID. */
  USUARIOS_AUTORIZADOS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    ),
  CATALOGO_PATH: z.string().default('data/catalogo.json'),
  /** Único chat que recibe los respaldos (y donde funciona /respaldo). Vacío = el primer usuario autorizado. */
  RESPALDO_CHAT_ID: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? Number(v) : undefined)),
  SOFFICE_PATH: z.string().default('soffice'),
  PLANTILLA_PATH: z.string().default('templates/contrato-arrendamiento.docx'),
});

const parsed = esquema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuración inválida:\n' + parsed.error.issues.map((i) => `- ${i.message}`).join('\n'));
  process.exit(1);
}

export const config = parsed.data;
