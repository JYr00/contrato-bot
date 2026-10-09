import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PorVencer } from '../flujo/inventario.js';

/** Se avisa cuando faltan 30 días y otra vez cuando faltan 7. */
export const UMBRALES_DIAS = [30, 7] as const;

/** Identifica un contrato aunque no tenga id guardado: arrendatario, inmueble y fecha de inicio. */
const claveContrato = (v: PorVencer) =>
  `${v.contrato.arrendatario_numero_documento}|${v.contrato.inmueble_direccion}|${v.contrato.fecha_inicio}`;

/**
 * Avisos de vencimiento ya enviados (data/avisos-vencimiento.json), para no repetirlos en cada revisión ni
 * después de un reinicio. Cada contrato se avisa una vez por umbral.
 */
export class AvisosVencimiento {
  private escritura: Promise<void> = Promise.resolve();

  private constructor(
    private readonly ruta: string,
    private readonly enviados: Set<string>,
  ) {}

  static async abrir(ruta: string): Promise<AvisosVencimiento> {
    try {
      return new AvisosVencimiento(ruta, new Set(JSON.parse(await readFile(ruta, 'utf8')) as string[]));
    } catch {
      return new AvisosVencimiento(ruta, new Set());
    }
  }

  static enMemoria(): AvisosVencimiento {
    return new AvisosVencimiento('', new Set());
  }

  /**
   * De los contratos por vencer, los que llegaron a un umbral sin aviso todavía. Si el bot estuvo apagado y un
   * contrato ya pasó varios umbrales, se avisa una sola vez (el más urgente) y se dan todos por avisados.
   */
  pendientes(lista: PorVencer[]): { aviso: PorVencer; claves: string[] }[] {
    const salida: { aviso: PorVencer; claves: string[] }[] = [];
    for (const v of lista) {
      const alcanzados = UMBRALES_DIAS.filter((u) => v.dias <= u);
      if (!alcanzados.length) continue;
      const claves = alcanzados.map((u) => `${claveContrato(v)}|${u}`);
      const masUrgente = claves.at(-1)!;
      if (!this.enviados.has(masUrgente)) salida.push({ aviso: v, claves });
    }
    return salida;
  }

  async marcar(claves: string[]): Promise<void> {
    for (const c of claves) this.enviados.add(c);
    if (!this.ruta) return;
    const contenido = JSON.stringify([...this.enviados], null, 1);
    this.escritura = this.escritura.then(async () => {
      await mkdir(dirname(this.ruta), { recursive: true });
      await writeFile(`${this.ruta}.tmp`, contenido);
      await rename(`${this.ruta}.tmp`, this.ruta);
    });
    await this.escritura;
  }
}
