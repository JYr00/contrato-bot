import type Anthropic from '@anthropic-ai/sdk';

import type { DocumentoDetectado } from '../flujo/asistente.js';

export type TipoImagen = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const INSTRUCCIONES = `Extrae los datos del documento de identidad colombiano que aparece en la imagen y \
llama a la herramienta registrar_documento.

- Cédula de ciudadanía amarilla (con hologramas): el número va arriba ("NÚMERO 1.020.345.678"), luego \
APELLIDOS y NOMBRES en renglones separados.
- Cédula digital: el número aparece como "NUIP"; apellidos y nombres en campos separados.
- Cédula de extranjería, pasaporte y PPT también son válidos.

Copia el número y los nombres exactamente como aparecen, sin inventar ni completar letras que no se \
ven. Si la imagen no es un documento de identidad o el número o el nombre no se leen con seguridad, \
pon legible=false y explica brevemente en observacion qué pasó (ej. "la foto está borrosa").`;

const HERRAMIENTA: Anthropic.Tool = {
  name: 'registrar_documento',
  description: 'Registra los datos leídos del documento de identidad.',
  input_schema: {
    type: 'object',
    properties: {
      legible: { type: 'boolean', description: 'true si el número y el nombre completo se leen con seguridad.' },
      tipo_documento: {
        type: 'string',
        enum: ['CC', 'CE', 'PA', 'PPT'],
        description: 'CC cédula de ciudadanía, CE cédula de extranjería, PA pasaporte, PPT permiso por protección temporal.',
      },
      numero: { type: 'string', description: 'Número del documento tal como aparece.' },
      nombres: { type: 'string' },
      apellidos: { type: 'string' },
      observacion: { type: 'string', description: 'Si legible=false, qué impidió leerlo.' },
    },
    required: ['legible'],
  },
};

interface Lectura {
  legible: boolean;
  tipo_documento?: DocumentoDetectado['tipo'];
  numero?: string;
  nombres?: string;
  apellidos?: string;
  observacion?: string;
}

/** Lee la foto de un documento de identidad con Claude (visión) y devuelve los datos estructurados. */
export class LectorDocumento {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async leer(imagen: Buffer, tipo: TipoImagen): Promise<DocumentoDetectado> {
    const respuesta = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      tools: [HERRAMIENTA],
      tool_choice: { type: 'tool', name: HERRAMIENTA.name },
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

    const uso = respuesta.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uso) return { observacion: 'no se obtuvo respuesta del lector' };
    const l = uso.input as Lectura;

    const nombre = [l.nombres, l.apellidos].filter(Boolean).join(' ').trim() || undefined;
    if (!l.legible) return { nombre, numero: l.numero, tipo: l.tipo_documento, observacion: l.observacion };
    return { nombre, numero: l.numero, tipo: l.tipo_documento ?? 'CC' };
  }
}
