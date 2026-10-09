import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import PizZip from 'pizzip';

import { ContractRenderer } from './render.js';
import type { DatosContrato } from './schema.js';
import { compararConAnterior, textoFijoCambiado, verificarContrato, verificarDatos } from './verificar.js';

const plantilla = await readFile('templates/contrato-arrendamiento.docx');
const arrendador = { correo: 'arrendador@example.com', celular: '3001112233' };
const renderer = new ContractRenderer(plantilla, arrendador, '/no/existe');

const DATOS: DatosContrato = {
  numero_ejemplares: 2,
  coarrendatarios: [],
  arrendatario_nombre: 'LAURA GÓMEZ PÉREZ',
  arrendatario_tipo_documento: 'CC',
  arrendatario_numero_documento: '1020345678',
  inmueble_direccion: 'Carrera 105 i 67 d 31 apto 201, Bogotá',
  precio_mensual: 750_000,
  deposito: 200_000,
  duracion_meses: 6,
  fecha_inicio: '2026-11-01',
  numero_ocupantes: 2,
  arrendatario_celular: '3105551234',
  arrendatario_correo: 'laura@example.com',
  arrendatario_direccion: 'Carrera 105 i 67 d 31 apto 201, Bogotá',
};

const verificar = (datos: DatosContrato, docx = renderer.renderDocx(datos), p = plantilla) =>
  verificarContrato({ plantilla: p, docx, datos, arrendador });

/** Cambia el texto de word/document.xml de un .docx (para simular documentos alterados). */
function alterar(docx: Buffer, de: string | RegExp, a: string): Buffer {
  const zip = new PizZip(docx);
  const xml = zip.file('word/document.xml')!.asText();
  const nuevo = xml.replace(de, a);
  assert.notEqual(nuevo, xml, `no se encontró ${de} en el documento`);
  zip.file('word/document.xml', nuevo);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}

test('contratos bien generados pasan la verificación en todas sus variantes', () => {
  const variantes: Partial<DatosContrato>[] = [
    {},
    { deposito: 0 },
    { coarrendatarios: [{ nombre: 'PEDRO RUIZ DÍAZ', tipo: 'CC', numero: '80123456' }] },
    {
      coarrendatarios: [
        { nombre: 'PEDRO RUIZ DÍAZ', tipo: 'CC', numero: '80123456' },
        { nombre: 'ANA MARÍA SOTO', tipo: 'CE', numero: '987654' },
        { nombre: 'JOHN SMITH', tipo: 'PA', numero: 'X1234567' },
      ],
      numero_ocupantes: 4,
    },
    { arrendatario_celular: '', arrendatario_correo: '' },
    { precio_mensual: 31_000_001, deposito: 1_000_000, duracion_meses: 1, numero_ocupantes: 1 },
  ];
  for (const v of variantes) {
    const r = verificar({ ...DATOS, ...v });
    assert.deepEqual(r, { ok: true, problemas: [] }, JSON.stringify(v));
  }
});

test('texto fijo alterado se detecta como texto modificado', () => {
  const docx = alterar(renderer.renderDocx(DATOS), 'Primera.', 'Primero.');
  const r = verificar(DATOS, docx);
  assert.equal(r.ok, false);
  assert.equal(r.problemas[0]?.tipo, 'texto_modificado');
  assert.match(r.problemas[0]!.detalle, /Primero/);
});

test('un dato que no quedó en el documento se detecta con su campo', () => {
  const docx = alterar(renderer.renderDocx(DATOS), 'SETECIENTOS CINCUENTA MIL', 'SEISCIENTOS MIL');
  const r = verificar(DATOS, docx);
  assert.equal(r.ok, false);
  assert.ok(r.problemas.some((p) => p.tipo === 'dato_distinto' && p.campo === 'precio_mensual'));
});

test('un párrafo de más o de menos se detecta', () => {
  const docx = renderer.renderDocx({ ...DATOS, deposito: 0 });
  const r = verificar(DATOS, docx); // se esperaba el parágrafo del depósito
  assert.equal(r.ok, false);
  assert.equal(r.problemas[0]?.tipo, 'parrafos_distintos');
});

test('un tag mal escrito en la plantilla se detecta (docxtemplater lo llenaría con rayas)', () => {
  const rota = alterar(plantilla, /duracion_texto/, 'duracion_txt');
  const docx = new ContractRenderer(rota, arrendador, '/no/existe').renderDocx(DATOS);
  const r = verificar(DATOS, docx, rota);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problemas.map((p) => p.tipo), ['plantilla']);
  assert.match(r.problemas[0]!.detalle, /\{duracion_txt\}/);
});

test('datos faltantes o inválidos se reportan con su campo, antes de mirar el documento', () => {
  const { fecha_inicio: _, ...sinFecha } = DATOS;
  assert.deepEqual(
    verificarDatos(sinFecha).map((p) => [p.tipo, p.campo]),
    [['dato_faltante', 'fecha_inicio']],
  );
  const conLetras = verificarDatos({ ...DATOS, arrendatario_numero_documento: 'AB12345' });
  assert.deepEqual(conLetras.map((p) => [p.tipo, p.campo]), [['dato_invalido', 'arrendatario_numero_documento']]);
  const frase = verificarDatos({ ...DATOS, arrendatario_nombre: 'EL PAGA PESOS' });
  assert.deepEqual(frase.map((p) => [p.tipo, p.campo]), [['dato_invalido', 'arrendatario_nombre']]);
});

test('renovación: lista solo lo que cambió y detecta si el texto fijo del anterior era otro', () => {
  const nuevo = { ...DATOS, precio_mensual: 800_000, deposito: 0, fecha_inicio: '2027-05-01' };
  assert.deepEqual(
    compararConAnterior(DATOS, nuevo).map((c) => `${c.etiqueta}: ${c.antes} → ${c.despues}`),
    [
      'Canon (arriendo mensual): $750.000 → $800.000',
      'Depósito: $200.000 → $0',
      'Fecha de inicio: 1 de noviembre de 2026 → 1 de mayo de 2027',
    ],
  );

  const anterior = renderer.renderDocx(DATOS);
  assert.deepEqual(textoFijoCambiado({ plantilla, docxAnterior: anterior, anterior: DATOS, arrendador }), []);
  const otraPlantilla = alterar(anterior, 'Primera.', 'Primero.');
  assert.equal(textoFijoCambiado({ plantilla, docxAnterior: otraPlantilla, anterior: DATOS, arrendador }).length, 1);
});
