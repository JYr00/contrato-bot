import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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

test('respaldo: archivo con fecha y cada 7 días', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'respaldo-'));
  try {
    let ahora = Date.UTC(2026, 9, 3);
    const catalogo = join(dir, 'catalogo.json');
    const r = new Respaldo(catalogo, join(dir, 'ultimo-respaldo.txt'), 7, () => ahora);

    assert.equal(await r.archivo('2026-10-03'), null, 'sin catálogo no hay nada que respaldar');
    await writeFile(catalogo, '{"contratos":[]}');
    const archivo = await r.archivo('2026-10-03');
    assert.equal(archivo?.nombre, 'respaldo-contratos-2026-10-03.json');
    assert.equal(archivo?.datos.toString(), '{"contratos":[]}');

    assert.equal(await r.toca(), true, 'nunca se ha respaldado');
    await r.marcar();
    assert.equal(await r.toca(), false);
    ahora += 6 * 24 * 60 * 60 * 1000;
    assert.equal(await r.toca(), false, 'a los 6 días todavía no');
    ahora += 24 * 60 * 60 * 1000;
    assert.equal(await r.toca(), true, 'a los 7 días sí');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
