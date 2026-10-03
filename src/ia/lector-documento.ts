import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import type { DocumentoDetectado } from '../flujo/asistente.js';

export type TipoImagen = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const INSTRUCCIONES = `Extrae los datos del documento de identidad colombiano que aparece en la imagen.

- Cédula de ciudadanía amarilla (con hologramas): el número va arriba ("NÚMERO 1.020.345.678"), luego \
APELLIDOS y NOMBRES en renglones separados.
- Cédula digital: el número aparece como "NUIP"; apellidos y nombres en campos separados.
- Cédula de extranjería, pasaporte y PPT también son válidos.

Copia el número y los nombres exactamente como aparecen, sin inventar ni completar letras que no se \
ven. Si la imagen no es un documento de identidad o el número o el nombre no se leen con seguridad, \
pon legible=false y explica brevemente en observacion qué pasó (ej. "la foto está borrosa").`;

const Lectura = z.object({
  legible: z.boolean().describe('true si el número y el nombre completo se leen con seguridad.'),
  tipo_documento: z
    .enum(['CC', 'CE', 'PA', 'PPT'])
    .nullable()
    .describe('CC cédula de ciudadanía, CE cédula de extranjería, PA pasaporte, PPT permiso por protección temporal.'),
  numero: z.string().nullable().describe('Número del documento tal como aparece.'),
  nombres: z.string().nullable(),
  apellidos: z.string().nullable(),
  observacion: z.string().nullable().describe('Si legible=false, qué impidió leerlo.'),
});

/** Lee la foto de un documento de identidad con Claude (visión) y devuelve los datos estructurados. */
export class LectorDocumento {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async leer(imagen: Buffer, tipo: TipoImagen): Promise<DocumentoDetectado> {
    const respuesta = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(Lectura), effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: tipo, data: imagen.toString('base64') } },
            { type: 'text', text: INSTRUCCIONES },
          ],
        },
      ],
    });

    const l = respuesta.parsed_output;
    if (respuesta.stop_reason === 'refusal' || !l) return { observacion: 'no se obtuvo respuesta del lector' };

    const nombre = [l.nombres, l.apellidos].filter(Boolean).join(' ').trim() || undefined;
    const numero = l.numero ?? undefined;
    const tipoDoc = l.tipo_documento ?? undefined;
    if (!l.legible) return { nombre, numero, tipo: tipoDoc, observacion: l.observacion ?? 'no se lee bien' };
    return { nombre, numero, tipo: tipoDoc ?? 'CC' };
  }
}
