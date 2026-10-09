import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import PizZip from 'pizzip';

import { ContractRenderer } from '../contract/render.js';
import { Catalogo } from '../datos/catalogo.js';
import { Asistente, estadoInicial, type ContextoExtraccion, type Salida } from './asistente.js';

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
  assert.equal(e.paso, 'confirmar_documento', 'lo escrito se confirma como una foto');
  assert.match(s.tarjeta.texto, /🪪 Leí este documento:\n\nLaura Gómez Pérez\n/);
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
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
  assert.match(s.tarjeta.texto, /⚠️ El canon parece demasiado bajo/, 'valida el canon');
  assert.equal(e.paso, 'precio');
  s = await a.recibirTexto(e, '750 mil');
  assert.equal(e.datos.precio_mensual, 750_000);

  s = await a.recibirTexto(e, '200.000');
  assert.match(s.tarjeta.texto, /💵 Al iniciar: \$950\.000 \(primer mes \+ depósito\)/);
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
    coarrendatarios: [],
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
  assert.match(s.tarjeta.texto, /Canon: \$1\.500\.000/);
  assert.match(s.tarjeta.texto, /Depósito: sin depósito/, 'el depósito ya se entregó en el contrato anterior');
  assert.match(s.tarjeta.texto, /🔐 Sin depósito: ya se entregó/);
  assert.match(s.tarjeta.texto, /Del 1 de noviembre de 2026 al 31 de enero de 2027/);
  assert.match(s.tarjeta.texto, /Contacto: 3105551234/);

  s = await a.recibirBoton(e, boton(s, 'Usar sugerencia'));
  assert.equal(e.paso, 'resumen', 'con un arrendatario conocido no falta nada');
  assert.equal(e.datos.fecha_inicio, '2026-11-01');

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  const texto = textoDocx((await renderer.generar(s.generar!)).docx);
  assert.doesNotMatch(texto, /título de depósito/, 'sin depósito no aparece el parágrafo');
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
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
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
  assert.equal(etiquetas(s)![0]![0], '$900.000', 'primero el último canon usado en ese inmueble');

  const viejo = boton(s, '$900.000');
  s = await a.recibirBoton(e, boton(s, 'Otro valor'));
  assert.match(s.tarjeta.texto, /✍️ Escribe el canon/);
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
  await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.datos.arrendatario_numero_documento, '1020345678');
});

test('edificio escrito: se guarda, se pregunta el apartamento y queda como botón', async () => {
  const catalogo = Catalogo.enMemoria();
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  a.iniciar(e);
  let s = await a.recibirTexto(e, 'Laura Pérez CC 165645678');
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
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
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
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
    coarrendatarios: [],
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
  assert.match(
    s.tarjeta.texto,
    /🔁 Cambios respecto al contrato anterior:\n• Fecha de inicio: 15 de julio de 2026 → 15 de octubre de 2026$/m,
    'solo cambia la fecha: el resto queda igual',
  );
  assert.ok(e.base?.id, 'se sabe cuál contrato se renueva (para comparar con su Word)');

  // Corregir el canon aparece como cambio.
  s = await a.recibirBoton(e, 'resumen:corregir');
  s = await a.recibirBoton(e, boton(s, 'Canon'));
  s = await a.recibirTexto(e, '1.100.000');
  assert.match(s.tarjeta.texto, /• Canon \(arriendo mensual\): \$1\.000\.000 → \$1\.100\.000/);

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.ok(s.generar);
  await catalogo.registrarContrato(s.generar);
  assert.equal(
    catalogo.arrendatario('80123456')!.ultimoContrato!.fecha_inicio,
    '2026-10-15',
    'la renovación pasa a ser el último contrato',
  );
});

/** Extractor falso: devuelve lo guionizado para cada texto y registra el contexto recibido. */
function extractorFalso(respuestas: Record<string, Record<string, unknown>>) {
  const llamadas: { texto: string; contexto: ContextoExtraccion }[] = [];
  return {
    llamadas,
    extractor: {
      extraer: async (texto: string, contexto: ContextoExtraccion) => {
        llamadas.push({ texto, contexto });
        return respuestas[texto] ?? {};
      },
    },
  };
}

test('mensaje libre: varios datos de una vez y solo se pregunta lo que falta', async () => {
  const catalogo = Catalogo.enMemoria({ edificios: [{ direccion: 'Carrera 105 i 67 d 31, Bogotá', ultimoUso: 1 }] });
  const { extractor, llamadas } = extractorFalso({
    'apto 501, 750 mil, 200 de depósito, 3 meses desde el 15': {
      apartamento: '501',
      precio_mensual: 750_000,
      deposito: 200_000,
      duracion_meses: 3,
      fecha_inicio: '2026-10-15',
    },
    'cambia el canon a 800 mil': { precio_mensual: 800_000 },
    'precio 50 y 2 personas': { precio_mensual: 50, numero_ocupantes: 2 },
  });
  const a = new Asistente(catalogo, () => HOY, extractor);
  const e = estadoInicial();
  a.iniciar(e);
  await a.recibirTexto(e, 'Laura Gómez Pérez CC 1020345678');
  await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.paso, 'inmueble');

  let s = await a.recibirTexto(e, 'apto 501, 750 mil, 200 de depósito, 3 meses desde el 15');
  assert.equal(llamadas.length, 1);
  assert.deepEqual(llamadas[0]!.contexto.edificios, ['Carrera 105 i 67 d 31, Bogotá']);
  assert.equal(e.datos.inmueble_direccion, 'Carrera 105 i 67 d 31 apto 501, Bogotá', 'el único edificio completa el apto');
  assert.match(s.tarjeta.texto, /✍️ Entendí: inmueble, canon \(arriendo mensual\), depósito, duración, fecha de inicio\./);
  assert.match(s.tarjeta.texto, /Del 15 de octubre de 2026 al 14 de enero de 2027/);
  assert.equal(e.paso, 'ocupantes', 'salta a lo primero que falta');

  // Un dato solo se interpreta localmente, sin llamar a Claude.
  s = await a.recibirTexto(e, '2');
  assert.equal(llamadas.length, 1);
  s = await a.recibirBoton(e, boton(s, 'blanco'));
  s = await a.recibirBoton(e, boton(s, 'La del inmueble'));
  assert.equal(e.paso, 'resumen');

  // Corrección escrita desde el resumen.
  s = await a.recibirTexto(e, 'cambia el canon a 800 mil');
  assert.equal(e.paso, 'resumen');
  assert.equal(e.datos.precio_mensual, 800_000);
  assert.match(s.tarjeta.texto, /✍️ Entendí: canon/);

  // Lo inválido no se guarda y se avisa; lo válido sí.
  s = await a.recibirTexto(e, 'precio 50 y 2 personas');
  assert.equal(e.datos.precio_mensual, 800_000);
  assert.match(s.tarjeta.texto, /⚠️ Canon \(arriendo mensual\): El canon parece demasiado bajo/);

  // Si no entiende nada, responde como siempre.
  s = await a.recibirTexto(e, 'hola');
  assert.match(s.tarjeta.texto, /Usa los botones o escribe qué cambiar/);
});

test('mensaje libre al empezar: todo en un mensaje, incluso el arrendatario', async () => {
  const { extractor } = extractorFalso({
    'Laura Gómez CC 1020345678, Calle 80 # 12-34, 900 mil, 6 meses': {
      arrendatario_nombre: 'Laura Gómez',
      arrendatario_numero_documento: '1020345678',
      inmueble_direccion: 'Calle 80 # 12-34',
      precio_mensual: 900_000,
      duracion_meses: 6,
    },
  });
  const catalogo = Catalogo.enMemoria();
  const a = new Asistente(catalogo, () => HOY, extractor);
  const e = estadoInicial();
  const s = await a.recibirTexto(e, 'Laura Gómez CC 1020345678, Calle 80 # 12-34, 900 mil, 6 meses');
  assert.equal(s.nueva, true);
  assert.equal(e.datos.arrendatario_nombre, 'LAURA GÓMEZ');
  assert.equal(e.paso, 'unidad', 'edificio sin apartamento: falta preguntar cuál');
  assert.deepEqual(catalogo.edificios(), ['Calle 80 # 12-34']);
  assert.equal(e.datos.precio_mensual, 900_000);
});

test('mensaje libre: el apartamento queda en el formato de siempre aunque llegue después de la ciudad', async () => {
  const { extractor } = extractorFalso({
    'el de la 105 apto 302 a 1.2 millones por un año': {
      inmueble_direccion: 'Carrera 105 i 67 d 31, Bogotá apto 302',
      precio_mensual: 1_200_000,
      duracion_meses: 12,
    },
  });
  const a = new Asistente(Catalogo.enMemoria(), () => HOY, extractor);
  const e = estadoInicial();
  a.iniciar(e);
  await a.recibirTexto(e, 'Laura Gómez Pérez CC 1020345678');
  await a.recibirBoton(e, 'confirmar_documento:ok');
  await a.recibirTexto(e, 'el de la 105 apto 302 a 1.2 millones por un año');
  assert.equal(e.datos.inmueble_direccion, 'Carrera 105 i 67 d 31 apto 302, Bogotá');
  assert.equal(e.paso, 'deposito');
});

// --- Co-arrendatarios ---------------------------------------------------------------------------

const contratoBase = {
  arrendatario_nombre: 'LAURA GÓMEZ PÉREZ',
  arrendatario_tipo_documento: 'CC' as const,
  arrendatario_numero_documento: '1020345678',
  coarrendatarios: [] as { nombre: string; tipo: 'CC' | 'CE' | 'PA' | 'PPT'; numero: string }[],
  inmueble_direccion: 'Carrera 105 i 67 d 31 apto 201, Bogotá',
  precio_mensual: 1_500_000,
  deposito: 0,
  duracion_meses: 6,
  fecha_inicio: '2026-11-01',
  numero_ocupantes: 3,
  arrendatario_celular: '',
  arrendatario_correo: '',
  arrendatario_direccion: 'Carrera 105 i 67 d 31 apto 201, Bogotá',
  numero_ejemplares: 2,
};
const lineasDeFirma = (t: string) => t.match(/______________________________/g)!.length;

test('contrato con un arrendatario: encabezado igual que antes y sin firmas extra', async () => {
  const texto = textoDocx((await renderer.generar(contratoBase)).docx);
  assert.match(
    texto,
    /LAURA GÓMEZ PÉREZ, identificado con cédula de ciudadanía No\. 1\.020\.345\.678, quien para efectos de este contrato obra en nombre propio y se denominará EL ARRENDATARIO, manifestaron/,
  );
  assert.equal(lineasDeFirma(texto), 2, 'solo arrendador y arrendatario');
  assert.doesNotMatch(texto, /solidariamente y se denominarán/);
  assert.doesNotMatch(texto, /[{}]/);
});

test('contrato con co-arrendatarios: todos en el encabezado, solidarios, y con su firma', async () => {
  const datos = {
    ...contratoBase,
    coarrendatarios: [
      { nombre: 'PEDRO RUIZ DÍAZ', tipo: 'CC' as const, numero: '80123456' },
      { nombre: 'ANA MARÍA LÓPEZ', tipo: 'CE' as const, numero: '987654' },
    ],
  };
  const texto = textoDocx((await renderer.generar(datos)).docx);
  assert.match(
    texto,
    /LAURA GÓMEZ PÉREZ, identificado con cédula de ciudadanía No\. 1\.020\.345\.678, PEDRO RUIZ DÍAZ, identificado con cédula de ciudadanía No\. 80\.123\.456, y ANA MARÍA LÓPEZ, identificado con cédula de extranjería No\. 987\.654, quienes para efectos de este contrato obran en nombre propio, se obligan solidariamente y se denominarán EL ARRENDATARIO, manifestaron/,
  );
  assert.match(texto, /PEDRO RUIZ DÍAZC\.C\. 80\.123\.456/, 'firma de Pedro');
  assert.match(texto, /ANA MARÍA LÓPEZC\.E\. 987\.654/, 'firma de Ana');
  assert.equal(lineasDeFirma(texto), 4, 'una línea de firma más por co-arrendatario');
  assert.doesNotMatch(texto, /[{}]/);
});

const LAURA = { nombre: 'LAURA GÓMEZ PÉREZ', numero: '1020345678', tipo: 'CC' as const };
const PEDRO = { nombre: 'PEDRO RUIZ DÍAZ', numero: '80123456', tipo: 'CC' as const };

test('segunda cédula: se agrega como co-arrendatario y se sigue donde iba', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  let s = await a.recibirDocumento(e, LAURA);
  s = await a.recibirBoton(e, boton(s, 'Sí, continuar'));
  assert.equal(e.paso, 'inmueble');

  s = await a.recibirDocumento(e, PEDRO);
  assert.equal(s.nueva, false);
  assert.match(s.tarjeta.texto, /¿Es otro arrendatario de este contrato\?/);
  assert.deepEqual(etiquetas(s), [['👥 Agregar como otro arrendatario'], ['🔄 Reemplazar a LAURA'], ['✏️ Corregir']]);

  s = await a.recibirBoton(e, boton(s, 'Agregar como otro'));
  assert.deepEqual(e.datos.coarrendatarios, [{ nombre: 'PEDRO RUIZ DÍAZ', tipo: 'CC', numero: '80123456' }]);
  assert.match(s.tarjeta.texto, /👥 Agregué a PEDRO RUIZ DÍAZ como arrendatario/);
  assert.match(s.tarjeta.texto, /👥 PEDRO RUIZ DÍAZ · C\.C\. 80\.123\.456/);
  assert.equal(e.paso, 'inmueble', 'vuelve a la pregunta en curso');

  // La misma cédula otra vez no se duplica.
  s = await a.recibirDocumento(e, PEDRO);
  s = await a.recibirBoton(e, boton(s, 'Agregar como otro'));
  assert.equal(e.datos.coarrendatarios!.length, 1);
  assert.match(s.tarjeta.texto, /ya está en el contrato/);
});

test('reemplazar al principal lo saca de los co-arrendatarios si estaba', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  let s = await a.recibirDocumento(e, LAURA);
  s = await a.recibirBoton(e, boton(s, 'Sí, continuar'));
  s = await a.recibirDocumento(e, PEDRO);
  s = await a.recibirBoton(e, boton(s, 'Agregar como otro'));
  s = await a.recibirDocumento(e, PEDRO);
  s = await a.recibirBoton(e, boton(s, 'Reemplazar a LAURA'));
  assert.equal(e.datos.arrendatario_nombre, 'PEDRO RUIZ DÍAZ');
  assert.deepEqual(e.datos.coarrendatarios, []);
});

test('dos fotos seguidas: la primera queda como principal y la segunda se puede agregar', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  await a.recibirDocumento(e, LAURA);
  const s = await a.recibirDocumento(e, PEDRO);
  assert.equal(e.datos.arrendatario_nombre, 'LAURA GÓMEZ PÉREZ');
  assert.match(s.tarjeta.texto, /🪪 Arrendatario: LAURA GÓMEZ PÉREZ\./);
  assert.equal(e.documento?.numero, '80123456');
  await a.recibirBoton(e, boton(s, 'Agregar como otro'));
  assert.equal(e.datos.coarrendatarios!.length, 1);
});

test('máximo de co-arrendatarios', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  let s = await a.recibirDocumento(e, LAURA);
  s = await a.recibirBoton(e, boton(s, 'Sí, continuar'));
  for (const [i, n] of ['11111111', '22222222', '33333333', '44444444'].entries()) {
    s = await a.recibirDocumento(e, { nombre: ['ANA RUIZ', 'JUAN PAZ', 'LUIS MORA', 'EVA SOTO'][i], numero: n, tipo: 'CC' });
    s = await a.recibirBoton(e, boton(s, 'Agregar como otro'));
  }
  assert.equal(e.datos.coarrendatarios!.length, 3);
  assert.match(s.tarjeta.texto, /Máximo 3 co-arrendatarios/);
});

test('corregir: quitar co-arrendatario, y ocupantes no menos que arrendatarios', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  const { numero_ocupantes: _, ...sinOcupantes } = contratoBase;
  Object.assign(e.datos, {
    ...sinOcupantes,
    coarrendatarios: [{ nombre: 'PEDRO RUIZ DÍAZ', tipo: 'CC', numero: '80123456' }],
  });
  e.paso = 'resumen';
  let s = await a.recibirBoton(e, 'resumen:generar'); // falta ocupantes: lo pregunta
  assert.equal(e.paso, 'ocupantes');
  assert.equal(etiquetas(s)![0]![0], '2', 'las opciones empiezan en el número de arrendatarios');
  s = await a.recibirTexto(e, '1');
  assert.match(s.tarjeta.texto, /Son 2 arrendatarios: los ocupantes no pueden ser menos/);
  s = await a.recibirTexto(e, '2');
  assert.equal(e.paso, 'resumen');
  assert.match(s.tarjeta.texto, /¿Otro arrendatario\? Envía su cédula/);

  s = await a.recibirBoton(e, 'resumen:corregir');
  assert.ok(etiquetas(s)!.flat().includes('🪪 Arrendatario principal'));
  s = await a.recibirBoton(e, boton(s, 'Quitar co-arrendatario'));
  s = await a.recibirBoton(e, boton(s, 'PEDRO'));
  assert.deepEqual(e.datos.coarrendatarios, []);
  assert.equal(e.paso, 'resumen');
  assert.match(s.tarjeta.texto, /🗑 Quité a PEDRO RUIZ DÍAZ/);
});

test('renovar un contrato guardado antes de los co-arrendatarios', async () => {
  const { coarrendatarios: _, ...viejo } = contratoBase;
  const catalogo = Catalogo.enMemoria({
    arrendatarios: {
      '1020345678': {
        tipo: 'CC',
        numero: '1020345678',
        nombre: 'LAURA GÓMEZ PÉREZ',
        ultimoUso: 1,
        ultimoContrato: viejo as typeof contratoBase,
      },
    },
  });
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  let s = a.renovar(e);
  s = await a.recibirBoton(e, boton(s, 'LAURA'));
  assert.deepEqual(e.datos.coarrendatarios, []);
  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.ok(s.generar, 'se puede generar');
});

test('IA caída: un monto no se toma como cédula, nombre y número llegan por separado y se corrige desde el resumen', async () => {
  const caido = { extraer: async () => Promise.reject(new Error('401 invalid x-api-key')) };
  const a = new Asistente(Catalogo.enMemoria(), () => HOY, caido);
  const e = estadoInicial();
  a.iniciar(e);

  let s = await a.recibirTexto(e, 'Brayan munar casques');
  assert.equal(e.paso, 'documento');
  assert.match(s.tarjeta.texto, /¿Cuál es el número de documento de Brayan munar casques\?/);

  s = await a.recibirTexto(e, 'El paga 600000 pesos');
  assert.equal(e.paso, 'documento', 'una frase con un monto no es nombre y cédula');
  assert.equal(e.datos.arrendatario_nombre, undefined);

  s = await a.recibirTexto(e, 'Número de cédula 1019141472');
  assert.equal(e.paso, 'confirmar_documento', 'se junta con el nombre anterior y se confirma');
  assert.match(s.tarjeta.texto, /Brayan munar casques\nCédula de ciudadanía: C\.C\. 1\.019\.141\.472/i);
  await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.datos.arrendatario_nombre, 'BRAYAN MUNAR CASQUES');

  Object.assign(e.datos, {
    inmueble_direccion: 'Carrera 105 I # 67 d - 31 apto 7',
    precio_mensual: 600_000,
    deposito: 200_000,
    duracion_meses: 3,
    fecha_inicio: '2026-08-01',
    numero_ocupantes: 1,
    arrendatario_celular: '3144397571',
    arrendatario_correo: '',
    arrendatario_direccion: 'Carrera 105 I # 67 d - 31 apto 7',
  });
  e.paso = 'corregir';
  s = await a.recibirBoton(e, 'corregir:volver');
  assert.equal(e.paso, 'resumen');
  assert.match(s.tarjeta.texto, /🔎 Revisa antes de generar:\n• La fecha de inicio \(1 de agosto de 2026\) ya pasó/);

  // Una cédula escrita sola corrige al arrendatario, con confirmación.
  s = await a.recibirTexto(e, '1019141400');
  assert.equal(e.paso, 'confirmar_documento');
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.paso, 'resumen');
  assert.equal(e.datos.arrendatario_numero_documento, '1019141400');
  assert.equal(e.datos.arrendatario_nombre, 'BRAYAN MUNAR CASQUES');

  // Un número que no parece cédula no la cambia, y avisa que la IA no respondió.
  s = await a.recibirTexto(e, '600000');
  assert.equal(e.paso, 'resumen');
  assert.match(s.tarjeta.texto, /No pude usar la IA/);
});

test('IA caída: todo en un mensaje, igual saca nombre y cédula', async () => {
  const caido = { extraer: async () => Promise.reject(new Error('sin conexión')) };
  const a = new Asistente(Catalogo.enMemoria(), () => HOY, caido);
  const e = estadoInicial();
  a.iniciar(e);
  await a.recibirTexto(e, 'Brayan munar Vásquez\nNúmero de Cédula \n1019141472\nPaga 600000 pesos\nUn canon de arrendamiento de 600000');
  assert.equal(e.paso, 'confirmar_documento');
  assert.deepEqual(e.documento, { tipo: 'CC', nombre: 'Brayan munar Vásquez', numero: '1019141472' });
});

test('nombre y cédula que no son reales se rechazan', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  await a.recibirDocumento(e, { nombre: 'El paga pesos', numero: '600000' });
  let s = await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.paso, 'documento');
  assert.match(s.tarjeta.texto, /no parece un nombre de persona/);

  await a.recibirDocumento(e, { nombre: 'Laura Gómez', numero: 'AB12345' });
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.match(s.tarjeta.texto, /La cédula de ciudadanía tiene solo dígitos/);
});

test('verificación fallida: pide el dato que falta o da un mensaje general', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY);
  const e = estadoInicial();
  Object.assign(e.datos, {
    arrendatario_nombre: 'LAURA GÓMEZ PÉREZ',
    arrendatario_tipo_documento: 'CC',
    arrendatario_numero_documento: '1020345678',
    inmueble_direccion: 'Calle 9 # 8-7 apto 302',
    precio_mensual: 750_000,
    deposito: 0,
    duracion_meses: 6,
    fecha_inicio: '2026-11-01',
    numero_ocupantes: 1,
    arrendatario_celular: '',
    arrendatario_correo: '',
    arrendatario_direccion: 'Calle 9 # 8-7 apto 302',
  });
  e.paso = 'listo';

  let s = a.problemaAlGenerar(e, [{ tipo: 'dato_faltante', campo: 'fecha_inicio', detalle: 'Falta fecha de inicio.' }]);
  assert.equal(e.paso, 'fecha');
  assert.match(s.tarjeta.texto, /⚠️ No envié el contrato: falta o no es válido el dato "Fecha de inicio"/);
  s = await a.recibirTexto(e, '15/11/2026');
  assert.equal(e.paso, 'resumen', 'con el dato corregido vuelve al resumen');

  e.paso = 'listo';
  s = a.problemaAlGenerar(e, [{ tipo: 'dato_invalido', campo: 'arrendatario_nombre', detalle: 'Eso no parece un nombre.' }]);
  assert.equal(e.paso, 'documento');
  assert.match(s.tarjeta.texto, /Envía una foto de la cédula/);

  e.paso = 'listo';
  s = a.problemaAlGenerar(e, [{ tipo: 'texto_modificado', detalle: 'Párrafo 3: …' }]);
  assert.equal(e.paso, 'resumen');
  assert.match(s.tarjeta.texto, /el documento no pasó la verificación/);
  assert.doesNotMatch(s.tarjeta.texto, /Párrafo 3/, 'el detalle técnico va a la bitácora, no al chat');
});

test('fecha: atajos, calendario por meses y "atrás" que vuelve al resumen al corregir', async () => {
  const a = new Asistente(Catalogo.enMemoria(), () => HOY); // HOY = viernes 2 de octubre de 2026
  const e = estadoInicial();
  Object.assign(e.datos, {
    arrendatario_nombre: 'LAURA GÓMEZ PÉREZ',
    arrendatario_tipo_documento: 'CC',
    arrendatario_numero_documento: '1020345678',
    inmueble_direccion: 'Calle 9 # 8-7 apto 302',
    precio_mensual: 750_000,
    deposito: 0,
    duracion_meses: 6,
    fecha_inicio: '2026-11-01',
    numero_ocupantes: 1,
    arrendatario_celular: '',
    arrendatario_correo: '',
    arrendatario_direccion: 'Calle 9 # 8-7 apto 302',
  });
  e.paso = 'corregir';

  let s = await a.recibirBoton(e, 'corregir:fecha');
  assert.deepEqual(etiquetas(s), [
    ['Hoy · 2 oct', 'Mañana · 3 oct'],
    ['15 oct', '1 nov'],
    ['📅 Otra fecha', '↩️ Volver al resumen'],
  ]);

  // Corrigiendo, "atrás" vuelve al resumen sin cambiar nada (antes llevaba a la pregunta de la duración).
  s = await a.recibirBoton(e, boton(s, 'Volver al resumen'));
  assert.equal(e.paso, 'resumen');
  assert.equal(e.datos.fecha_inicio, '2026-11-01');

  s = await a.recibirBoton(e, 'resumen:corregir');
  s = await a.recibirBoton(e, 'corregir:fecha');
  s = await a.recibirBoton(e, boton(s, 'Otra fecha'));
  assert.match(s.tarjeta.texto, /Toca el día, o escríbela/);
  let filas = etiquetas(s)!;
  assert.deepEqual(filas[0], ['◀️', 'octubre de 2026', '▶️']);
  assert.deepEqual(filas[1], ['L', 'M', 'M', 'J', 'V', 'S', 'D']);
  assert.deepEqual(filas[2], ['·', '·', '·', '1', '[2]', '3', '4'], 'el 1 de octubre de 2026 es jueves; hoy entre corchetes');
  assert.deepEqual(filas.at(-1), ['⬅️ Atrás']);

  s = await a.recibirBoton(e, boton(s, '▶️'));
  filas = etiquetas(s)!;
  assert.deepEqual(filas[0]![1], 'noviembre de 2026');
  assert.deepEqual(filas[2], ['·', '·', '·', '·', '·', '·', '✅1'], 'la fecha ya elegida va marcada');

  s = await a.recibirBoton(e, boton(s, '10'));
  assert.equal(e.paso, 'resumen', 'al tocar el día vuelve al resumen');
  assert.equal(e.datos.fecha_inicio, '2026-11-10');
  assert.match(s.tarjeta.texto, /Del 10 de noviembre de 2026/);

  // Un botón del calendario con otro formato se ignora.
  e.paso = 'fecha';
  assert.equal((await a.recibirBoton(e, 'fecha:d2026-13')).obsoleto, true);
});

/** Contrato guardado como el de "EL PAGA PESOS" del 8 de octubre (apto 7, desde el 10 de octubre, 3 meses). */
const PAGA_PESOS = {
  arrendatario_nombre: 'EL PAGA PESOS',
  arrendatario_tipo_documento: 'CC' as const,
  arrendatario_numero_documento: '600000',
  coarrendatarios: [],
  inmueble_direccion: 'Carrera 105 I # 67 d - 31 apto 7',
  precio_mensual: 600_000,
  deposito: 200_000,
  duracion_meses: 3,
  fecha_inicio: '2026-10-10',
  numero_ocupantes: 1,
  arrendatario_celular: '3144397571',
  arrendatario_correo: '',
  arrendatario_direccion: 'Carrera 105 I # 67 d - 31 apto 7',
  numero_ejemplares: 2,
};

test('contrato que se cruza con otro del mismo inmueble: avisa y permite reemplazarlo', async () => {
  const catalogo = Catalogo.enMemoria();
  const id = await catalogo.registrarContrato(PAGA_PESOS);
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();
  Object.assign(e.datos, {
    ...PAGA_PESOS,
    arrendatario_nombre: 'BRAYAN MUNAR VÁSQUEZ',
    arrendatario_numero_documento: '1019141472',
  });
  e.paso = 'corregir';

  let s = await a.recibirBoton(e, 'corregir:volver');
  assert.match(
    s.tarjeta.texto,
    /⚠️ Ya hay un contrato en este inmueble en esas fechas:\n• EL PAGA PESOS · del 10 oct 2026 al 9 ene 2027\nSi este lo reemplaza/,
  );
  assert.deepEqual(etiquetas(s), [['✅ Generar contrato'], ['🔄 Reemplazar a EL PAGA'], ['✏️ Corregir', '❌ Cancelar']]);

  s = await a.recibirBoton(e, boton(s, 'Reemplazar'));
  assert.deepEqual(e.reemplaza, [id]);
  assert.doesNotMatch(s.tarjeta.texto, /Ya hay un contrato/);
  assert.match(s.tarjeta.texto, /🔄 Al generar se borrará del historial:\n• EL PAGA PESOS · del 10 oct 2026/);

  s = await a.recibirBoton(e, boton(s, 'No reemplazar'));
  assert.equal(e.reemplaza, undefined);
  assert.match(s.tarjeta.texto, /Ya hay un contrato/);

  s = await a.recibirBoton(e, boton(s, 'Reemplazar'));
  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.ok(s.generar);
  assert.deepEqual(e.reemplaza, [id], 'el adaptador borra estos contratos después de guardar el nuevo');

  // Un contrato que empieza cuando el otro termina (renovación) no se cruza.
  const otro = estadoInicial();
  Object.assign(otro.datos, { ...PAGA_PESOS, arrendatario_numero_documento: '1019141472', arrendatario_nombre: 'BRAYAN MUNAR VÁSQUEZ', fecha_inicio: '2027-01-10' });
  otro.paso = 'corregir';
  assert.doesNotMatch((await a.recibirBoton(otro, 'corregir:volver')).tarjeta.texto, /Ya hay un contrato/);
});

test('corregir un contrato ya generado: se elige, se cambia lo que esté mal y reemplaza al anterior', async () => {
  const vacio = new Asistente(Catalogo.enMemoria(), () => HOY);
  assert.match(vacio.corregirContrato(estadoInicial()).tarjeta.texto, /Todavía no hay contratos generados/);

  const catalogo = Catalogo.enMemoria();
  const id = await catalogo.registrarContrato(PAGA_PESOS);
  const a = new Asistente(catalogo, () => HOY);
  const e = estadoInicial();

  let s = a.corregirContrato(e);
  assert.equal(s.nueva, true);
  assert.equal(e.paso, 'elegir_correccion');
  assert.deepEqual(etiquetas(s), [['EL PAGA · apto 7 · desde 10 oct 2026']]);

  s = await a.recibirBoton(e, boton(s, 'EL PAGA'));
  assert.equal(e.paso, 'resumen');
  assert.deepEqual(e.reemplaza, [id]);
  assert.match(s.tarjeta.texto, /✏️ Corrección del contrato de EL PAGA PESOS \(desde el 10 de octubre de 2026\)/);
  assert.match(s.tarjeta.texto, /✏️ Sin cambios respecto al contrato que se corrige\./);
  assert.doesNotMatch(s.tarjeta.texto, /Ya hay un contrato/, 'el contrato que se corrige no cuenta como cruce');

  // Se corrige el arrendatario escribiendo nombre y cédula desde el resumen.
  s = await a.recibirTexto(e, 'Brayan Munar Vásquez 1019141472');
  assert.equal(e.paso, 'confirmar_documento');
  s = await a.recibirBoton(e, 'confirmar_documento:ok');
  assert.equal(e.paso, 'resumen');
  assert.match(
    s.tarjeta.texto,
    /✏️ Cambios respecto al contrato que se corrige:\n• Arrendatario: EL PAGA PESOS → BRAYAN MUNAR VÁSQUEZ\n• Número de documento: 600000 → 1019141472/,
  );
  assert.deepEqual(etiquetas(s), [['✅ Generar contrato'], ['✏️ Corregir', '❌ Cancelar']], 'sin "No reemplazar": es una corrección');

  s = await a.recibirBoton(e, boton(s, 'Generar'));
  assert.equal(s.generar?.arrendatario_numero_documento, '1019141472');
  assert.deepEqual(e.reemplaza, [id]);
});
