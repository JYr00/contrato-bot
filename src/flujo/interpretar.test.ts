import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  interpretarDocumentoEscrito,
  interpretarFecha,
  interpretarMeses,
  interpretarPesos,
  primeroDelMesSiguiente,
  fechaFin,
  interpretarContacto,
  componerDireccion,
  interpretarUnidad,
  separarUnidad,
} from './interpretar.js';

test('pesos escritos de varias formas', () => {
  assert.equal(interpretarPesos('1.500.000'), 1_500_000);
  assert.equal(interpretarPesos('$1,500,000'), 1_500_000);
  assert.equal(interpretarPesos('1500000'), 1_500_000);
  assert.equal(interpretarPesos('1.5 millones'), 1_500_000);
  assert.equal(interpretarPesos('1,2 millones'), 1_200_000);
  assert.equal(interpretarPesos('1 millón 200 mil'), 1_200_000);
  assert.equal(interpretarPesos('850 mil'), 850_000);
  assert.equal(interpretarPesos('900k'), 900_000);
  assert.equal(interpretarPesos('millón y medio'), 1_500_000);
  assert.equal(interpretarPesos('$ 1.200.000 pesos'), 1_200_000);
  assert.equal(interpretarPesos('no sé'), null);
});

test('meses', () => {
  assert.equal(interpretarMeses('9'), 9);
  assert.equal(interpretarMeses('9 meses'), 9);
  assert.equal(interpretarMeses('seis meses'), 6);
  assert.equal(interpretarMeses('un año'), 12);
  assert.equal(interpretarMeses('2 años'), 24);
  assert.equal(interpretarMeses('año y medio'), 18);
  assert.equal(interpretarMeses('nada'), null);
});

test('fechas', () => {
  const hoy = '2026-10-02';
  assert.equal(interpretarFecha('hoy', hoy), '2026-10-02');
  assert.equal(interpretarFecha('mañana', hoy), '2026-10-03');
  assert.equal(interpretarFecha('15/11/2026', hoy), '2026-11-15');
  assert.equal(interpretarFecha('15-11', hoy), '2026-11-15');
  assert.equal(interpretarFecha('1/2', hoy), '2027-02-01', 'sin año: próxima ocurrencia');
  assert.equal(interpretarFecha('2026-12-01', hoy), '2026-12-01');
  assert.equal(interpretarFecha('15 de noviembre', hoy), '2026-11-15');
  assert.equal(interpretarFecha('3 ene 2027', hoy), '2027-01-03');
  assert.equal(interpretarFecha('pronto', hoy), null);
  assert.equal(primeroDelMesSiguiente('2026-12-20'), '2027-01-01');
});

test('documento escrito', () => {
  assert.deepEqual(interpretarDocumentoEscrito('Laura Gómez Pérez CC 1.020.345.678'), {
    tipo: 'CC',
    numero: '1020345678',
    nombre: 'Laura Gómez Pérez',
  });
  assert.deepEqual(interpretarDocumentoEscrito('Juan Pérez, cédula de extranjería No. 987654'), {
    tipo: 'CE',
    numero: '987654',
    nombre: 'Juan Pérez',
  });
  assert.deepEqual(interpretarDocumentoEscrito('1020345678 Ana María Ruiz'), {
    numero: '1020345678',
    nombre: 'Ana María Ruiz',
  });
});

test('fecha de fin y contacto', () => {
  assert.equal(fechaFin('2026-10-15', 3), '2027-01-14');
  assert.equal(fechaFin('2026-11-01', 6), '2027-04-30');
  assert.equal(fechaFin('2027-01-31', 1), '2027-02-27');
  assert.deepEqual(interpretarContacto('310 555 1234 laura@x.com'), { celular: '3105551234', correo: 'laura@x.com' });
  assert.deepEqual(interpretarContacto('laura@x.com'), { celular: '', correo: 'laura@x.com' });
  assert.deepEqual(interpretarContacto('+57 310-555-1234'), { celular: '+573105551234', correo: '' });
  assert.deepEqual(interpretarContacto('ninguno'), { celular: '', correo: '' });
  assert.equal(interpretarContacto('hola'), null);
});

test('edificio y apartamento', () => {
  assert.deepEqual(separarUnidad('Carrera 105 i 67 d 31 apto 501'), { base: 'Carrera 105 i 67 d 31', unidad: '501' });
  assert.deepEqual(separarUnidad('Carrera 105 i 67 d 31 apto 201, Bogotá'), {
    base: 'Carrera 105 i 67 d 31, Bogotá',
    unidad: '201',
  });
  assert.deepEqual(separarUnidad('Calle 5 # 3-2 Apartamento No. 302'), { base: 'Calle 5 # 3-2', unidad: '302' });
  assert.deepEqual(separarUnidad('Calle 5 apartado aéreo'), { base: 'Calle 5 apartado aéreo' });
  assert.equal(componerDireccion('Carrera 105 i 67 d 31, Bogotá', '201'), 'Carrera 105 i 67 d 31 apto 201, Bogotá');
  assert.equal(componerDireccion('Carrera 105 i 67 d 31', '501'), 'Carrera 105 i 67 d 31 apto 501');
  assert.equal(componerDireccion('Calle 9 # 1-2'), 'Calle 9 # 1-2');
  assert.equal(interpretarUnidad('apto 501'), '501');
  assert.equal(interpretarUnidad('501'), '501');
  assert.equal(interpretarUnidad('casa'), '');
});
