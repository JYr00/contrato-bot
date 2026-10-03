import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Catalogo } from '../datos/catalogo.js';
import { agregarDireccion, botonDirecciones, listaDirecciones } from './direcciones.js';

test('/direcciones: agregar, listar y borrar con confirmación', async () => {
  const catalogo = Catalogo.enMemoria({
    inmuebles: [
      { direccion: 'Calle 1 # 2-3 apto 101', usos: 1, ultimoUso: 1, ultimoPrecio: 900_000 },
      { direccion: 'Calle 1 # 2-3 apto 102', usos: 1, ultimoUso: 2 },
    ],
  });

  assert.match(listaDirecciones(Catalogo.enMemoria()).texto, /Todavía no hay edificios/);

  let m = await agregarDireccion(catalogo, 'Carrera 105 i 67 d 31 apto 501, Bogotá');
  assert.match(m.texto, /💾 Guardé: Carrera 105 i 67 d 31, Bogotá/, 'guarda solo el edificio');
  assert.deepEqual(
    m.botones!.map((f) => f[0]!.texto),
    ['🗑 Carrera 105 i 67 d 31, Bogotá', '🗑 Calle 1 # 2-3'],
  );
  assert.match((await agregarDireccion(catalogo, 'Carrera 105 i 67 d 31, Bogotá')).texto, /Ya estaba guardado/);
  assert.match((await agregarDireccion(catalogo, 'x')).texto, /⚠️ Dirección incompleta/);

  // Borrar pide confirmación y se lleva los apartamentos de ese edificio.
  m = await botonDirecciones(catalogo, 'dir:del:1');
  assert.match(m.texto, /¿Borrar "Calle 1 # 2-3"/);
  m = await botonDirecciones(catalogo, m.botones![0]![0]!.data, m.texto);
  assert.match(m.texto, /🗑 Borré: Calle 1 # 2-3/);
  assert.deepEqual(catalogo.edificios(), ['Carrera 105 i 67 d 31, Bogotá']);
  assert.deepEqual(catalogo.unidades('Calle 1 # 2-3'), []);

  // Si la lista cambió entre mostrar y confirmar, no borra otro edificio por error.
  m = await botonDirecciones(catalogo, 'dir:ok:0', '¿Borrar "Calle 1 # 2-3"?');
  assert.match(m.texto, /La lista cambió/);
  assert.deepEqual(catalogo.edificios(), ['Carrera 105 i 67 d 31, Bogotá']);
});
