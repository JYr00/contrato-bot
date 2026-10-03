import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { LectorDocumento } from './lector-documento.js';

/** Cliente falso que responde con la lectura dada y registra la petición. */
function clienteFalso(lectura: Record<string, unknown>) {
  const llamadas: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        llamadas.push(params);
        return { content: [{ type: 'tool_use', id: 't1', name: 'registrar_documento', input: lectura }], stop_reason: 'tool_use' };
      },
    },
  } as unknown as Anthropic;
  return { client, llamadas };
}

test('envía la imagen y une nombres y apellidos', async () => {
  const { client, llamadas } = clienteFalso({
    legible: true,
    tipo_documento: 'CC',
    numero: '1.020.345.678',
    nombres: 'LAURA',
    apellidos: 'GÓMEZ PÉREZ',
  });
  const doc = await new LectorDocumento(client, 'modelo').leer(Buffer.from('jpg'), 'image/jpeg');
  assert.deepEqual(doc, { nombre: 'LAURA GÓMEZ PÉREZ', numero: '1.020.345.678', tipo: 'CC' });

  const pedido = llamadas[0]!;
  assert.deepEqual(pedido.tool_choice, { type: 'tool', name: 'registrar_documento' });
  const contenido = pedido.messages[0]!.content as Anthropic.ContentBlockParam[];
  assert.equal(contenido[0]!.type, 'image');
});

test('si no es legible devuelve la observación', async () => {
  const { client } = clienteFalso({ legible: false, observacion: 'la foto está borrosa' });
  const doc = await new LectorDocumento(client, 'modelo').leer(Buffer.from('jpg'), 'image/jpeg');
  assert.equal(doc.observacion, 'la foto está borrosa');
});
