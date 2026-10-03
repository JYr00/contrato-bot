import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContratoGenerado } from '../contract/render.js';

/**
 * Copia de los archivos de cada contrato tal como se enviaron (data/contratos/<id>.pdf|.docx), para que
 * "Reenviar" mande exactamente el que se firmó aunque después cambie la plantilla. Son ~60 KB por contrato.
 */
export class ArchivosContratos {
  constructor(private readonly carpeta: string) {}

  async guardar(id: string, contrato: ContratoGenerado): Promise<void> {
    await mkdir(this.carpeta, { recursive: true });
    await writeFile(join(this.carpeta, `${id}.docx`), contrato.docx);
    if (contrato.pdf) await writeFile(join(this.carpeta, `${id}.pdf`), contrato.pdf);
  }

  /** Archivos guardados de un contrato, o null si no hay (contratos de antes de guardarlos). */
  async leer(id: string): Promise<{ docx: Buffer; pdf: Buffer | null } | null> {
    try {
      const docx = await readFile(join(this.carpeta, `${id}.docx`));
      const pdf = await readFile(join(this.carpeta, `${id}.pdf`)).catch(() => null);
      return { docx, pdf };
    } catch {
      return null;
    }
  }

  async borrar(id: string): Promise<void> {
    await rm(join(this.carpeta, `${id}.docx`), { force: true });
    await rm(join(this.carpeta, `${id}.pdf`), { force: true });
  }
}
