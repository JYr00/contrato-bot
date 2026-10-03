import { validarParcial } from '../contract/schema.js';
import type { Catalogo } from '../datos/catalogo.js';
import type { Mensaje } from './asistente.js';
import { separarUnidad } from './interpretar.js';

/**
 * Administración de los edificios guardados (/direcciones), aparte del contrato en curso.
 * Botones: "dir:del:<i>" pide confirmación, "dir:ok:<i>" borra, "dir:lista" vuelve a la lista.
 */

const MAX = 30;
const EJEMPLO = '/direcciones Carrera 105 i 67 d 31, Bogotá';

export function listaDirecciones(catalogo: Catalogo, aviso?: string): Mensaje {
  const edificios = catalogo.edificios(MAX);
  const texto = [
    aviso,
    '🏢 Edificios guardados',
    edificios.length ? 'Toca uno para borrarlo de las sugerencias.' : 'Todavía no hay edificios guardados.',
    `➕ Para agregar uno, escríbelo después del comando. Ej.:\n${EJEMPLO}`,
  ];
  return {
    texto: texto.filter(Boolean).join('\n\n'),
    botones: edificios.length ? edificios.map((d, i) => [{ texto: `🗑 ${d}`, data: `dir:del:${i}` }]) : undefined,
  };
}

/** Guarda un edificio escrito a mano; si trae apartamento, se guarda solo el edificio. */
export async function agregarDireccion(catalogo: Catalogo, texto: string): Promise<Mensaje> {
  const { guardados, errores } = validarParcial({ inmueble_direccion: texto });
  if (errores.inmueble_direccion) return listaDirecciones(catalogo, `⚠️ ${errores.inmueble_direccion}`);
  const { base } = separarUnidad(guardados.inmueble_direccion!);
  const nuevo = await catalogo.agregarEdificio(base);
  return listaDirecciones(catalogo, nuevo ? `💾 Guardé: ${base}` : `Ya estaba guardado: ${base}`);
}

/**
 * Respuesta a un botón "dir:…". `textoMensaje` es el mensaje donde se tocó: para borrar se exige que
 * nombre al mismo edificio, por si la lista cambió entre mostrarla y tocar.
 */
export async function botonDirecciones(catalogo: Catalogo, data: string, textoMensaje = ''): Promise<Mensaje> {
  const [, accion, indice] = data.split(':');
  const edificio = catalogo.edificios(MAX)[Number(indice)];

  if (accion === 'del' && edificio) {
    return {
      texto: `🗑 ¿Borrar "${edificio}" de las sugerencias?\n\nTambién se olvidan sus apartamentos y precios guardados. Los contratos ya generados no se tocan.`,
      botones: [
        [
          { texto: '🗑 Sí, borrar', data: `dir:ok:${indice}` },
          { texto: '↩️ No', data: 'dir:lista' },
        ],
      ],
    };
  }
  if (accion === 'ok' && edificio && textoMensaje.includes(edificio)) {
    await catalogo.quitarEdificio(edificio);
    return listaDirecciones(catalogo, `🗑 Borré: ${edificio}`);
  }
  if (accion === 'ok') return listaDirecciones(catalogo, 'La lista cambió; no borré nada. Inténtalo de nuevo.');
  return listaDirecciones(catalogo);
}
