import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import PizZip from 'pizzip';

const DIA_MS = 24 * 60 * 60 * 1000;
/** Telegram no deja enviar documentos de más de 50 MB; se deja margen. */
const MAX_BYTES = 45 * 1024 * 1024;

/**
 * Respaldo completo por Telegram: un ZIP con todo lo que hace falta para recuperar el bot en otro PC.
 *
 * - `catalogo.json`: edificios, apartamentos, historial de contratos y arrendatarios.
 * - `contratos/`: el Word y el PDF de cada contrato tal como se enviaron.
 * - `logs/interacciones/`: la bitácora (si el ZIP pasa de 45 MB, se deja por fuera).
 *
 * Se envía cada `cadaDias` si hubo cambios desde el último (y con /respaldo cuando se pida). La fecha del último
 * respaldo se guarda en `marca` para no repetirlo en cada reinicio.
 */
export class Respaldo {
  private readonly carpeta: string;

  constructor(
    private readonly catalogo: string,
    private readonly marca: string,
    private readonly cadaDias = 1,
    private readonly reloj = Date.now,
  ) {
    this.carpeta = dirname(catalogo);
  }

  /** ZIP con el catálogo, los contratos y la bitácora, o null si todavía no hay catálogo. */
  async archivo(hoy: string): Promise<{ datos: Buffer; nombre: string; sinBitacora: boolean } | null> {
    let catalogo: Buffer;
    try {
      catalogo = await readFile(this.catalogo);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const nombre = `respaldo-contratos-${hoy}.zip`;
    const conBitacora = await this.zip(catalogo, ['contratos', join('logs', 'interacciones')]);
    if (conBitacora.length <= MAX_BYTES) return { datos: conBitacora, nombre, sinBitacora: false };
    return { datos: await this.zip(catalogo, ['contratos']), nombre, sinBitacora: true };
  }

  private async zip(catalogo: Buffer, carpetas: string[]): Promise<Buffer> {
    const zip = new PizZip();
    zip.file(basename(this.catalogo), catalogo);
    for (const carpeta of carpetas) {
      for (const ruta of await archivosDe(join(this.carpeta, carpeta))) {
        // Rutas con "/" dentro del ZIP, aunque se genere en Windows.
        zip.file(relative(this.carpeta, ruta).split(sep).join('/'), await readFile(ruta));
      }
    }
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  }

  /**
   * true si nunca se ha respaldado, o si pasaron `cadaDias` desde el último y el catálogo cambió desde entonces
   * (cada contrato, edificio o arrendatario nuevo lo modifica): sin cambios no se manda el mismo archivo.
   */
  async toca(): Promise<boolean> {
    const ultimo = await this.ultimo();
    if (ultimo === null) return true;
    if (this.reloj() - ultimo < this.cadaDias * DIA_MS) return false;
    try {
      return (await stat(this.catalogo)).mtimeMs > ultimo;
    } catch {
      return false;
    }
  }

  /** Cuándo se envió el último respaldo (ms), o null si nunca. */
  async ultimo(): Promise<number | null> {
    try {
      const ultimo = Number((await readFile(this.marca, 'utf8')).trim());
      return Number.isFinite(ultimo) ? ultimo : null;
    } catch {
      return null;
    }
  }

  async marcar(): Promise<void> {
    await writeFile(this.marca, String(this.reloj()));
  }
}

/** Archivos de una carpeta y sus subcarpetas (vacío si no existe). */
async function archivosDe(carpeta: string): Promise<string[]> {
  try {
    const entradas = await readdir(carpeta, { recursive: true, withFileTypes: true });
    return entradas
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
