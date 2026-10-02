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

/** Texto del último mensaje y data del botón cuya etiqueta contiene `etiqueta`. */
const ultimo = (s: Salida) => s.mensajes.at(-1)!;
function boton(s: Salida, etiqueta: string): string {
  const b = ultimo(s).botones?.flat().find((x) => x.texto.includes(etiqueta));
  assert.ok(b, `no hay botón "${etiqueta}" en: ${JSON.stringify(ultimo(s))}`);
  return b.data;
}
const textoDocx = (docx: Buffer) => new PizZip(docx).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');

test('primer contrato: sin historial se escribe todo y se guarda la dirección', async () => {
  const catalogo = Catalogo.enMemoria();
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();

  a.iniciar(e);
  let s = await a.recibirTexto(e, 'Laura Gómez Pérez CC 1.020.345.678');
  assert.equal(e.paso, 'inmueble_direccion', 'sin historial no hay propuesta');
  assert.equal(ultimo(s).botones, undefined, 'sin direcciones guardadas se pide escribirla');

  s = await a.recibirTexto(e, 'Carrera 105 i 67 d 31 apto 201, Bogotá');
  assert.match(s.mensajes[0]!.texto, /Guardé esta dirección/);
  assert.deepEqual(catalogo.inmuebles(), ['Carrera 105 i 67 d 31 apto 201, Bogotá']);

  s = await a.recibirTexto(e, '50');
  assert.match(s.mensajes[0]!.texto, /demasiado bajo/, 'valida el precio');
  s = await a.recibirTexto(e, '1,5 millones');
  assert.equal(e.datos.precio_mensual, 1_500_000);

  s = await a.recibirBoton(e, boton(s, 'Sin canon'));
  assert.equal(e.datos.deposito, 0);
  s = await a.recibirBoton(e, boton(s, '6 meses'));
  s = await a.recibirBoton(e, boton(s, '1 de noviembre de 2026'));
  s = await a.recibirBoton(e, boton(s, '2'));
  s = await a.recibirBoton(e, boton(s, 'Dejar en blanco'));
  assert.equal(e.datos.arrendatario_celular, '');
  s = await a.recibirTexto(e, 'Laura@Example.com');
  s = await a.recibirBoton(e, boton(s, 'La del inmueble'));

  assert.equal(e.paso, 'resumen');
  assert.match(ultimo(s).texto, /LAURA GÓMEZ PÉREZ · C\.C\. 1\.020\.345\.678/);
  assert.match(ultimo(s).texto, /Celular: \(en blanco\)/);

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.ok(s.generar, 'entrega los datos para generar');
  assert.equal(e.paso, 'listo');

  const contrato = await renderer.generar(s.generar);
  const texto = textoDocx(contrato.docx);
  assert.match(texto, /Carrera 105 i 67 d 31 apto 201, Bogotá, destinado/);
  assert.match(texto, /UN MILLÓN QUINIENTOS MIL PESOS \(\$1\.500\.000\)/);
  assert.match(texto, /seis \(6\) meses, contados a partir del 1 de noviembre de 2026/);
  assert.doesNotMatch(texto, /título de depósito/, 'sin canon no aparece el parágrafo');
  assert.doesNotMatch(texto, /[{}]/, 'no quedan campos sin reemplazar');
  await catalogo.registrarContrato(s.generar);
});

test('con historial: la foto sugiere el resto y se genera en dos toques', async () => {
  const catalogo = Catalogo.enMemoria();
  await catalogo.registrarContrato({
    arrendatario_nombre: 'LAURA GÓMEZ PÉREZ',
    arrendatario_tipo_documento: 'CC',
    arrendatario_numero_documento: '1020345678',
    inmueble_direccion: 'Carrera 105 i 67 d 31 apto 201',
    precio_mensual: 1_500_000,
    deposito: 500_000,
    duracion_meses: 3,
    fecha_inicio: '2026-01-01',
    numero_ocupantes: 2,
    arrendatario_celular: '3105551234',
    arrendatario_correo: 'laura@example.com',
    arrendatario_direccion: 'Carrera 105 i 67 d 31 apto 201',
    numero_ejemplares: 2,
  });
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();

  // Una foto sin /nuevo previo arranca el contrato.
  let s = await a.recibirDocumento(e, { nombre: 'LAURA GÓMEZ PÉREZ', numero: '1020345678', tipo: 'CC' });
  assert.equal(e.paso, 'confirmar_documento');
  s = await a.recibirBoton(e, boton(s, 'Sí, continuar'));
  assert.match(s.mensajes[0]!.texto, /ya tuvo un contrato/);
  assert.equal(e.paso, 'propuesta');
  assert.match(ultimo(s).texto, /Precio: \$1\.500\.000/);
  assert.match(ultimo(s).texto, /Canon \(depósito\): \$500\.000/);

  s = await a.recibirBoton(e, boton(s, 'Usar sugerencia'));
  assert.equal(e.paso, 'resumen', 'con un arrendatario conocido no falta nada');
  assert.equal(e.datos.fecha_inicio, '2026-11-01');

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  const texto = textoDocx((await renderer.generar(s.generar!)).docx);
  assert.match(texto, /QUINIENTOS MIL PESOS \(\$500\.000\) M\/cte, a título de depósito/);
  assert.doesNotMatch(texto, /[{}]/);
});

test('las opciones guardadas aparecen como botones y "otro valor" permite escribir', async () => {
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
  // Hay historial de inmuebles: se propone; elegimos paso a paso.
  s = await a.recibirBoton(e, boton(s, 'paso a paso'));
  assert.deepEqual(
    ultimo(s).botones!.map((f) => f.map((b) => b.texto)),
    [['Calle 4 # 5-6 casa 2'], ['Calle 1 # 2-3 apto 101'], ['➕ Otra dirección']],
    'la más reciente primero, y opción de agregar otra',
  );

  s = await a.recibirBoton(e, boton(s, 'Calle 1'));
  assert.equal(
    ultimo(s).botones![0]![0]!.texto,
    '$900.000',
    'el precio sugerido primero es el último usado en ese inmueble',
  );

  const viejo = boton(s, '$900.000');
  s = await a.recibirBoton(e, boton(s, 'Otro valor'));
  assert.match(ultimo(s).texto, /Escribe el precio/);
  s = await a.recibirTexto(e, '950 mil');
  assert.equal(e.datos.precio_mensual, 950_000);
  assert.equal((await a.recibirBoton(e, viejo)).obsoleto, true, 'botones de pasos anteriores se ignoran');
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
  assert.match(ultimo(s).texto, /Duración: 12 meses \(1 año\)/);
});

test('foto ilegible pide otra foto o escribir los datos', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  const s = await a.recibirDocumento(e, { numero: '1020', observacion: 'la foto está borrosa' });
  assert.equal(e.paso, 'documento');
  assert.match(ultimo(s).texto, /la foto está borrosa/);
  await a.recibirTexto(e, 'Laura Gómez Pérez CC 1020345678');
  assert.equal(e.datos.arrendatario_numero_documento, '1020345678');
});
