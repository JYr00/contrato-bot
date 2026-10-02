import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

import { cantidad, fechaALetras, formatoMiles, pesosALetras } from './numero-a-letras.js';
import { ABREVIATURA_DOCUMENTO, TIPOS_DOCUMENTO, type DatosContrato } from './schema.js';

const execFileAsync = promisify(execFile);

export interface DatosArrendador {
  correo: string;
  celular: string;
}

export interface ContratoGenerado {
  nombreBase: string;
  docx: Buffer;
  pdf: Buffer | null;
}

/** Traduce los datos validados a los textos exactos que van en la plantilla. Función pura. */
export function construirContexto(d: DatosContrato, arrendador: DatosArrendador) {
  const numeroDoc = /^\d+$/.test(d.arrendatario_numero_documento)
    ? formatoMiles(Number(d.arrendatario_numero_documento))
    : d.arrendatario_numero_documento;

  return {
    arrendatario_nombre: d.arrendatario_nombre,
    arrendatario_identificacion: `${TIPOS_DOCUMENTO[d.arrendatario_tipo_documento]} No. ${numeroDoc}`,
    arrendatario_documento_firma: `${ABREVIATURA_DOCUMENTO[d.arrendatario_tipo_documento]} ${numeroDoc}`,
    apartamento: d.apartamento,
    ocupantes_texto: cantidad(d.numero_ocupantes, 'persona', 'personas', true),
    canon_texto: pesosALetras(d.canon_mensual),
    duracion_texto: cantidad(d.duracion_meses, 'mes', 'meses'),
    fecha_inicio_texto: fechaALetras(d.fecha_inicio),
    arrendatario_direccion: d.arrendatario_direccion,
    arrendatario_correo: d.arrendatario_correo,
    arrendatario_celular: d.arrendatario_celular,
    arrendador_correo: arrendador.correo || '________________',
    arrendador_celular: arrendador.celular || '________________',
    ejemplares_texto: cantidad(d.numero_ejemplares, 'ejemplar', 'ejemplares').replace(/ ejemplar(es)?$/, ''),
  };
}

export class ContractRenderer {
  constructor(
    private readonly plantilla: Buffer,
    private readonly arrendador: DatosArrendador,
    private readonly sofficePath = 'soffice',
  ) {}

  static async desdeArchivo(ruta: string, arrendador: DatosArrendador, sofficePath?: string) {
    return new ContractRenderer(await readFile(ruta), arrendador, sofficePath);
  }

  renderDocx(datos: DatosContrato): Buffer {
    const doc = new Docxtemplater(new PizZip(this.plantilla), {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '________________',
    });
    doc.render(construirContexto(datos, this.arrendador));
    return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  }

  /** Convierte a PDF con LibreOffice headless. Devuelve null si LibreOffice no está disponible. */
  async docxAPdf(docx: Buffer): Promise<Buffer | null> {
    const dir = await mkdtemp(join(tmpdir(), 'contrato-'));
    try {
      const entrada = join(dir, 'contrato.docx');
      await writeFile(entrada, docx);
      // Perfil propio por conversión: evita bloqueos cuando hay varias conversiones en paralelo.
      const perfil = pathToFileURL(join(dir, 'lo-profile')).href;
      await execFileAsync(
        this.sofficePath,
        [`-env:UserInstallation=${perfil}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, entrada],
        { timeout: 60_000 },
      );
      return await readFile(join(dir, 'contrato.pdf'));
    } catch (err) {
      console.error('[render] No se pudo generar el PDF:', (err as Error).message);
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async generar(datos: DatosContrato): Promise<ContratoGenerado> {
    const docx = this.renderDocx(datos);
    const pdf = await this.docxAPdf(docx);
    const apellido = datos.arrendatario_nombre.split(' ').slice(-2).join('_');
    const nombreBase = `Contrato_Arrendamiento_Apto${datos.apartamento}_${apellido}`.replace(/[^\wÁÉÍÓÚÑáéíóúñ-]/g, '_');
    return { nombreBase, docx, pdf };
  }
}
