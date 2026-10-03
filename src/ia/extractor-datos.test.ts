import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { ExtractorDatos } from './extractor-datos.js';

test('pide salida estructurada y descarta lo que el mensaje no menciona', async () => {
  const llamadas: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      parse: async (params: Anthropic.MessageCreateParams) => {
        llamadas.push(params);
        const parsed_output = { precio_mensual: 750_000, deposito: 0, arrendatario_correo: '', fecha_inicio: null };
        return { content: [], stop_reason: 'end_turn', parsed_output };
      },
    },
  } as unknown as Anthropic;

  const datos = await new ExtractorDatos(client, 'modelo').extraer('750 mil sin canon', {
    hoy: '2026-10-02',
    edificios: ['Carrera 105 i 67 d 31, Bogotá'],
    pregunta: '💰 ¿Cuál es el precio del arriendo mensual?',
  });
  assert.deepEqual(datos, { precio_mensual: 750_000, deposito: 0 }, 'el 0 del canon se conserva');

  const pedido = llamadas[0]!;
  assert.equal(pedido.tool_choice, undefined, 'este modelo no admite forzar herramientas');
  assert.equal((pedido.output_config?.format as { type: string }).type, 'json_schema');
  assert.match(String(pedido.system), /Hoy es 2026-10-02/);
  assert.match(String(pedido.system), /"Carrera 105 i 67 d 31, Bogotá"/);
  assert.match(String(pedido.system), /acababa de preguntar/);
});

test('una negativa del modelo no aporta datos', async () => {
  const client = {
    messages: { parse: async () => ({ content: [], stop_reason: 'refusal', parsed_output: null }) },
  } as unknown as Anthropic;
  assert.deepEqual(await new ExtractorDatos(client, 'modelo').extraer('x', { hoy: '2026-10-02', edificios: [] }), {});
});
