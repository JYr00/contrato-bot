import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AgrupadorMensajes } from './agrupador.js';
import { ArchivoSessionStore } from './store.js';

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('sesiones en archivo: sobreviven a un reinicio y las vencidas se descartan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sesiones-'));
  try {
    const ruta = join(dir, 'sub', 'sesiones.json');
    const store = await ArchivoSessionStore.abrir(ruta);
    const s = await store.get(10);
    s.estado.paso = 'precio';
    s.estado.datos.arrendatario_nombre = 'LAURA GÓMEZ PÉREZ';
    s.tarjetaId = 99;
    await store.save(s);

    // "Reinicio": otra instancia lee el mismo archivo y sigue donde iba.
    const otra = await ArchivoSessionStore.abrir(ruta);
    const recuperada = await otra.get(10);
    assert.equal(recuperada.estado.paso, 'precio');
    assert.equal(recuperada.estado.datos.arrendatario_nombre, 'LAURA GÓMEZ PÉREZ');
    assert.equal(recuperada.tarjetaId, 99);
    assert.equal(recuperada.estado.documentoParcial, undefined, 'los campos nuevos quedan con su valor inicial');

    // /cancelar (reset) también queda guardado.
    await otra.reset(10);
    assert.equal((await (await ArchivoSessionStore.abrir(ruta)).get(10)).estado.paso, 'inicio');

    // Una sesión de hace más de un día se descarta al abrir.
    const vieja = JSON.parse(await readFile(ruta, 'utf8'));
    vieja[0].actualizado = Date.now() - 2 * 24 * 60 * 60 * 1000;
    vieja[0].estado.paso = 'precio';
    await writeFile(ruta, JSON.stringify(vieja));
    assert.equal((await (await ArchivoSessionStore.abrir(ruta)).get(10)).estado.paso, 'inicio');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sesiones en archivo: un archivo dañado no impide arrancar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sesiones-'));
  try {
    const ruta = join(dir, 'sesiones.json');
    await writeFile(ruta, '{ esto no es json');
    const store = await ArchivoSessionStore.abrir(ruta);
    assert.equal((await store.get(1)).estado.paso, 'inicio');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agrupador: mensajes seguidos se procesan juntos, en orden y uno a la vez por chat', async () => {
  const procesados: string[] = [];
  const a = new AgrupadorMensajes<string>(40, async (chat, texto, ctx) => {
    await esperar(5);
    procesados.push(`${chat}|${texto}|${ctx}`);
  });

  a.agregar(1, 'Brayan Munar Vásquez', 'c1');
  await esperar(10);
  a.agregar(1, 'Cédula 1019141472', 'c2');
  a.agregar(2, 'otro chat', 'x');
  assert.equal(a.hayPendiente(1), true);
  await esperar(100);
  assert.deepEqual(procesados.sort(), ['1|Brayan Munar Vásquez\nCédula 1019141472|c2', '2|otro chat|x']);
  assert.equal(a.hayPendiente(1), false);

  // Un botón (vaciar) procesa ya lo pendiente, antes de seguir.
  procesados.length = 0;
  a.agregar(1, 'apto 7', 'c3');
  await a.vaciar(1);
  assert.deepEqual(procesados, ['1|apto 7|c3']);

  // enCola espera a lo que esté en curso para ese chat.
  procesados.length = 0;
  a.agregar(1, 'canon 600 mil', 'c4');
  const vaciado = a.vaciar(1);
  await a.enCola(1, async () => void procesados.push('botón'));
  await vaciado;
  assert.deepEqual(procesados, ['1|canon 600 mil|c4', 'botón']);
});

test('agrupador: un error al procesar no detiene lo siguiente', async () => {
  const procesados: string[] = [];
  const a = new AgrupadorMensajes<null>(10, async (_chat, texto) => {
    if (texto === 'falla') throw new Error('x');
    procesados.push(texto);
  });
  const error = console.error;
  console.error = () => undefined;
  try {
    a.agregar(1, 'falla', null);
    await a.vaciar(1);
    a.agregar(1, 'sigue', null);
    await a.vaciar(1);
  } finally {
    console.error = error;
  }
  assert.deepEqual(procesados, ['sigue']);
});
