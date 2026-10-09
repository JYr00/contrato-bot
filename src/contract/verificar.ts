import PizZip from 'pizzip';

import { fechaALetras, formatoMiles } from './numero-a-letras.js';
import { construirContexto, type DatosArrendador } from './render.js';
import {
  CAMPOS,
  ETIQUETAS,
  camposFaltantes,
  errorDocumento,
  validarParcial,
  type CampoContrato,
  type DatosContrato,
} from './schema.js';

/**
 * Última barrera antes de enviar un contrato: comprueba con código (sin IA) que el Word generado tenga
 * exactamente los datos confirmados, cada uno en su lugar, y el texto fijo de la plantilla intacto.
 *
 * El texto esperado se arma con un intérprete propio de la plantilla, independiente de docxtemplater: así se
 * notan también los errores que docxtemplater tapa en silencio (un tag mal escrito se llena con "____").
 */

export type TipoProblema =
  | 'dato_faltante'
  | 'dato_invalido'
  | 'dato_distinto'
  | 'texto_modificado'
  | 'parrafos_distintos'
  | 'plantilla';

export interface Problema {
  tipo: TipoProblema;
  /** Dato del contrato al que se refiere, si se sabe. */
  campo?: CampoContrato;
  detalle: string;
}

export interface Verificacion {
  ok: boolean;
  problemas: Problema[];
}

export interface Cambio {
  campo: CampoContrato;
  etiqueta: string;
  antes: string;
  despues: string;
}

type Contexto = Record<string, unknown>;

/** Qué dato del contrato llena cada tag de la plantilla (para decir qué quedó mal). */
const CAMPO_DE_TAG: Record<string, CampoContrato> = {
  arrendatario_nombre: 'arrendatario_nombre',
  arrendatario_documento_firma: 'arrendatario_numero_documento',
  arrendatarios_texto: 'arrendatario_nombre',
  coarrendatarios: 'coarrendatarios',
  nombre: 'coarrendatarios',
  documento_firma: 'coarrendatarios',
  inmueble_direccion: 'inmueble_direccion',
  ocupantes_texto: 'numero_ocupantes',
  precio_texto: 'precio_mensual',
  hay_deposito: 'deposito',
  deposito_texto: 'deposito',
  duracion_texto: 'duracion_meses',
  fecha_inicio_texto: 'fecha_inicio',
  arrendatario_direccion: 'arrendatario_direccion',
  arrendatario_correo: 'arrendatario_correo',
  arrendatario_celular: 'arrendatario_celular',
  ejemplares_texto: 'numero_ejemplares',
};

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodificar = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTIDADES[e]!);
const normalizarEspacios = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Texto de cada párrafo con contenido de word/document.xml, en orden. */
export function parrafos(docx: Buffer): string[] {
  const xml = new PizZip(docx).file('word/document.xml')?.asText();
  if (!xml) throw new Error('El documento no tiene word/document.xml.');
  return xml
    .split('</w:p>')
    .map((p) =>
      normalizarEspacios(
        decodificar(
          [...p.replace(/<w:(tab|br)\b[^>]*\/>/g, '<w:t> </w:t>').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
            .map((m) => m[1])
            .join(''),
        ),
      ),
    )
    .filter(Boolean);
}

/**
 * Párrafos que debería tener el contrato: los de la plantilla con cada {tag} reemplazado. Las secciones
 * ({#x} … {/x}) van en párrafos propios: con un booleano se incluyen u omiten; con una lista, se repiten.
 * `sinDato` recibe los tags que la plantilla pide y el contexto no tiene.
 */
export function parrafosEsperados(plantilla: string[], contexto: Contexto, sinDato: Set<string> = new Set()): string[] {
  const salida: string[] = [];
  for (let i = 0; i < plantilla.length; i++) {
    const p = plantilla[i]!;
    const abre = p.match(/^\{#(\w+)\}$/);
    if (abre) {
      const nombre = abre[1]!;
      const cierre = plantilla.indexOf(`{/${nombre}}`, i + 1);
      if (cierre < 0) throw new Error(`Plantilla no soportada: {#${nombre}} sin cierre.`);
      const cuerpo = plantilla.slice(i + 1, cierre);
      const valor = contexto[nombre];
      if (!(nombre in contexto)) sinDato.add(nombre);
      if (Array.isArray(valor)) {
        for (const item of valor) salida.push(...parrafosEsperados(cuerpo, { ...contexto, ...item }, sinDato));
      } else if (valor) {
        salida.push(...parrafosEsperados(cuerpo, contexto, sinDato));
      }
      i = cierre;
      continue;
    }
    if (/\{[#/^]/.test(p)) throw new Error(`Plantilla no soportada: sección dentro del párrafo "${p.slice(0, 60)}".`);
    const texto = p.replace(/\{(\w+)\}/g, (_, tag: string) => {
      if (!(tag in contexto) || contexto[tag] === undefined || contexto[tag] === null) {
        sinDato.add(tag);
        return '________________'; // lo mismo que pone el renderer: así el problema se reporta una sola vez
      }
      return String(contexto[tag]);
    });
    salida.push(normalizarEspacios(texto));
  }
  return salida;
}

/** Datos completos y válidos, con las mismas reglas que al escribirlos. */
export function verificarDatos(datos: Partial<DatosContrato>): Problema[] {
  const problemas: Problema[] = camposFaltantes(datos).map((campo) => ({
    tipo: 'dato_faltante' as const,
    campo,
    detalle: `Falta ${ETIQUETAS[campo].toLowerCase()}.`,
  }));
  const { errores } = validarParcial(datos as Record<string, unknown>);
  for (const [campo, error] of Object.entries(errores)) {
    problemas.push({ tipo: 'dato_invalido', campo: campo as CampoContrato, detalle: error });
  }
  const personas = [
    { tipo: datos.arrendatario_tipo_documento, numero: datos.arrendatario_numero_documento, campo: 'arrendatario_numero_documento' as const },
    ...(datos.coarrendatarios ?? []).map((p) => ({ ...p, campo: 'coarrendatarios' as const })),
  ];
  for (const p of personas) {
    const error = p.tipo && p.numero ? errorDocumento(p.tipo, p.numero) : null;
    if (error) problemas.push({ tipo: 'dato_invalido', campo: p.campo, detalle: error });
  }
  return problemas;
}

const recorte = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

/** Primer tramo distinto entre dos textos, con algo de contexto, para la bitácora. */
function diferencia(esperado: string, obtenido: string): string {
  let i = 0;
  while (i < esperado.length && esperado[i] === obtenido[i]) i++;
  const desde = Math.max(0, i - 30);
  return `esperado "…${recorte(esperado.slice(desde))}" · obtenido "…${recorte(obtenido.slice(desde))}"`;
}

/** Compara el Word generado con lo que debería decir según la plantilla y los datos. */
export function verificarContrato(args: {
  plantilla: Buffer;
  docx: Buffer;
  datos: DatosContrato;
  arrendador: DatosArrendador;
}): Verificacion {
  const problemas = verificarDatos(args.datos);
  if (problemas.length) return { ok: false, problemas };

  const contexto = construirContexto(args.datos, args.arrendador) as Contexto;
  const sinDato = new Set<string>();
  let esperados: string[];
  try {
    esperados = parrafosEsperados(parrafos(args.plantilla), contexto, sinDato);
  } catch (err) {
    return { ok: false, problemas: [{ tipo: 'plantilla', detalle: (err as Error).message }] };
  }
  for (const tag of sinDato) {
    problemas.push({ tipo: 'plantilla', campo: CAMPO_DE_TAG[tag], detalle: `La plantilla pide {${tag}} y el bot no tiene ese dato.` });
  }

  const obtenidos = parrafos(args.docx);
  if (obtenidos.length !== esperados.length) {
    const i = esperados.findIndex((p, j) => p !== obtenidos[j]);
    problemas.push({
      tipo: 'parrafos_distintos',
      detalle:
        `El documento tiene ${obtenidos.length} párrafos y debería tener ${esperados.length}. ` +
        `Primera diferencia en el párrafo ${i + 1}: ${diferencia(esperados[i] ?? '', obtenidos[i] ?? '')}`,
    });
  } else {
    esperados.forEach((esperado, i) => {
      const obtenido = obtenidos[i]!;
      if (esperado === obtenido) return;
      // Si falta el valor de algún dato, se dice cuál; si no, cambió el texto fijo.
      const tag = Object.keys(CAMPO_DE_TAG).find((t) => {
        const v = contexto[t];
        return typeof v === 'string' && v.length > 2 && esperado.includes(v) && !obtenido.includes(v);
      });
      problemas.push(
        tag
          ? { tipo: 'dato_distinto', campo: CAMPO_DE_TAG[tag], detalle: `Párrafo ${i + 1}: ${diferencia(esperado, obtenido)}` }
          : { tipo: 'texto_modificado', detalle: `Párrafo ${i + 1}: ${diferencia(esperado, obtenido)}` },
      );
    });
  }

  const todo = obtenidos.join('\n');
  if (/[{}]/.test(todo)) problemas.push({ tipo: 'plantilla', detalle: 'Quedaron marcas {…} de la plantilla en el documento.' });
  const montos: [CampoContrato, number][] = [['precio_mensual', args.datos.precio_mensual]];
  if (args.datos.deposito > 0) montos.push(['deposito', args.datos.deposito]);
  for (const [campo, valor] of montos) {
    if (!todo.includes(`($${formatoMiles(valor)})`)) {
      problemas.push({ tipo: 'dato_distinto', campo, detalle: `No aparece ${ETIQUETAS[campo].toLowerCase()} ($${formatoMiles(valor)}) en el documento.` });
    }
  }
  return { ok: problemas.length === 0, problemas };
}

/** Texto legible de un dato para mostrar cambios ("$600.000", "3 meses", "10 de octubre de 2026"). */
function mostrar(campo: CampoContrato, d: DatosContrato): string {
  const v = d[campo];
  switch (campo) {
    case 'precio_mensual':
    case 'deposito':
      return `$${formatoMiles(v as number)}`;
    case 'duracion_meses':
      return v === 1 ? '1 mes' : `${v} meses`;
    case 'fecha_inicio':
      return fechaALetras(v as string);
    case 'coarrendatarios': {
      const lista = (v as DatosContrato['coarrendatarios'] | undefined) ?? [];
      return lista.length ? lista.map((p) => p.nombre).join(', ') : '(ninguno)';
    }
    default:
      return v === '' || v === undefined ? '(en blanco)' : String(v);
  }
}

/** Datos que cambian respecto al contrato anterior (renovación). Todo lo demás queda igual. */
export function compararConAnterior(anterior: DatosContrato, nuevo: DatosContrato): Cambio[] {
  return CAMPOS.filter((c) => c !== 'numero_ejemplares')
    .map((campo) => ({ campo, etiqueta: ETIQUETAS[campo], antes: mostrar(campo, anterior), despues: mostrar(campo, nuevo) }))
    .filter((c) => c.antes !== c.despues);
}

/**
 * Párrafos del contrato anterior (tal como se envió) que no coinciden con lo que la plantilla de hoy daría con
 * sus mismos datos. Si hay, el texto fijo cambió desde entonces (plantilla o datos del arrendador): no es un
 * error del contrato nuevo, que ya se comparó con la plantilla vigente, pero conviene saberlo.
 */
export function textoFijoCambiado(args: {
  plantilla: Buffer;
  docxAnterior: Buffer;
  anterior: DatosContrato;
  arrendador: DatosArrendador;
}): string[] {
  const esperados = parrafosEsperados(parrafos(args.plantilla), construirContexto(args.anterior, args.arrendador) as Contexto);
  const obtenidos = parrafos(args.docxAnterior);
  const largo = Math.max(esperados.length, obtenidos.length);
  const distintos: string[] = [];
  for (let i = 0; i < largo; i++) {
    if (esperados[i] !== obtenidos[i]) distintos.push(`Párrafo ${i + 1}: ${diferencia(esperados[i] ?? '', obtenidos[i] ?? '')}`);
  }
  return distintos;
}
