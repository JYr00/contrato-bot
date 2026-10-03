import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cantidad, enteroALetras, fechaALetras, pesosALetras } from './numero-a-letras.js';
import { camposFaltantes, validarParcial } from './schema.js';

test('números a letras', () => {
  assert.equal(enteroALetras(0), 'CERO');
  assert.equal(enteroALetras(100), 'CIEN');
  assert.equal(enteroALetras(101), 'CIENTO UNO');
  assert.equal(enteroALetras(21_000), 'VEINTIÚN MIL');
  assert.equal(enteroALetras(1_250_000), 'UN MILLÓN DOSCIENTOS CINCUENTA MIL');
  assert.equal(enteroALetras(31_000_001), 'TREINTA Y UN MILLONES UNO');
  assert.equal(enteroALetras(999_999), 'NOVECIENTOS NOVENTA Y NUEVE MIL NOVECIENTOS NOVENTA Y NUEVE');
});

test('pesos en letras', () => {
  assert.equal(pesosALetras(1_500_000), 'UN MILLÓN QUINIENTOS MIL PESOS ($1.500.000)');
  assert.equal(pesosALetras(2_000_000), 'DOS MILLONES DE PESOS ($2.000.000)');
  assert.equal(pesosALetras(850_000), 'OCHOCIENTOS CINCUENTA MIL PESOS ($850.000)');
  assert.equal(pesosALetras(1_000_000), 'UN MILLÓN DE PESOS ($1.000.000)');
});

test('cantidades con género', () => {
  assert.equal(cantidad(1, 'persona', 'personas', true), 'una (1) persona');
  assert.equal(cantidad(21, 'persona', 'personas', true), 'veintiuna (21) personas');
  assert.equal(cantidad(1, 'mes', 'meses'), 'un (1) mes');
  assert.equal(cantidad(12, 'mes', 'meses'), 'doce (12) meses');
});

test('fecha en letras', () => {
  assert.equal(fechaALetras('2026-11-01'), '1 de noviembre de 2026');
});

test('validación parcial normaliza y reporta errores', () => {
  const r = validarParcial({
    arrendatario_nombre: '  laura   gómez pérez ',
    arrendatario_numero_documento: '1.020.345.678',
    arrendatario_celular: '+57 310 555 1234',
    arrendatario_correo: 'no-es-correo',
    fecha_inicio: '2026-02-30',
    campo_raro: 'x',
  });
  assert.equal(r.guardados.arrendatario_nombre, 'LAURA GÓMEZ PÉREZ');
  assert.equal(r.guardados.arrendatario_numero_documento, '1020345678');
  assert.equal(r.guardados.arrendatario_celular, '3105551234');
  assert.ok(r.errores.arrendatario_correo);
  assert.ok(r.errores.fecha_inicio);
  assert.deepEqual(r.ignorados, ['campo_raro']);
});

test('campos faltantes', () => {
  assert.equal(camposFaltantes({}).length, 14);
});
