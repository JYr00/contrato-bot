import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { ContractRenderer } from '../contract/render.js';
import { nuevaSesion } from '../session/store.js';
import { ContratoAgent } from './contrato-agent.js';

/** Cliente falso: devuelve respuestas guionizadas y registra lo que recibe. */
function clienteFalso(guion: Anthropic.ContentBlock[][]) {
  const llamadas: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        llamadas.push(structuredClone(params));
        const content = guion.shift();
        if (!content) throw new Error('Guion agotado');
        const usaHerramienta = content.some((b) => b.type === 'tool_use');
        return { content, stop_reason: usaHerramienta ? 'tool_use' : 'end_turn' };
      },
    },
  } as unknown as Anthropic;
  return { client, llamadas };
}

const herramienta = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;
const texto = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;

const datosCompletos = {
  arrendatario_nombre: 'Laura Gómez Pérez',
  arrendatario_tipo_documento: 'CC',
  arrendatario_numero_documento: '1020345678',
  apartamento: '201',
  numero_ocupantes: 2,
  canon_mensual: 1500000,
  duracion_meses: 12,
  fecha_inicio: '2026-11-01',
  arrendatario_direccion: 'Carrera 105 i 67 d 31 apto 201',
  arrendatario_correo: 'laura@example.com',
  arrendatario_celular: '3105551234',
};

test('el agente guarda datos, rechaza generar sin confirmar y luego genera', async () => {
  const plantilla = await readFile('templates/contrato-arrendamiento.docx');
  const renderer = new ContractRenderer(plantilla, { correo: 'mario@example.com', celular: '3001112233' }, '/no/existe');
  const { client, llamadas } = clienteFalso([
    [herramienta('t1', 'registrar_datos', { ...datosCompletos, arrendatario_correo: 'malo' })],
    [texto('Tu correo no es válido, ¿me lo confirmas?')],
    [herramienta('t2', 'registrar_datos', { arrendatario_correo: 'laura@example.com' })],
    [herramienta('t3', 'generar_contrato', { confirmado: false })],
    [texto('¿Confirmas los datos?')],
    [herramienta('t4', 'generar_contrato', { confirmado: true })],
    [texto('¡Listo! Aquí está tu contrato.')],
  ]);
  const agent = new ContratoAgent(client, 'modelo-falso', renderer);
  const session = nuevaSesion(1, { numero_ejemplares: 2 });

  const r1 = await agent.responder(session, 'Soy Laura Gómez Pérez, CC 1020345678…');
  assert.equal(r1.texto, 'Tu correo no es válido, ¿me lo confirmas?');
  assert.equal(session.datos.arrendatario_correo, undefined);
  assert.equal(session.datos.arrendatario_nombre, 'LAURA GÓMEZ PÉREZ');

  const r2 = await agent.responder(session, 'laura@example.com');
  assert.equal(r2.contrato, undefined, 'no debe generar sin confirmación');

  const r3 = await agent.responder(session, 'Sí, confirmo');
  assert.ok(r3.contrato, 'debe generar el contrato');
  assert.ok(r3.contrato.docx.length > 1000);
  assert.equal(r3.contrato.pdf, null, 'sin LibreOffice el PDF es null y no rompe el flujo');
  assert.equal(session.contratosGenerados, 1);

  // El historial que ve el modelo debe tener cada tool_use seguido de su tool_result.
  const ultima = llamadas.at(-1)!;
  const resultados = ultima.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [],
  );
  assert.equal(resultados.length, 4);
});

test('si la API falla, el historial queda como estaba', async () => {
  const renderer = new ContractRenderer(Buffer.alloc(0), { correo: '', celular: '' });
  const client = { messages: { create: async () => { throw new Error('caída'); } } } as unknown as Anthropic;
  const agent = new ContratoAgent(client, 'x', renderer);
  const session = nuevaSesion(1);
  await assert.rejects(agent.responder(session, 'hola'));
  assert.equal(session.messages.length, 0);
});
