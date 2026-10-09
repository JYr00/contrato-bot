import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import PizZip from 'pizzip';

import { ArchivosContratos } from './archivos.js';
import { Respaldo } from './respaldo.js';

test('archivos de contratos: guardar, leer y borrar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contratos-'));
  try {
    const archivos = new ArchivosContratos(join(dir, 'contratos'));
    assert.equal(await archivos.leer('x'), null, 'sin archivos guardados');

    await archivos.guardar('abc-1', { nombreBase: 'n', docx: Buffer.from('docx'), pdf: Buffer.from('pdf') });
    await archivos.guardar('abc-2', { nombreBase: 'n', docx: Buffer.from('solo word'), pdf: null });
    const uno = await archivos.leer('abc-1');
    assert.equal(uno?.docx.toString(), 'docx');
    assert.equal(uno?.pdf?.toString(), 'pdf');
    assert.equal((await archivos.leer('abc-2'))?.pdf, null, 'sin LibreOffice solo hay Word');

    await archivos.borrar('abc-1');
    assert.equal(await archivos.leer('abc-1'), null);
    await archivos.borrar('no-existe'); // no falla
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('respaldo: ZIP con catálogo, contratos y bitácora; diario y solo si hubo cambios', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'respaldo-'));
  try {
    let ahora = Date.now();
    const catalogo = join(dir, 'catalogo.json');
    const r = new Respaldo(catalogo, join(dir, 'ultimo-respaldo.txt'), 1, () => ahora);

    assert.equal(await r.archivo('2026-10-03'), null, 'sin catálogo no hay nada que respaldar');
    await writeFile(catalogo, '{"contratos":[]}');
    await mkdir(join(dir, 'contratos'), { recursive: true });
    await writeFile(join(dir, 'contratos', 'abc-0.docx'), 'word');
    await writeFile(join(dir, 'contratos', 'abc-0.pdf'), 'pdf');
    await mkdir(join(dir, 'logs', 'interacciones'), { recursive: true });
    await writeFile(join(dir, 'logs', 'interacciones', '2026-10-03.jsonl'), '{}\n');
    await writeFile(join(dir, 'sesiones.json'), '[]'); // no va: es temporal

    const archivo = await r.archivo('2026-10-03');
    assert.equal(archivo?.nombre, 'respaldo-contratos-2026-10-03.zip');
    assert.equal(archivo?.sinBitacora, false);
    const zip = new PizZip(archivo!.datos);
    assert.deepEqual(Object.keys(zip.files).filter((f) => !zip.files[f]!.dir).sort(), [
      'catalogo.json',
      'contratos/abc-0.docx',
      'contratos/abc-0.pdf',
      'logs/interacciones/2026-10-03.jsonl',
    ]);
    assert.equal(zip.file('catalogo.json')!.asText(), '{"contratos":[]}');

    assert.equal(await r.toca(), true, 'nunca se ha respaldado');
    ahora = Date.now() + 1000; // el respaldo se envía después de la última escritura del catálogo
    await r.marcar();
    assert.equal(await r.toca(), false);
    ahora += 25 * 60 * 60 * 1000;
    assert.equal(await r.toca(), false, 'pasó un día pero el catálogo no cambió');
    await writeFile(catalogo, '{"contratos":[1]}');
    await utimes(catalogo, new Date(ahora), new Date(ahora));
    assert.equal(await r.toca(), true, 'pasó un día y hubo cambios');
    await r.marcar();
    ahora += 60 * 60 * 1000;
    await utimes(catalogo, new Date(ahora), new Date(ahora));
    assert.equal(await r.toca(), false, 'con cambios, pero no ha pasado un día');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
