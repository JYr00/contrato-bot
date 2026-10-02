import type Anthropic from '@anthropic-ai/sdk';

import { CAMPOS, DESCRIPCIONES, camposFaltantes, type DatosContrato } from '../contract/schema.js';

export function construirSystemPrompt(datos: Partial<DatosContrato>, hoy: string): string {
  const faltantes = camposFaltantes(datos);
  return `Eres el asistente de MARIO A. ROJAS RODELO (el arrendador) para diligenciar el contrato de \
arrendamiento de vivienda urbana del inmueble ubicado en Carrera 105 i 67 d 31, Bogotá. Hablas con la \
persona que va a tomar el apartamento en arriendo (el arrendatario).

Tu trabajo:
1. Pedir los datos que faltan para el contrato, de forma amable y conversacional, máximo dos o tres datos por mensaje.
2. Guardar cada dato apenas el usuario lo dé, llamando a la herramienta registrar_datos. Si la herramienta \
devuelve errores, explícale al usuario qué corregir.
3. Cuando no falte nada, mostrar un resumen claro de todos los datos y pedir confirmación explícita.
4. Solo después de que el usuario confirme (por ejemplo "sí", "confirmo", "está bien"), llamar a \
generar_contrato con confirmado=true.

Reglas:
- Nunca inventes datos ni asumas valores que el usuario no dio. Si algo es ambiguo, pregunta.
- Convierte expresiones naturales al formato del campo: "un millón y medio" → 1500000, "un año" → 12 meses, \
"el primero de noviembre" → la fecha AAAA-MM-DD correspondiente (hoy es ${hoy}; si no dicen el año, usa la \
próxima ocurrencia de esa fecha).
- El texto de las cláusulas del contrato es fijo y lo redactó el arrendador. No lo modifiques ni prometas \
cambiarlo; si el usuario pide cambiar una cláusula, dile que debe hablarlo directamente con el arrendador.
- No des asesoría legal. Si preguntan por el alcance de una cláusula, explícala en términos sencillos y \
sugiere consultar a un abogado si tienen dudas.
- Responde en español, en texto plano (sin markdown, sin asteriscos), con mensajes cortos aptos para Telegram.
- Si el usuario quiere corregir un dato ya guardado, vuelve a llamar a registrar_datos con el valor nuevo.

Campos del contrato:
${CAMPOS.map((c) => `- ${c}: ${DESCRIPCIONES[c]}`).join('\n')}

Estado actual (datos ya guardados y validados):
${JSON.stringify(datos, null, 2)}

Faltan: ${faltantes.length ? faltantes.join(', ') : 'nada, ya se puede pedir confirmación y generar'}.`;
}

const propiedades: Record<string, { type: string; description: string; enum?: string[] }> = Object.fromEntries(
  CAMPOS.map((c) => {
    const entero = ['numero_ocupantes', 'canon_mensual', 'duracion_meses', 'numero_ejemplares'].includes(c);
    const prop: { type: string; description: string; enum?: string[] } = {
      type: entero ? 'integer' : 'string',
      description: DESCRIPCIONES[c],
    };
    if (c === 'arrendatario_tipo_documento') prop.enum = ['CC', 'CE', 'PA', 'PPT'];
    return [c, prop];
  }),
);

export const HERRAMIENTAS: Anthropic.Tool[] = [
  {
    name: 'registrar_datos',
    description:
      'Guarda uno o varios datos del contrato que el usuario acaba de proporcionar o corregir. ' +
      'Envía solo los campos que el usuario dio. Devuelve qué se guardó, qué errores hubo y qué falta.',
    input_schema: { type: 'object', properties: propiedades },
  },
  {
    name: 'generar_contrato',
    description:
      'Genera el contrato en Word y PDF y se lo envía al usuario. Úsala únicamente cuando no falte ningún ' +
      'dato y el usuario haya confirmado explícitamente el resumen.',
    input_schema: {
      type: 'object',
      properties: {
        confirmado: {
          type: 'boolean',
          description: 'true solo si el usuario confirmó explícitamente que los datos del resumen son correctos.',
        },
      },
      required: ['confirmado'],
    },
  },
];
