import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Salud, vigilarIA } from './salud.js';

function crear() {
  const avisos: string[] = [];
  let ahora = 1_000_000;
  const salud = new Salud(async (t) => void avisos.push(t), 3, 30 * 60 * 1000, () => ahora);
  return { salud, avisos, avanzar: (ms: number) => (ahora += ms) };
}

test('salud: avisa una vez al llegar a 3 fallas seguidas de la IA, y cuando vuelve', async () => {
  const { salud, avisos } = crear();
  const caida = vigilarIA(async () => Promise.reject(new Error('401 invalid x-api-key')), salud);
  const ok = vigilarIA(async () => 'bien', salud);

  for (let i = 0; i < 2; i++) await assert.rejects(caida());
  assert.equal(avisos.length, 0, 'dos fallas sueltas no avisan');
  await assert.rejects(caida());
  await assert.rejects(caida());
  assert.equal(avisos.length, 1, 'avisa una sola vez');
  assert.match(avisos[0]!, /La IA falló 3 veces seguidas\.\n401 invalid x-api-key/);
  assert.equal(salud.iaFallando, true);

  assert.equal(await ok(), 'bien');
  assert.match(avisos[1]!, /La IA volvió a responder/);
  assert.equal(salud.iaFallando, false);
  assert.ok(salud.ultimoErrorIA);
});

test('salud: una falla suelta seguida de un éxito no avisa', async () => {
  const { salud, avisos } = crear();
  salud.falloIA(new Error('timeout'));
  salud.exitoIA();
  assert.deepEqual(avisos, []);
});

test('salud: los errores se espacian; los rechazos de contratos se avisan siempre', async () => {
  const { salud, avisos, avanzar } = crear();
  salud.error('generando', new Error('a'));
  salud.error('generando', new Error('b'));
  assert.equal(avisos.length, 1, 'el segundo error dentro de 30 min no avisa');
  avanzar(31 * 60 * 1000);
  salud.error('generando', new Error('c'));
  assert.equal(avisos.length, 2);

  salud.contratoRechazado('LAURA · Calle 1');
  salud.contratoRechazado('PEDRO · Calle 2');
  assert.equal(avisos.filter((a) => a.includes('no pasó la verificación')).length, 2);
  assert.equal(salud.rechazados, 2);
});
