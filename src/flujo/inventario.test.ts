import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DatosContrato } from '../contract/schema.js';
import { Catalogo } from '../datos/catalogo.js';
import { AvisosVencimiento } from '../datos/vencimientos.js';
import type { Salida } from './asistente.js';
import { Asistente, estadoInicial } from './asistente.js';
import { Inventario, estadoInmueble, type EstadoInventario } from './inventario.js';

const HOY = '2026-10-03';
const EDIFICIO = 'Carrera 105 i 67 d 31, Bogotá';
const apto = (n: string) => `Carrera 105 i 67 d 31 apto ${n}, Bogotá`;

const contrato = (direccion: string, nombre: string, numero: string, inicio: string, meses: number): DatosContrato => ({
  arrendatario_nombre: nombre,
  arrendatario_tipo_documento: 'CC',
  arrendatario_numero_documento: numero,
  coarrendatarios: [],
  inmueble_direccion: direccion,
  precio_mensual: 1_000_000,
  deposito: 0,
  duracion_meses: meses,
  fecha_inicio: inicio,
  numero_ocupantes: 1,
  arrendatario_celular: '',
  arrendatario_correo: '',
  arrendatario_direccion: direccion,
  numero_ejemplares: 2,
});

/** Edificio de ejemplo: 201 ocupado, 202 por vencer, 301 libre (contrato terminado), 302 sin contratos. */
async function catalogoDeEjemplo() {
  const catalogo = Catalogo.enMemoria();
  await catalogo.registrarContrato(contrato(apto('201'), 'LAURA GÓMEZ PÉREZ', '1020345678', '2026-08-01', 6));
  await catalogo.registrarContrato(contrato(apto('202'), 'PEDRO RUIZ DÍAZ', '80123456', '2026-07-15', 3));
  await catalogo.registrarContrato(contrato(apto('301'), 'ANA LÓPEZ MORA', '52123456', '2026-03-01', 6));
  await catalogo.agregarInmueble(apto('302'));
  await catalogo.agregarEdificio('Calle 80 # 12-34, Bogotá');
  return catalogo;
}
const etiquetas = (m: { botones?: { texto: string }[][] }) => m.botones?.map((f) => f.map((b) => b.texto));
const data = (m: { botones?: { texto: string; data: string }[][] }, texto: string) => {
  const b = m.botones?.flat().find((x) => x.texto.includes(texto));
  assert.ok(b, `no hay botón "${texto}": ${JSON.stringify(etiquetas(m))}`);
  return b.data;
};

test('estado de un inmueble según la fecha', () => {
  const c = contrato(apto('201'), 'LAURA GÓMEZ', '1', '2026-08-01', 6); // vence 31 ene 2027
  assert.equal(estadoInmueble([c], HOY).tipo, 'ocupado');
  assert.equal(estadoInmueble([c], '2027-01-10').tipo, 'por_vencer');
  assert.equal(estadoInmueble([c], '2027-01-10').dias, 21);
  assert.equal(estadoInmueble([c], '2026-07-20').tipo, 'reservado');
  const libre = estadoInmueble([c], '2027-02-15');
  assert.equal(libre.tipo, 'libre');
  assert.equal(libre.anterior, c);
  assert.equal(estadoInmueble([], HOY).tipo, 'libre');

  // Renovado: el vigente sigue mandando, pero se sabe que hay uno después.
  const renovacion = contrato(apto('201'), 'LAURA GÓMEZ', '1', '2027-02-01', 6);
  const e = estadoInmueble([renovacion, c], '2027-01-20');
  assert.equal(e.contrato, c);
  assert.equal(e.siguiente, renovacion);
});

test('informe general, edificio y libres', async () => {
  const inv = new Inventario(await catalogoDeEjemplo(), () => HOY);

  const resumen = inv.resumen();
  assert.match(resumen.texto, /🏢 Inmuebles · 3 de octubre de 2026/);
  assert.match(resumen.texto, /Carrera 105 i 67 d 31, Bogotá\n🔴 1 ocupado · 🟡 1 por vencer · 🟢 2 libres/);
  assert.match(resumen.texto, /Calle 80 # 12-34, Bogotá\nsin apartamentos registrados/);
  assert.deepEqual(etiquetas(resumen), [
    ['🏢 Calle 80 # 12-34, Bogotá · 0/0'],
    ['🏢 Carrera 105 i 67 d 31, Bogotá · 2/4'],
    ['🟢 Ver libres (2)'],
    ['⚙️ Ajustes'],
  ]);

  const edificio = inv.edificio(1);
  assert.equal(
    edificio.texto,
    [
      `🏢 ${EDIFICIO}`,
      [
        '🔴 201 · LAURA GÓMEZ · hasta 31 ene 2027',
        '🟡 202 · PEDRO RUIZ · vence 14 oct 2026 (11 días)',
        '🟢 301 · libre desde 31 ago 2026',
        '🟢 302 · libre',
      ].join('\n'),
    ].join('\n\n'),
  );
  assert.deepEqual(etiquetas(edificio)!.slice(0, 2), [['🔴 201', '🟡 202', '🟢 301'], ['🟢 302']]);

  const libres = inv.libres();
  assert.deepEqual(etiquetas(libres), [
    ['🏢 Carrera 105 i 67 d 31 · 2 libres'],
    ['301', '302'],
    ['↩️ Inmuebles'],
  ]);
  assert.match(libres.texto, /^🟢 Libres hoy: 2 en 1 edificio/);
  assert.match(libres.texto, /Se desocupan pronto \(sin renovar\):\n🟡 202/);
  assert.equal(data(libres, 'Carrera 105'), 'inv:e:1', 'el encabezado abre el edificio');
  assert.equal(data(libres, '302'), 'inv:u:1:3');
});

test('detalle de un apartamento y sus acciones', async () => {
  const catalogo = await catalogoDeEjemplo();
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};

  const detalle = inv.unidad(1, 0);
  assert.match(detalle.texto, /🏠 Carrera 105 i 67 d 31 apto 201, Bogotá\n\n🔴 Ocupado · faltan 120 días/);
  assert.match(detalle.texto, /📄 Contrato vigente\n👤 LAURA GÓMEZ PÉREZ/);
  assert.deepEqual(etiquetas(detalle), [
    ['📄 Reenviar contrato', '🔁 Renovar'],
    ['🗂 Contratos (1)'],
    ['📝 Nuevo contrato aquí'],
    ['⚙️ Ajustes', '↩️ Volver'],
  ]);

  const reenviar = await inv.boton(estado, data(detalle, 'Reenviar'));
  assert.equal(reenviar.accion?.tipo, 'reenviar');
  assert.equal(reenviar.accion?.tipo === 'reenviar' && reenviar.accion.datos.arrendatario_nombre, 'LAURA GÓMEZ PÉREZ');
  assert.equal(reenviar.accion?.tipo === 'reenviar' && reenviar.accion.id, catalogo.contratosGuardadosDe(apto('201'))[0]!.id, 'lleva el id para mandar el archivo original');

  // Renovar y nuevo contrato llevan al asistente.
  const a = new Asistente(catalogo, () => HOY);
  const renovar = await inv.boton(estado, data(detalle, 'Renovar'));
  assert.equal(renovar.accion?.tipo, 'renovar');
  const e = estadoInicial();
  let s: Salida = a.renovarContrato(e, (renovar.accion as { datos: DatosContrato }).datos);
  assert.equal(s.nueva, true);
  assert.equal(e.paso, 'resumen');
  assert.equal(e.datos.fecha_inicio, '2027-02-01');

  const libre = inv.unidad(1, 3);
  assert.deepEqual(etiquetas(libre), [['📝 Nuevo contrato aquí'], ['⚙️ Ajustes', '↩️ Volver']], 'sin contratos no hay reenviar ni renovar');
  const nuevo = await inv.boton(estado, data(libre, 'Nuevo contrato'));
  assert.deepEqual(nuevo.accion, { tipo: 'nuevo', direccion: apto('302') });
  s = a.nuevoEn(e, apto('302'));
  assert.equal(e.paso, 'documento');
  assert.match(s.tarjeta.texto, /🏠 Carrera 105 i 67 d 31 apto 302, Bogotá/);
  // Con la cédula, sigue con el precio (el inmueble ya está).
  s = await a.recibirTexto(e, 'Juan Paz Soto CC 79123456');
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.paso, 'precio');
});

test('agregar apartamentos, edificios y borrar con confirmación', async () => {
  const catalogo = await catalogoDeEjemplo();
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};

  // Cuarto piso: 401 y 402.
  let r = await inv.boton(estado, 'inv:addapto:1');
  assert.match(r.mensaje.texto, /Escribe el número del apartamento/);
  assert.equal(estado.esperando, 'apartamentos');
  let m = await inv.texto(estado, '401, 402 y 301');
  assert.match(m!.texto, /➕ Agregué: 401, 402\nYa estaban: 301/);
  assert.deepEqual(catalogo.unidades(EDIFICIO, 10).sort(), ['201', '202', '301', '302', '401', '402']);
  assert.equal(estado.esperando, undefined);
  assert.equal(await inv.texto(estado, 'hola'), null, 'sin espera, el texto no es del informe');

  // Edificio nuevo.
  r = await inv.boton(estado, 'inv:addedif');
  m = await inv.texto(estado, 'Calle 26 # 50-10, Bogotá');
  assert.match(m!.texto, /💾 Guardé: Calle 26 # 50-10, Bogotá/);
  assert.match(m!.texto, /🏢 Calle 26 # 50-10, Bogotá/);
  assert.match((await inv.agregarEdificio('x')).texto, /⚠️ Dirección incompleta/);

  // Quitar un apartamento pide confirmación y verifica que sea el mismo.
  const i = catalogo.edificiosOrdenados().indexOf(EDIFICIO);
  r = await inv.boton(estado, `inv:delu:${i}:3`);
  assert.match(r.mensaje.texto, /¿Quitar "Carrera 105 i 67 d 31 apto 302, Bogotá" del informe\?/);
  const otro = await inv.boton(estado, `inv:deluok:${i}:3`, '¿Quitar "otra cosa"?');
  assert.match(otro.mensaje.texto, /La lista cambió; no quité nada/);
  r = await inv.boton(estado, data(r.mensaje, 'Sí, quitar'), r.mensaje.texto);
  assert.match(r.mensaje.texto, /🗑 Quité: 302/);
  assert.ok(!catalogo.unidades(EDIFICIO, 10).includes('302'));

  // Borrar un edificio.
  const j = catalogo.edificiosOrdenados().indexOf('Calle 80 # 12-34, Bogotá');
  r = await inv.boton(estado, `inv:deledif:${j}`);
  r = await inv.boton(estado, data(r.mensaje, 'Sí, borrar'), r.mensaje.texto);
  assert.match(r.mensaje.texto, /🗑 Borré: Calle 80 # 12-34, Bogotá/);
  assert.ok(!catalogo.edificiosOrdenados().includes('Calle 80 # 12-34, Bogotá'));
});

test('el historial se arma con los contratos de catálogos anteriores', () => {
  const viejo = contrato(apto('201'), 'LAURA GÓMEZ PÉREZ', '1020345678', '2026-08-01', 6);
  const catalogo = Catalogo.enMemoria({
    inmuebles: [{ direccion: apto('201'), usos: 1, ultimoUso: 1 }],
    arrendatarios: {
      '1020345678': { tipo: 'CC', numero: '1020345678', nombre: 'LAURA GÓMEZ PÉREZ', ultimoUso: 1, ultimoContrato: viejo },
    },
  });
  assert.equal(catalogo.contratosDe(apto('201')).length, 1);
  assert.match(new Inventario(catalogo, () => HOY).edificio(0).texto, /🔴 201 · LAURA GÓMEZ · hasta 31 ene 2027/);
});

test('/contratos: ver, reenviar y borrar un contrato hecho por error', async () => {
  const catalogo = await catalogoDeEjemplo();
  // Contrato de prueba con valores raros, en la dirección equivocada.
  await catalogo.registrarContrato({
    ...contrato(apto('302'), 'PRUEBA PRUEBA', '99999999', '2026-10-03', 7),
    precio_mensual: 987_000,
  });
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};
  const a = new Asistente(catalogo, () => HOY);
  assert.ok(catalogo.precios(undefined, 10).includes(987_000));
  assert.ok(catalogo.duraciones(10).includes(7));
  assert.match(inv.edificio(1).texto, /🔴 302 · PRUEBA PRUEBA/);

  const lista = inv.contratos();
  assert.equal(etiquetas(lista)![0]![0], 'PRUEBA PRUEBA · apto 302 · 3 oct 2026', 'el más reciente primero');
  assert.equal(etiquetas(lista)!.length, 5, '4 contratos + volver');

  let r = await inv.boton(estado, data(lista, 'PRUEBA'));
  assert.match(r.mensaje.texto, /📄 Contrato de PRUEBA PRUEBA/);
  assert.match(r.mensaje.texto, /🕓 Generado el/);
  const reenviar = await inv.boton(estado, data(r.mensaje, 'Reenviar'));
  assert.equal(reenviar.accion?.tipo, 'reenviar');

  r = await inv.boton(estado, data((await inv.boton(estado, data(r.mensaje, 'Ajustes'))).mensaje, 'Borrar contrato'));
  assert.match(r.mensaje.texto, /¿Borrar el contrato de PRUEBA PRUEBA en Carrera 105 i 67 d 31 apto 302, Bogotá/);
  r = await inv.boton(estado, data(r.mensaje, 'Sí, borrar'));
  assert.match(r.mensaje.texto, /🗑 Borré el contrato de PRUEBA PRUEBA/);
  assert.equal(r.accion?.tipo, 'borrado', 'el bot borra también los archivos guardados');
  assert.match(r.mensaje.texto, /Ese inmueble quedó libre/);

  // Se deshace lo aprendido: libre, arrendatario olvidado, valores de prueba fuera de las sugerencias.
  assert.match(inv.edificio(1).texto, /🟢 302 · libre/);
  assert.equal(catalogo.arrendatario('99999999'), undefined);
  assert.ok(!a.renovar(estadoInicial()).tarjeta.botones!.flat().some((b) => b.texto.includes('PRUEBA')));
  assert.ok(!catalogo.precios(undefined, 10).includes(987_000));
  assert.ok(!catalogo.duraciones(10).includes(7));
  assert.equal(catalogo.inmueble(apto('302'))!.ultimoPrecio, undefined);

  // Un botón viejo de ese contrato ya no hace nada.
  r = await inv.boton(estado, data(lista, 'PRUEBA'));
  assert.match(r.mensaje.texto, /Ese contrato ya no existe/);
});

test('borrar el último contrato de alguien devuelve el anterior para renovar', async () => {
  const catalogo = Catalogo.enMemoria();
  await catalogo.registrarContrato(contrato(apto('201'), 'LAURA GÓMEZ PÉREZ', '1020345678', '2026-01-01', 6));
  await catalogo.registrarContrato({ ...contrato(apto('202'), 'LAURA GÓMEZ PÉREZ', '1020345678', '2026-07-01', 6), precio_mensual: 1_200_000 });
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};

  // Desde el apartamento: historial y borrado del contrato equivocado (202).
  const i = catalogo.edificiosOrdenados().indexOf(EDIFICIO);
  let r = await inv.boton(estado, `inv:u:${i}:1`);
  r = await inv.boton(estado, data(r.mensaje, 'Contratos (1)'));
  assert.match(r.mensaje.texto, /🗂 Contratos de Carrera 105 i 67 d 31 apto 202, Bogotá/);
  r = await inv.boton(estado, data(r.mensaje, 'LAURA'));
  r = await inv.boton(estado, data((await inv.boton(estado, data(r.mensaje, 'Ajustes'))).mensaje, 'Borrar contrato'));
  await inv.boton(estado, data(r.mensaje, 'Sí, borrar'));

  const laura = catalogo.arrendatario('1020345678')!;
  assert.equal(laura.ultimoInmueble, apto('201'));
  assert.equal(laura.ultimoContrato!.fecha_inicio, '2026-01-01');
  assert.ok(catalogo.precios(undefined, 10).includes(1_000_000));
  assert.ok(!catalogo.precios(undefined, 10).includes(1_200_000));
});

// --- ⚙️ Ajustes ---------------------------------------------------------------------------------------

test('el menú normal no tiene botones de agregar, corregir ni borrar: están en ⚙️ Ajustes', async () => {
  const catalogo = await catalogoDeEjemplo();
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};
  const i = catalogo.edificiosOrdenados().indexOf(EDIFICIO);
  const id = catalogo.contratosRecientes(1)[0]!.id;
  const peligrosos = /🗑|➕|✏️/;

  for (const m of [inv.resumen(), inv.edificio(i), inv.unidad(i, 0), inv.detalleContrato(id), inv.libres(), inv.contratos()]) {
    assert.ok(!etiquetas(m)!.flat().some((t) => peligrosos.test(t)), `botones peligrosos en: ${JSON.stringify(etiquetas(m))}`);
  }

  assert.deepEqual(etiquetas((await inv.boton(estado, data(inv.resumen(), 'Ajustes'))).mensaje), [
    ['➕ Agregar edificio'],
    ['↩️ Volver'],
  ]);
  assert.deepEqual(etiquetas((await inv.boton(estado, data(inv.edificio(i), 'Ajustes'))).mensaje), [
    ['➕ Agregar apartamentos'],
    ['✏️ Cambiar dirección'],
    ['🗑 Borrar edificio'],
    ['↩️ Volver'],
  ]);
  assert.deepEqual(etiquetas((await inv.boton(estado, data(inv.unidad(i, 0), 'Ajustes'))).mensaje), [
    ['✏️ Cambiar número'],
    ['🗑 Quitar apartamento'],
    ['↩️ Volver'],
  ]);
  assert.deepEqual(etiquetas((await inv.boton(estado, data(inv.detalleContrato(id), 'Ajustes'))).mensaje), [
    ['🗑 Borrar contrato'],
    ['↩️ Volver'],
  ]);

  // "No" en una confirmación vuelve a los ajustes, no a la vista normal.
  const confirmar = await inv.boton(estado, `inv:delu:${i}:0`);
  assert.equal(data(confirmar.mensaje, 'No'), `inv:aju:${i}:0`);
});

test('✏️ cambiar número de apartamento conserva sus contratos', async () => {
  const catalogo = Catalogo.enMemoria();
  await catalogo.registrarContrato(contrato(apto('310'), 'LAURA GÓMEZ PÉREZ', '1020345678', '2026-08-01', 6));
  await catalogo.agregarInmueble(apto('302'));
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};
  const i = catalogo.edificiosOrdenados().indexOf(EDIFICIO);
  const j = catalogo.inmueblesDe(EDIFICIO).indexOf(apto('310'));

  let r = await inv.boton(estado, `inv:aju:${i}:${j}`);
  r = await inv.boton(estado, data(r.mensaje, 'Cambiar número'));
  assert.match(r.mensaje.texto, /Escribe el número correcto/);
  assert.equal(estado.esperando, 'numero_apartamento');

  // Inválido: lo vuelve a pedir. Existente: no cambia nada.
  let m = await inv.texto(estado, 'casa');
  assert.match(m!.texto, /No entendí el número/);
  m = await inv.texto(estado, '302');
  assert.match(m!.texto, /⚠️ Ya existe Carrera 105 i 67 d 31 apto 302, Bogotá/);
  assert.ok(catalogo.inmueble(apto('310')));

  r = await inv.boton(estado, `inv:renu:${i}:${j}`);
  m = await inv.texto(estado, 'apto 301');
  assert.match(m!.texto, /✏️ Cambié 310 → 301/);
  assert.match(m!.texto, /🏠 Carrera 105 i 67 d 31 apto 301, Bogotá\n\n🔴 Ocupado/, 'sigue ocupado con su contrato');
  assert.equal(catalogo.inmueble(apto('310')), undefined);
  assert.equal(catalogo.contratosDe(apto('301')).length, 1);

  const laura = catalogo.arrendatario('1020345678')!;
  assert.equal(laura.ultimoInmueble, apto('301'));
  assert.equal(laura.ultimoContrato!.inmueble_direccion, apto('301'));
  assert.equal(laura.ultimoContrato!.arrendatario_direccion, apto('301'), 'la notificación seguía al inmueble');
});

test('✏️ cambiar dirección del edificio mueve apartamentos e historial', async () => {
  const catalogo = await catalogoDeEjemplo();
  const inv = new Inventario(catalogo, () => HOY);
  const estado: EstadoInventario = {};
  const i = catalogo.edificiosOrdenados().indexOf(EDIFICIO);
  const NUEVO = 'Carrera 105 I # 67 D - 31, Bogotá';

  await inv.boton(estado, `inv:rene:${i}`);
  let m = await inv.texto(estado, `${NUEVO} apto 201`);
  assert.match(m!.texto, /⚠️ Escribe la dirección del edificio sin el apartamento/);
  m = await inv.texto(estado, 'Calle 80 # 12-34, Bogotá');
  assert.match(m!.texto, /⚠️ Ya existe el edificio Calle 80 # 12-34, Bogotá/);

  await inv.boton(estado, `inv:rene:${i}`);
  m = await inv.texto(estado, NUEVO);
  assert.match(m!.texto, /✏️ Cambié la dirección:\nCarrera 105 i 67 d 31, Bogotá → Carrera 105 I # 67 D - 31, Bogotá/);
  assert.match(m!.texto, /🔴 201 · LAURA GÓMEZ · hasta 31 ene 2027/, 'el estado sigue cuadrando');
  assert.ok(!catalogo.edificiosOrdenados().includes(EDIFICIO));
  assert.deepEqual(catalogo.inmueblesDe(NUEVO), [
    'Carrera 105 I # 67 D - 31 apto 201, Bogotá',
    'Carrera 105 I # 67 D - 31 apto 202, Bogotá',
    'Carrera 105 I # 67 D - 31 apto 301, Bogotá',
    'Carrera 105 I # 67 D - 31 apto 302, Bogotá',
  ]);

  // Renovar desde el informe usa la dirección nueva.
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  const s = a.renovarContrato(e, catalogo.arrendatario('1020345678')!.ultimoContrato!);
  assert.equal(e.datos.inmueble_direccion, 'Carrera 105 I # 67 D - 31 apto 201, Bogotá');
  assert.match(s.tarjeta.texto, /🏠 Carrera 105 I # 67 D - 31 apto 201, Bogotá/);
});

test('avisos de vencimiento: a 30 y a 7 días, una vez por umbral, sin los ya renovados', async () => {
  const catalogo = await catalogoDeEjemplo(); // 202 vence el 14 oct; 201 el 31 ene 2027
  let hoy = '2026-09-20';
  const inv = new Inventario(catalogo, () => hoy);
  const avisos = AvisosVencimiento.enMemoria();

  // 24 días antes: entra en el umbral de 30.
  let pendientes = avisos.pendientes(inv.porVencer());
  assert.deepEqual(pendientes.map((p) => [p.aviso.direccion, p.aviso.dias]), [[apto('202'), 24]]);
  const m = inv.avisoVencimientos(pendientes.map((p) => p.aviso));
  assert.match(m.texto, /📅 Contrato por vencer\n\n🟡 Apto 202 · Carrera 105 i 67 d 31\n {3}PEDRO RUIZ · vence el 14 oct 2026 \(en 24 días\)/);
  assert.deepEqual(etiquetas(m), [['🔁 Renovar 202', '🏠 Ver 202']]);
  await avisos.marcar(pendientes.flatMap((p) => p.claves));
  assert.deepEqual(avisos.pendientes(inv.porVencer()), [], 'no se repite');

  // A 7 días se avisa de nuevo, una sola vez.
  hoy = '2026-10-07';
  pendientes = avisos.pendientes(inv.porVencer());
  assert.equal(pendientes.length, 1);
  assert.match(inv.avisoVencimientos(pendientes.map((p) => p.aviso)).texto, /\(en 7 días\)/);
  await avisos.marcar(pendientes.flatMap((p) => p.claves));
  hoy = '2026-10-10';
  assert.deepEqual(avisos.pendientes(inv.porVencer()), []);

  // El botón renueva el contrato que vence (mismo flujo que desde el informe).
  const r = await inv.boton({}, data(m, 'Renovar'));
  assert.equal(r.accion?.tipo, 'renovar');
  assert.equal((r.accion as { datos: DatosContrato }).datos.arrendatario_numero_documento, '80123456');

  // Con el bot apagado varias semanas: un solo aviso (el más urgente) y los dos umbrales quedan avisados.
  const otro = AvisosVencimiento.enMemoria();
  hoy = '2026-10-12';
  pendientes = otro.pendientes(inv.porVencer());
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0]!.claves.length, 2);

  // Ya renovado: no se avisa.
  await catalogo.registrarContrato(contrato(apto('202'), 'PEDRO RUIZ DÍAZ', '80123456', '2026-10-15', 6));
  assert.deepEqual(AvisosVencimiento.enMemoria().pendientes(inv.porVencer()), []);
});
