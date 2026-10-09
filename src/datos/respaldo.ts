import { readFile, writeFile } from 'node:fs/promises';

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Respaldo del catálogo por Telegram: el archivo se envía a los usuarios autorizados cada `cadaDias` (y con
 * /respaldo). Con ese archivo se recupera todo: edificios, apartamentos, historial de contratos y arrendatarios.
 * La fecha del último respaldo se guarda en `marca` para no repetirlo en cada reinicio.
 */
export class Respaldo {
  constructor(
    private readonly catalogo: string,
    private readonly marca: string,
    private readonly cadaDias = 7,
    private readonly reloj = Date.now,
  ) {}

  /** Contenido del catálogo y nombre con la fecha, o null si todavía no existe. */
  async archivo(hoy: string): Promise<{ datos: Buffer; nombre: string } | null> {
    try {
      return { datos: await readFile(this.catalogo), nombre: `respaldo-contratos-${hoy}.json` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** true si nunca se ha respaldado o pasaron `cadaDias` desde el último respaldo. */
  async toca(): Promise<boolean> {
    try {
      const ultimo = Number((await readFile(this.marca, 'utf8')).trim());
      return !Number.isFinite(ultimo) || this.reloj() - ultimo >= this.cadaDias * DIA_MS;
    } catch {
      return true;
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
