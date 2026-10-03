import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { LectorDocumento } from './lector-documento.js';

/** Cliente falso: `messages.parse` devuelve la lectura dada como salida estructurada. */
function clienteFalso(lectura: Record<string, unknown> | null, stop_reason = 'end_turn') {
  const llamadas: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        llamadas.push(params);
        return { content: [], stop_reason, parsed_output: lectura };
      },
    },
  } as unknown as Anthropic;
  return { client, llamadas };
}

const vacia = { tipo_documento: null, numero: null, nombres: null, apellidos: null, observacion: null };

test('envía la imagen con salida estructurada y une nombres y apellidos', async () => {
  const { client, llamadas } = clienteFalso({
    ...vacia,
    legible: true,
    tipo_documento: 'CC',
    numero: '1.020.345.678',
    nombres: 'LAURA',
    apellidos: 'GÓMEZ PÉREZ',
  });
  const doc = await new LectorDocumento(client, 'modelo').leer(Buffer.from('jpg'), 'image/jpeg');
  assert.deepEqual(doc, { nombre: 'LAURA GÓMEZ PÉREZ', numero: '1.020.345.678', tipo: 'CC' });

  const pedido = llamadas[0] as unknown as Anthropic.MessageCreateParams;
  assert.equal(pedido.tool_choice, undefined, 'este modelo no admite forzar herramientas');
  assert.equal((pedido.output_config?.format as { type: string }).type, 'json_schema');
  const contenido = pedido.messages[0]!.content as Anthropic.ContentBlockParam[];
  assert.equal(contenido[0]!.type, 'image');
});

test('si no es legible devuelve la observación', async () => {
  const { client } = clienteFalso({ ...vacia, legible: false, observacion: 'la foto está borrosa' });
  const doc = await new LectorDocumento(client, 'modelo').leer(Buffer.from('jpg'), 'image/jpeg');
  assert.equal(doc.observacion, 'la foto está borrosa');
});

test('una negativa del modelo se trata como no legible', async () => {
  const { client } = clienteFalso(null, 'refusal');
  const doc = await new LectorDocumento(client, 'modelo').leer(Buffer.from('jpg'), 'image/jpeg');
  assert.ok(doc.observacion);
});
