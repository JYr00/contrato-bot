import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import PizZip from 'pizzip';

import { ContractRenderer } from '../contract/render.js';
import { Catalogo } from '../datos/catalogo.js';
import { Asistente, estadoInicial, type Salida } from './asistente.js';

const HOY = '2026-10-02';
const plantilla = await readFile('templates/contrato-arrendamiento.docx');
const renderer = new ContractRenderer(plantilla, { correo: 'arrendador@example.com', celular: '3001112233' }, '/no/existe');

/** data del botón de la tarjeta cuya etiqueta contiene `etiqueta`. */
function boton(s: Salida, etiqueta: string): string {
  const b = s.tarjeta.botones?.flat().find((x) => x.texto.includes(etiqueta));
  assert.ok(b, `no hay botón "${etiqueta}" en: ${JSON.stringify(s.tarjeta)}`);
  return b.data;
}
const etiquetas = (s: Salida) => s.tarjeta.botones?.map((f) => f.map((b) => b.texto));
const textoDocx = (docx: Buffer) => new PizZip(docx).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');

test('primer contrato: sin historial se escribe todo y la tarjeta acumula lo respondido', async () => {
  const catalogo = Catalogo.enMemoria();
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();

  assert.equal(a.iniciar(e).nueva, true);
  let s = await a.recibirTexto(e, 'Laura Gómez Pérez CC 1.020.345.678');
  assert.equal(e.paso, 'inmueble', 'sin historial no hay propuesta');
  assert.match(s.tarjeta.texto, /^📄 Contrato nuevo\n\n👤 LAURA GÓMEZ PÉREZ · C\.C\. 1\.020\.345\.678/);
  assert.match(s.tarjeta.texto, /✍️ Escribe la dirección/, 'sin direcciones guardadas se pide escribirla');
  assert.deepEqual(etiquetas(s), [['⬅️ Atrás']]);

  s = await a.recibirTexto(e, 'Carrera 105 i 67 d 31 apto 201, Bogotá');
  assert.match(s.tarjeta.texto, /💾 Guardé este edificio/);
  assert.match(s.tarjeta.texto, /🏠 Carrera 105 i 67 d 31 apto 201, Bogotá/);
  assert.deepEqual(catalogo.inmuebles(), ['Carrera 105 i 67 d 31 apto 201, Bogotá']);
  assert.deepEqual(catalogo.edificios(), ['Carrera 105 i 67 d 31, Bogotá']);

  s = await a.recibirTexto(e, '50');
  assert.match(s.tarjeta.texto, /⚠️ El precio parece demasiado bajo/, 'valida el precio');
  assert.equal(e.paso, 'precio');
  s = await a.recibirTexto(e, '750 mil');
  assert.equal(e.datos.precio_mensual, 750_000);

  s = await a.recibirTexto(e, '200.000');
  assert.match(s.tarjeta.texto, /💵 Al iniciar: \$950\.000 \(primer mes \+ canon\)/);
  s = await a.recibirBoton(e, boton(s, '3 meses'));
  s = await a.recibirTexto(e, '15/10/2026');
  assert.match(s.tarjeta.texto, /🗓️ Del 15 de octubre de 2026 al 14 de enero de 2027/);
  s = await a.recibirBoton(e, boton(s, '1'));
  assert.equal(e.paso, 'contacto');
  s = await a.recibirTexto(e, '310 555 1234 Laura@Example.com');
  assert.equal(e.datos.arrendatario_celular, '3105551234');
  assert.equal(e.datos.arrendatario_correo, 'laura@example.com');
  assert.match(s.tarjeta.texto, /Normalmente es la dirección del inmueble/);
  s = await a.recibirBoton(e, boton(s, 'La del inmueble'));

  assert.equal(e.paso, 'resumen');
  assert.match(s.tarjeta.texto, /📱 Contacto: 3105551234 · laura@example\.com/);

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.ok(s.generar, 'entrega los datos para generar');
  assert.equal(e.paso, 'listo');
  assert.equal(s.tarjeta.botones, undefined);
  assert.match(a.generado(e).texto, /✅ Contrato generado/);

  const texto = textoDocx((await renderer.generar(s.generar)).docx);
  assert.match(texto, /Carrera 105 i 67 d 31 apto 201, Bogotá, destinado/);
  assert.match(texto, /SETECIENTOS CINCUENTA MIL PESOS \(\$750\.000\)/);
  assert.match(texto, /tres \(3\) meses, contados a partir del 15 de octubre de 2026/);
  assert.match(texto, /DOSCIENTOS MIL PESOS \(\$200\.000\) M\/cte, a título de depósito/);
  assert.doesNotMatch(texto, /[{}]/, 'no quedan campos sin reemplazar');

  // Un mensaje después de terminar arranca otro contrato en una tarjeta nueva.
  assert.equal((await a.recibirTexto(e, 'Ana Ruiz Díaz 52123456')).nueva, true);
});

test('arrendatario conocido: la foto propone renovar y se genera en dos toques', async () => {
  const catalogo = Catalogo.enMemoria();
  await catalogo.registrarContrato({
    arrendatario_nombre: 'LAURA GÓMEZ PÉREZ',
    arrendatario_tipo_documento: 'CC',
    arrendatario_numero_documento: '1020345678',
    inmueble_direccion: 'Carrera 105 i 67 d 31 apto 201',
    precio_mensual: 1_500_000,
    deposito: 300_000,
    duracion_meses: 3,
    fecha_inicio: '2026-08-01',
    numero_ocupantes: 2,
    arrendatario_celular: '3105551234',
    arrendatario_correo: '',
    arrendatario_direccion: 'Carrera 105 i 67 d 31 apto 201',
    numero_ejemplares: 2,
  });
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();

  let s = await a.recibirDocumento(e, { nombre: 'LAURA GÓMEZ PÉREZ', numero: '1020345678', tipo: 'CC' });
  assert.equal(s.nueva, true, 'una foto sin /nuevo previo arranca un contrato');
  assert.equal(e.paso, 'confirmar_documento');
  assert.match(s.tarjeta.texto, /C\.C\. 1\.020\.345\.678/);

  s = await a.recibirBoton(e, boton(s, 'Sí, continuar'));
  assert.equal(e.paso, 'propuesta');
  assert.match(s.tarjeta.texto, /🔁 Renovación del contrato que vence el 31 de octubre de 2026/);
  assert.match(s.tarjeta.texto, /Precio: \$1\.500\.000/);
  assert.match(s.tarjeta.texto, /Canon \(depósito\): sin canon/, 'el canon ya se entregó en el contrato anterior');
  assert.match(s.tarjeta.texto, /🔐 Sin canon: ya se entregó/);
  assert.match(s.tarjeta.texto, /Del 1 de noviembre de 2026 al 31 de enero de 2027/);
  assert.match(s.tarjeta.texto, /Contacto: 3105551234/);

  s = await a.recibirBoton(e, boton(s, 'Usar sugerencia'));
  assert.equal(e.paso, 'resumen', 'con un arrendatario conocido no falta nada');
  assert.equal(e.datos.fecha_inicio, '2026-11-01');

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  const texto = textoDocx((await renderer.generar(s.generar!)).docx);
  assert.doesNotMatch(texto, /título de depósito/, 'sin canon no aparece el parágrafo');
  assert.doesNotMatch(texto, /[{}]/);
});

test('opciones guardadas, "otro valor", atrás y botones viejos', async () => {
  const catalogo = Catalogo.enMemoria({
    inmuebles: [
      { direccion: 'Calle 1 # 2-3 apto 101', usos: 3, ultimoUso: 1, ultimoPrecio: 900_000 },
      { direccion: 'Calle 4 # 5-6 casa 2', usos: 1, ultimoUso: 2, ultimoPrecio: 1_200_000 },
    ],
    precios: [
      { valor: 900_000, usos: 3, ultimoUso: 1 },
      { valor: 1_200_000, usos: 1, ultimoUso: 2 },
    ],
  });
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  a.iniciar(e);
  let s = await a.recibirTexto(e, 'Pedro Ruiz Díaz 80123456');
  s = await a.recibirBoton(e, boton(s, 'paso a paso'));
  assert.deepEqual(
    etiquetas(s),
    [['Calle 4 # 5-6 casa 2'], ['Calle 1 # 2-3'], ['➕ Otra dirección', '⬅️ Atrás']],
    'edificios, el más reciente primero, y opción de agregar otro',
  );

  s = await a.recibirBoton(e, boton(s, 'Calle 1'));
  assert.equal(e.paso, 'unidad');
  assert.match(s.tarjeta.texto, /¿Qué apartamento de Calle 1 # 2-3\?/);
  assert.deepEqual(etiquetas(s), [['101'], ['🏠 Sin apartamento (casa completa)'], ['➕ Otro apartamento', '⬅️ Atrás']]);
  s = await a.recibirBoton(e, boton(s, '101'));
  assert.equal(e.datos.inmueble_direccion, 'Calle 1 # 2-3 apto 101');
  assert.equal(etiquetas(s)![0]![0], '$900.000', 'primero el último precio usado en ese inmueble');

  const viejo = boton(s, '$900.000');
  s = await a.recibirBoton(e, boton(s, 'Otro valor'));
  assert.match(s.tarjeta.texto, /✍️ Escribe el precio/);
  s = await a.recibirTexto(e, '950 mil');
  assert.equal(e.datos.precio_mensual, 950_000);
  assert.equal((await a.recibirBoton(e, viejo)).obsoleto, true, 'botones de pasos anteriores se ignoran');

  // Atrás vuelve a la pregunta anterior y permite cambiar la respuesta.
  assert.equal(e.paso, 'deposito');
  s = await a.recibirBoton(e, boton(s, 'Atrás'));
  assert.equal(e.paso, 'precio');
  s = await a.recibirBoton(e, boton(s, '$1.200.000'));
  assert.equal(e.datos.precio_mensual, 1_200_000);
  assert.equal(e.paso, 'deposito');
});

test('corregir un dato desde el resumen vuelve al resumen', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  Object.assign(e.datos, {
    arrendatario_nombre: 'ANA RUIZ',
    arrendatario_tipo_documento: 'CC',
    arrendatario_numero_documento: '52123456',
    inmueble_direccion: 'Calle 1 # 2-3 apto 101',
    precio_mensual: 900_000,
    deposito: 0,
    duracion_meses: 6,
    fecha_inicio: '2026-11-01',
    numero_ocupantes: 1,
    arrendatario_celular: '',
    arrendatario_correo: '',
    arrendatario_direccion: 'Calle 1 # 2-3 apto 101',
  });
  e.paso = 'resumen';

  let s = await a.recibirBoton(e, 'resumen:corregir');
  s = await a.recibirBoton(e, boton(s, 'Inmueble'));
  s = await a.recibirTexto(e, 'Calle 9 # 8-7 apto 302');
  assert.equal(e.paso, 'resumen');
  assert.equal(e.datos.arrendatario_direccion, 'Calle 9 # 8-7 apto 302', 'la notificación sigue al inmueble');

  s = await a.recibirBoton(e, 'resumen:corregir');
  s = await a.recibirBoton(e, boton(s, 'Duración'));
  s = await a.recibirTexto(e, 'un año');
  assert.equal(e.datos.duracion_meses, 12);
  assert.match(s.tarjeta.texto, /Duración: 12 meses \(1 año\)/);
  assert.match(s.tarjeta.texto, /Del 1 de noviembre de 2026 al 31 de octubre de 2027/);

  s = await a.recibirTexto(e, 'hola');
  assert.match(s.tarjeta.texto, /Usa los botones/);
  assert.equal(e.paso, 'resumen');
});

test('foto ilegible pide otra foto o escribir los datos', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  const s = await a.recibirDocumento(e, { numero: '1020', observacion: 'la foto está borrosa' });
  assert.equal(e.paso, 'documento');
  assert.match(s.tarjeta.texto, /la foto está borrosa/);
  await a.recibirTexto(e, 'Laura Gómez Pérez CC 1020345678');
  assert.equal(e.datos.arrendatario_numero_documento, '1020345678');
});

test('edificio escrito: se guarda, se pregunta el apartamento y queda como botón', async () => {
  const catalogo = Catalogo.enMemoria();
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  a.iniciar(e);
  let s = await a.recibirTexto(e, 'Laura Pérez CC 165645678');
  s = await a.recibirTexto(e, 'Carrera 105 i 67 d 31, Bogotá');
  assert.match(s.tarjeta.texto, /💾 Guardé este edificio/);
  assert.equal(e.paso, 'unidad');
  assert.deepEqual(catalogo.edificios(), ['Carrera 105 i 67 d 31, Bogotá'], 'se guarda aunque no se termine el contrato');

  // Atrás y elegirlo de nuevo con el botón.
  s = await a.recibirBoton(e, boton(s, 'Atrás'));
  assert.deepEqual(etiquetas(s), [['Carrera 105 i 67 d 31, Bogotá'], ['➕ Otra dirección', '⬅️ Atrás']]);
  s = await a.recibirBoton(e, boton(s, 'Carrera 105'));
  assert.equal(e.paso, 'unidad');
  assert.match(s.tarjeta.texto, /✍️ Escribe el número del apartamento/, 'sin apartamentos guardados se pide escribirlo');
  s = await a.recibirTexto(e, 'apto 501');
  assert.equal(e.datos.inmueble_direccion, 'Carrera 105 i 67 d 31 apto 501, Bogotá');
  assert.equal(e.paso, 'precio');

  // Atrás desde el precio vuelve al apartamento del mismo edificio, ya con el 501 como botón.
  s = await a.recibirBoton(e, boton(s, 'Atrás'));
  assert.equal(e.paso, 'unidad');
  assert.equal(etiquetas(s)![0]![0], '501');

  // Contrato siguiente: el apartamento usado aparece como opción, y "sin apartamento" sirve para casas.
  a.iniciar(e);
  s = await a.recibirTexto(e, 'Ana Ruiz Díaz 52123456');
  s = await a.recibirBoton(e, boton(s, 'Carrera 105'));
  s = await a.recibirBoton(e, boton(s, 'Sin apartamento'));
  assert.equal(e.datos.inmueble_direccion, 'Carrera 105 i 67 d 31, Bogotá');
  assert.equal(e.edificio, 'Carrera 105 i 67 d 31, Bogotá');
});

test('/renovar: lista contratos por vencimiento y el elegido va directo al resumen', async () => {
  const vacio = new Asistente(Catalogo.enMemoria(), () => HOY);
  assert.match(vacio.renovar(estadoInicial()).tarjeta.texto, /Todavía no hay contratos para renovar/);

  const catalogo = Catalogo.enMemoria();
  const base = {
    arrendatario_tipo_documento: 'CC' as const,
    precio_mensual: 900_000,
    deposito: 0,
    duracion_meses: 6,
    numero_ocupantes: 1,
    arrendatario_celular: '',
    arrendatario_correo: '',
    numero_ejemplares: 2,
  };
  await catalogo.registrarContrato({
    ...base,
    arrendatario_nombre: 'ANA RUIZ DÍAZ',
    arrendatario_numero_documento: '52123456',
    inmueble_direccion: 'Calle 1 # 2-3 apto 101',
    arrendatario_direccion: 'Calle 1 # 2-3 apto 101',
    fecha_inicio: '2026-06-01',
  });
  await catalogo.registrarContrato({
    ...base,
    arrendatario_nombre: 'PEDRO PÉREZ GIL',
    arrendatario_numero_documento: '80123456',
    inmueble_direccion: 'Calle 1 # 2-3 apto 202',
    arrendatario_direccion: 'Calle 1 # 2-3 apto 202',
    precio_mensual: 1_000_000,
    duracion_meses: 3,
    fecha_inicio: '2026-07-15',
  });

  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  let s = a.renovar(e);
  assert.equal(s.nueva, true);
  assert.deepEqual(etiquetas(s), [
    ['PEDRO PÉREZ · apto 202 · vence 14 oct 2026'],
    ['ANA RUIZ · apto 101 · vence 30 nov 2026'],
  ]);

  s = await a.recibirBoton(e, boton(s, 'PEDRO'));
  assert.equal(e.paso, 'resumen');
  assert.equal(e.datos.fecha_inicio, '2026-10-15', 'empieza el día siguiente al vencimiento');
  assert.equal(e.datos.precio_mensual, 1_000_000);
  assert.match(s.tarjeta.texto, /🔁 Renovación del contrato que vence el 14 de octubre de 2026/);
  assert.match(s.tarjeta.texto, /Del 15 de octubre de 2026 al 14 de enero de 2027/);

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.ok(s.generar);
  await catalogo.registrarContrato(s.generar);
  assert.equal(
    catalogo.arrendatario('80123456')!.ultimoContrato!.fecha_inicio,
    '2026-10-15',
    'la renovación pasa a ser el último contrato',
  );
});
