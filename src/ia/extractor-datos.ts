import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import type { ContextoExtraccion, DatosExtraidos, Extractor } from '../flujo/asistente.js';

/** Todo es nullable: null = el mensaje no lo menciona. La validación de cada campo la hace el asistente. */
const Esquema = z.object({
  arrendatario_nombre: z.string().nullable().describe('Nombre completo del arrendatario.'),
  arrendatario_tipo_documento: z.enum(['CC', 'CE', 'PA', 'PPT']).nullable(),
  arrendatario_numero_documento: z.string().nullable().describe('Solo dígitos/letras, sin puntos.'),
  inmueble_direccion: z
    .string()
    .nullable()
    .describe('Dirección completa del inmueble: "<edificio> apto <número>" o la de la casa.'),
  apartamento: z.string().nullable().describe('Solo el número de apartamento, cuando no se dice el edificio.'),
  precio_mensual: z.number().int().nullable().describe('Arriendo mensual en pesos colombianos.'),
  deposito: z.number().int().nullable().describe('Canon / depósito inicial en pesos. 0 si dicen "sin canon".'),
  duracion_meses: z.number().int().nullable(),
  fecha_inicio: z.string().nullable().describe('AAAA-MM-DD'),
  numero_ocupantes: z.number().int().nullable(),
  arrendatario_celular: z.string().nullable(),
  arrendatario_correo: z.string().nullable(),
  arrendatario_direccion: z.string().nullable().describe('Dirección de notificación del arrendatario.'),
});

function instrucciones(c: ContextoExtraccion): string {
  return `Eres el intérprete de un bot que arma contratos de arrendamiento en Colombia. El arrendador escribió \
un mensaje con datos del contrato. Devuelve solo lo que el mensaje dice explícitamente y null en todo lo demás; \
nunca inventes ni completes datos que no aparecen.

Reglas:
- "Precio" o "arriendo" es el valor mensual. "Canon" o "depósito" es un pago único al inicio (son distintos).
- Montos en pesos colombianos, enteros: "750 mil" = 750000, "1,5 millones" = 1500000. Un número suelto \
pequeño junto a precio/canon se entiende en miles ("200 de canon" = 200000).
- Duración en meses: "un año" = 12.
- Fechas en AAAA-MM-DD. Hoy es ${c.hoy}. Si no dicen mes o año, usa la próxima fecha futura que coincida \
("desde el 15" = el próximo día 15).
- Inmueble: los edificios guardados son ${c.edificios.length ? c.edificios.map((e) => `"${e}"`).join(', ') : '(ninguno)'}. \
Si mencionan uno (aunque sea parcialmente) y un apartamento, devuelve inmueble_direccion como "<edificio> apto <n>". \
Si solo dicen el apartamento, devuelve "apartamento".
${c.pregunta ? `- El bot acababa de preguntar: "${c.pregunta}". Un dato suelto probablemente responde a eso.` : ''}`;
}

/** Extrae varios datos del contrato de un mensaje libre ("apto 501, 750 mil, 3 meses desde el 15"). */
export class ExtractorDatos implements Extractor {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async extraer(texto: string, contexto: ContextoExtraccion): Promise<DatosExtraidos> {
    const respuesta = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: instrucciones(contexto),
      output_config: { format: zodOutputFormat(Esquema), effort: 'low' },
      messages: [{ role: 'user', content: texto }],
    });
    if (respuesta.stop_reason === 'refusal' || !respuesta.parsed_output) return {};
    // Solo valores presentes (null = no lo mencionó).
    return Object.fromEntries(
      Object.entries(respuesta.parsed_output).filter(([, v]) => v !== null && v !== ''),
    ) as DatosExtraidos;
  }
}
