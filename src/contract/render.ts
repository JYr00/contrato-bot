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

type Persona = { nombre: string; tipo: DatosContrato['arrendatario_tipo_documento']; numero: string };

const numeroLegible = (n: string) => (/^\d+$/.test(n) ? formatoMiles(Number(n)) : n);
const identificacion = (p: Persona) => `${TIPOS_DOCUMENTO[p.tipo]} No. ${numeroLegible(p.numero)}`;
const documentoFirma = (p: Persona) => `${ABREVIATURA_DOCUMENTO[p.tipo]} ${numeroLegible(p.numero)}`;

/**
 * Comparecencia de los arrendatarios en el encabezado, hasta "se denominará(n)":
 * "LAURA…, identificado con…, quien para efectos de este contrato obra en nombre propio y se denominará"
 * o, con varios, "LAURA…, identificado con…, y PEDRO…, identificado con…, quienes … se denominarán".
 */
export function arrendatariosTexto(personas: Persona[]): string {
  const partes = personas.map((p) => `${p.nombre}, identificado con ${identificacion(p)}`);
  if (partes.length === 1) {
    return `${partes[0]}, quien para efectos de este contrato obra en nombre propio y se denominará`;
  }
  const lista = `${partes.slice(0, -1).join(', ')}, y ${partes.at(-1)}`;
  return `${lista}, quienes para efectos de este contrato obran en nombre propio, se obligan solidariamente y se denominarán`;
}

/** Traduce los datos validados a los textos exactos que van en la plantilla. Función pura. */
export function construirContexto(d: DatosContrato, arrendador: DatosArrendador) {
  const principal: Persona = {
    nombre: d.arrendatario_nombre,
    tipo: d.arrendatario_tipo_documento,
    numero: d.arrendatario_numero_documento,
  };

  const blanco = (v: string) => v || '________________';

  return {
    arrendatario_nombre: d.arrendatario_nombre,
    arrendatario_documento_firma: documentoFirma(principal),
    arrendatarios_texto: arrendatariosTexto([principal, ...d.coarrendatarios]),
    coarrendatarios: d.coarrendatarios.map((p) => ({ nombre: p.nombre, documento_firma: documentoFirma(p) })),
    inmueble_direccion: d.inmueble_direccion,
    ocupantes_texto: cantidad(d.numero_ocupantes, 'persona', 'personas', true),
    precio_texto: pesosALetras(d.precio_mensual),
    hay_deposito: d.deposito > 0,
    deposito_texto: d.deposito > 0 ? pesosALetras(d.deposito) : '',
    duracion_texto: cantidad(d.duracion_meses, 'mes', 'meses'),
    fecha_inicio_texto: fechaALetras(d.fecha_inicio),
    arrendatario_direccion: d.arrendatario_direccion,
    arrendatario_correo: blanco(d.arrendatario_correo),
    arrendatario_celular: blanco(d.arrendatario_celular),
    arrendador_correo: blanco(arrendador.correo),
    arrendador_celular: blanco(arrendador.celular),
    ejemplares_texto: cantidad(d.numero_ejemplares, 'ejemplar', 'ejemplares').replace(/ ejemplar(es)?$/, ''),
  };
}

/** Nombre de los archivos del contrato: "Contrato_Arrendamiento_GÓMEZ_PÉREZ_2026-11-01". */
export function nombreArchivo(datos: DatosContrato): string {
  const apellido = datos.arrendatario_nombre.split(' ').slice(-2).join('_');
  return `Contrato_Arrendamiento_${apellido}_${datos.fecha_inicio}`.replace(/[^\wÁÉÍÓÚÑáéíóúñ-]/g, '_');
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
    return { nombreBase: nombreArchivo(datos), docx, pdf };
  }
}
