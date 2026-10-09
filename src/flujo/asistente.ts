import { fechaALetras, formatoMiles } from '../contract/numero-a-letras.js';
import {
  ABREVIATURA_DOCUMENTO,
  CAMPOS,
  ETIQUETAS,
  MAX_COARRENDATARIOS,
  TIPOS_DOCUMENTO,
  VALORES_POR_DEFECTO,
  errorDocumento,
  estaCompleto,
  validarParcial,
  type CampoContrato,
  type DatosContrato,
} from '../contract/schema.js';
import { compararConAnterior, type Problema } from '../contract/verificar.js';
import type { Catalogo } from '../datos/catalogo.js';
import {
  componerDireccion,
  fechaFin,
  interpretarContacto,
  interpretarDocumentoEscrito,
  interpretarEntero,
  interpretarFecha,
  interpretarMeses,
  interpretarPesos,
  interpretarUnidad,
  primeroDelMesSiguiente,
  senalesDeDatos,
  separarUnidad,
  sumarDias,
} from './interpretar.js';

/** Preguntas que se hacen una por una, en este orden, después del documento. */
export const ORDEN = ['inmueble', 'unidad', 'precio', 'deposito', 'duracion', 'fecha', 'ocupantes', 'contacto', 'notificacion'] as const;
export type PasoDato = (typeof ORDEN)[number];

/** Campos del contrato que llena cada pregunta. */
const CAMPOS_DE: Record<PasoDato, CampoContrato[]> = {
  inmueble: ['inmueble_direccion'],
  unidad: ['inmueble_direccion'],
  precio: ['precio_mensual'],
  deposito: ['deposito'],
  duracion: ['duracion_meses'],
  fecha: ['fecha_inicio'],
  ocupantes: ['numero_ocupantes'],
  contacto: ['arrendatario_celular', 'arrendatario_correo'],
  notificacion: ['arrendatario_direccion'],
};

export type Paso =
  | 'inicio'
  | 'renovar'
  | 'documento'
  | 'confirmar_documento'
  | 'propuesta'
  | PasoDato
  | 'resumen'
  | 'corregir'
  | 'coarrendatarios'
  | 'listo';

type TipoDocumento = DatosContrato['arrendatario_tipo_documento'];
type Datos = Partial<DatosContrato>;

export interface DocumentoDetectado {
  nombre?: string;
  tipo?: TipoDocumento;
  numero?: string;
  /** Por qué no se pudo leer bien (foto borrosa, no es un documento…). */
  observacion?: string;
}

export interface EstadoAsistente {
  paso: Paso;
  datos: Datos;
  /** Valores detrás de los botones del paso actual: el botón "v2" es ofertas[2]. */
  ofertas: Datos[];
  documento?: DocumentoDetectado;
  /** Contrato que se está renovando: el resumen muestra qué cambia respecto a él. */
  base?: { datos: DatosContrato; id?: string };
  /** Nombre o número escrito sin el otro: se espera el dato que falta en el siguiente mensaje. */
  documentoParcial?: DocumentoDetectado;
  propuesta?: Datos;
  /** Edificio elegido (dirección sin apartamento), mientras se pregunta el apartamento. */
  edificio?: string;
  /** Se pidió corregir al arrendatario principal: la próxima cédula lo reemplaza. */
  reemplazarPrincipal?: boolean;
  /** true cuando se está corrigiendo un dato desde el resumen. */
  volverAResumen: boolean;
}

export interface Boton {
  texto: string;
  data: string;
}

export interface Mensaje {
  texto: string;
  botones?: Boton[][];
}

/**
 * Cada respuesta es la tarjeta del contrato en curso: lo ya respondido arriba y la pregunta actual abajo.
 * El adaptador la edita en el mismo mensaje para que el chat no se llene.
 */
export interface Salida {
  tarjeta: Mensaje;
  /** Empieza un contrato nuevo: la tarjeta anterior se conserva y esta va en un mensaje aparte. */
  nueva?: boolean;
  /** Datos completos y confirmados: el adaptador debe generar y enviar el contrato. */
  generar?: DatosContrato;
  /** El botón pertenece a un paso anterior y se ignoró. */
  obsoleto?: boolean;
}

/** Datos que un mensaje libre puede traer; `apartamento` va solo cuando no se dijo el edificio. */
export type DatosExtraidos = Partial<Record<CampoContrato, unknown>> & { apartamento?: string };

export interface ContextoExtraccion {
  hoy: string;
  /** Edificios guardados, para reconocerlos aunque se escriban incompletos. */
  edificios: string[];
  /** Pregunta en pantalla cuando llegó el mensaje. */
  pregunta?: string;
}

/** Interpreta un mensaje libre con varios datos (lo implementa Claude en src/ia/extractor-datos.ts). */
export interface Extractor {
  extraer(texto: string, contexto: ContextoExtraccion): Promise<DatosExtraidos>;
}

export function estadoInicial(): EstadoAsistente {
  // Las claves opcionales van explícitas para que Object.assign(e, estadoInicial()) también las limpie.
  return {
    paso: 'inicio',
    datos: { ...VALORES_POR_DEFECTO },
    ofertas: [],
    documento: undefined,
    documentoParcial: undefined,
    base: undefined,
    propuesta: undefined,
    edificio: undefined,
    reemplazarPrincipal: undefined,
    volverAResumen: false,
  };
}

// --- Formato -------------------------------------------------------------------------------------

const pesos = (n: number) => `$${formatoMiles(n)}`;
const meses = (n: number) =>
  n === 1 ? '1 mes' : n % 12 === 0 ? `${n} meses (${n / 12} ${n === 12 ? 'año' : 'años'})` : `${n} meses`;
const personasTexto = (n: number) => (n === 1 ? '1 persona' : `${n} personas`);
/** Arrendatarios del contrato: el principal y los co-arrendatarios. */
const personas = (d: Partial<DatosContrato>) => 1 + (d.coarrendatarios?.length ?? 0);
const documento = (tipo: TipoDocumento, numero: string) =>
  `${ABREVIATURA_DOCUMENTO[tipo]} ${/^\d+$/.test(numero) ? formatoMiles(Number(numero)) : numero}`;
const contacto = (d: Datos) =>
  [d.arrendatario_celular, d.arrendatario_correo].filter(Boolean).join(' · ') || '(en blanco)';

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** "2027-01-14" → "14 ene 2027" */
/**
 * Fechas de inicio más usadas, sin repetir: hoy, mañana, el próximo 15 y el 1 del mes siguiente.
 * "8 oct" (con el año solo si no es el de hoy).
 */
function fechasProbables(hoy: string): { etiqueta: string; fecha: string }[] {
  const corta = (iso: string) => (iso.slice(0, 4) === hoy.slice(0, 4) ? fechaCorta(iso).slice(0, -5) : fechaCorta(iso));
  const dia = Number(hoy.slice(8));
  const quince = dia < 15 ? `${hoy.slice(0, 8)}15` : `${primeroDelMesSiguiente(hoy).slice(0, 8)}15`;
  const lista = [
    { etiqueta: `Hoy · ${corta(hoy)}`, fecha: hoy },
    { etiqueta: `Mañana · ${corta(sumarDias(hoy, 1))}`, fecha: sumarDias(hoy, 1) },
    { etiqueta: corta(quince), fecha: quince },
    { etiqueta: corta(primeroDelMesSiguiente(hoy)), fecha: primeroDelMesSiguiente(hoy) },
  ];
  return lista.filter((f, i) => lista.findIndex((g) => g.fecha === f.fecha) === i);
}

const fechaCorta = (iso: string) => {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES_CORTOS[m! - 1]} ${a}`;
};

const EJEMPLO_DOCUMENTO = 'Laura Gómez Pérez CC 1020345678';
const AVISO_IA = '⚠️ No pude usar la IA para entender el mensaje. Escribe un dato a la vez o usa los botones.';
/** interpretarLibre no pudo consultar a Claude (sin conexión, llave inválida…). */
const FALLO_IA = 'fallo_ia';
const PEDIR_DOCUMENTO =
  '📷 Envía una foto de la cédula del arrendatario (por el frente, sin reflejos).\n\n' +
  `También puedes escribir el nombre y el número. Ej.: ${EJEMPLO_DOCUMENTO}`;

/** Líneas con los datos ya definidos, en el orden del contrato. */
export function describir(d: Datos): string {
  const periodo =
    d.fecha_inicio && d.duracion_meses
      ? `🗓️ Del ${fechaALetras(d.fecha_inicio)} al ${fechaALetras(fechaFin(d.fecha_inicio, d.duracion_meses))}`
      : d.fecha_inicio && `🗓️ Inicia: ${fechaALetras(d.fecha_inicio)}`;
  const lineas = [
    d.arrendatario_nombre &&
      `👤 ${d.arrendatario_nombre} · ${documento(d.arrendatario_tipo_documento!, d.arrendatario_numero_documento!)}`,
    ...(d.coarrendatarios ?? []).map((p) => `👥 ${p.nombre} · ${documento(p.tipo, p.numero)}`),
    d.inmueble_direccion && `🏠 ${d.inmueble_direccion}`,
    d.precio_mensual && `💰 Canon: ${pesos(d.precio_mensual)} mensuales`,
    d.deposito !== undefined && `🔐 Depósito: ${d.deposito ? pesos(d.deposito) : 'sin depósito'}`,
    d.precio_mensual &&
      d.deposito &&
      `💵 Al iniciar: ${pesos(d.precio_mensual + d.deposito)} (primer mes + depósito)`,
    d.duracion_meses && `📅 Duración: ${meses(d.duracion_meses)}`,
    periodo,
    d.numero_ocupantes && `👨‍👩‍👧 Ocupantes: ${personasTexto(d.numero_ocupantes)}`,
    (d.arrendatario_celular !== undefined || d.arrendatario_correo !== undefined) && `📱 Contacto: ${contacto(d)}`,
    d.arrendatario_direccion && `📬 Notificaciones: ${d.arrendatario_direccion}`,
  ];
  return lineas.filter(Boolean).join('\n');
}

// --- Definición de cada pregunta ----------------------------------------------------------------

interface Opcion {
  etiqueta: string;
  valor: Datos;
  /** Opción fija (ej. "Sin depósito"), no un valor guardado: si solo hay de estas, se pide escribir. */
  fija?: boolean;
}

interface Contexto {
  datos: Datos;
  catalogo: Catalogo;
  hoy: string;
  /** Edificio del paso de apartamento. */
  edificio: string;
}

interface Pregunta {
  /** Nombre corto para el menú de corrección. */
  titulo: string;
  pregunta: string | ((c: Contexto) => string);
  /** Qué escribir cuando el usuario elige "otro" o no hay opciones guardadas. */
  ayuda: string;
  otro: string;
  porFila: number;
  opciones(c: Contexto): Opcion[];
  interpretar(texto: string, c: Contexto): Datos | null;
}

const previo = (c: Contexto) =>
  c.datos.arrendatario_numero_documento ? c.catalogo.arrendatario(c.datos.arrendatario_numero_documento) : undefined;

const unicos = <T>(valores: (T | undefined | null | '')[]) => [...new Set(valores.filter((v): v is T => !!v || v === 0))];

/** Envuelve un intérprete de un solo valor para que devuelva { campo: valor }. */
const a = <K extends CampoContrato>(campo: K, f: (t: string, hoy: string) => unknown) => (t: string, c: Contexto) => {
  const v = f(t, c.hoy);
  return v === null || v === undefined || v === '' ? null : ({ [campo]: v } as Datos);
};

const PREGUNTAS: Record<PasoDato, Pregunta> = {
  inmueble: {
    titulo: 'Inmueble',
    pregunta: '🏠 ¿En qué edificio o casa?',
    ayuda: 'Escribe la dirección, con o sin apartamento. Ej.: Carrera 105 i 67 d 31, Bogotá',
    otro: '➕ Otra dirección',
    porFila: 1,
    opciones: (c) => {
      const anterior = previo(c)?.ultimoInmueble;
      return unicos([anterior && separarUnidad(anterior).base, ...c.catalogo.edificios()])
        .slice(0, 4)
        .map((b) => ({ etiqueta: b, valor: { inmueble_direccion: b } }));
    },
    interpretar: a('inmueble_direccion', (t) => t.trim()),
  },
  unidad: {
    titulo: 'Apartamento',
    pregunta: (c) => `🚪 ¿Qué apartamento de ${c.edificio}?`,
    ayuda: 'Escribe el número del apartamento. Ej.: 501',
    otro: '➕ Otro apartamento',
    porFila: 3,
    opciones: (c) => [
      ...c.catalogo
        .unidades(c.edificio)
        .map((u) => ({ etiqueta: u, valor: { inmueble_direccion: componerDireccion(c.edificio, u) } })),
      { etiqueta: '🏠 Sin apartamento (casa completa)', valor: { inmueble_direccion: c.edificio }, fija: true },
    ],
    interpretar: (t, c) => {
      const u = interpretarUnidad(t);
      return u === null ? null : { inmueble_direccion: componerDireccion(c.edificio, u || undefined) };
    },
  },
  precio: {
    titulo: 'Canon',
    pregunta: '💰 ¿Cuál es el canon (arriendo mensual)?',
    ayuda: 'Escribe el canon mensual. Ej.: 1.500.000 o "1,5 millones"',
    otro: '➕ Otro valor',
    porFila: 3,
    opciones: (c) =>
      c.catalogo.precios(c.datos.inmueble_direccion, 3).map((v) => ({ etiqueta: pesos(v), valor: { precio_mensual: v } })),
    interpretar: a('precio_mensual', interpretarPesos),
  },
  deposito: {
    titulo: 'Depósito',
    pregunta: '🔐 ¿Hay depósito? ¿De cuánto?',
    ayuda: 'Escribe el valor del depósito que se paga al inicio. Ej.: 500.000. Si no hay depósito, escribe 0.',
    otro: '➕ Otro valor',
    porFila: 3,
    opciones: (c) => [
      ...c.catalogo.depositos(c.datos.inmueble_direccion, 2).map((v) => ({ etiqueta: pesos(v), valor: { deposito: v } })),
      { etiqueta: 'Sin depósito', valor: { deposito: 0 }, fija: true },
    ],
    interpretar: a('deposito', (t) => (/^\s*(0|no|ninguno|sin( dep[oó]sito)?)\s*$/i.test(t) ? 0 : interpretarPesos(t))),
  },
  duracion: {
    titulo: 'Duración',
    pregunta: '📅 ¿Por cuánto tiempo es el arriendo?',
    ayuda: 'Escribe la duración. Ej.: 9 meses, 1 año',
    otro: '➕ Otro',
    porFila: 2,
    opciones: (c) =>
      unicos([3, 6, ...c.catalogo.duraciones(3)])
        .slice(0, 4)
        .map((n) => ({ etiqueta: meses(n), valor: { duracion_meses: n } })),
    interpretar: a('duracion_meses', interpretarMeses),
  },
  fecha: {
    titulo: 'Fecha de inicio',
    pregunta: '🗓️ ¿Desde qué fecha empieza el contrato?',
    ayuda: 'Escribe la fecha de inicio. Ej.: 15/11/2026 o "15 de noviembre"',
    otro: '📅 Otra fecha',
    porFila: 2,
    opciones: (c) => fechasProbables(c.hoy).map(({ etiqueta, fecha }) => ({ etiqueta, valor: { fecha_inicio: fecha } })),
    interpretar: a('fecha_inicio', interpretarFecha),
  },
  ocupantes: {
    titulo: 'Ocupantes',
    pregunta: '👥 ¿Cuántas personas vivirán en el inmueble?',
    ayuda: 'Escribe el número de personas.',
    otro: '➕ Otro',
    porFila: 4,
    opciones: (c) =>
      unicos([previo(c)?.ocupantes, ...[0, 1, 2, 3].map((i) => personas(c.datos) + i)])
        .filter((n) => n >= personas(c.datos))
        .slice(0, 4)
        .sort((x, y) => x - y)
        .map((n) => ({ etiqueta: String(n), valor: { numero_ocupantes: n } })),
    interpretar: a('numero_ocupantes', interpretarEntero),
  },
  contacto: {
    titulo: 'Celular y correo',
    pregunta: '📱 Celular y correo del arrendatario (para notificaciones):',
    ayuda: 'Escribe el celular y/o el correo en un mismo mensaje. Ej.: 310 555 1234 laura@correo.com',
    otro: '➕ Otros datos',
    porFila: 1,
    opciones: (c) => {
      const p = previo(c);
      const conocido = p && (p.celular || p.correo) ? [p.celular, p.correo].filter(Boolean).join(' · ') : undefined;
      return [
        ...(conocido
          ? [{ etiqueta: conocido, valor: { arrendatario_celular: p!.celular ?? '', arrendatario_correo: p!.correo ?? '' } }]
          : []),
        { etiqueta: 'Dejar en blanco', valor: { arrendatario_celular: '', arrendatario_correo: '' }, fija: true },
      ];
    },
    interpretar: (t) => {
      const r = interpretarContacto(t);
      return r && { arrendatario_celular: r.celular, arrendatario_correo: r.correo };
    },
  },
  notificacion: {
    titulo: 'Notificaciones',
    pregunta:
      '📬 ¿Dónde recibirá notificaciones el arrendatario?\nNormalmente es la dirección del inmueble que va a arrendar.',
    ayuda: 'Escribe la dirección de notificación del arrendatario.',
    otro: '➕ Otra dirección',
    porFila: 1,
    opciones: (c) =>
      unicos([c.datos.inmueble_direccion, previo(c)?.direccion]).map((d) => ({
        etiqueta: d === c.datos.inmueble_direccion ? '📍 La del inmueble arrendado' : d,
        valor: { arrendatario_direccion: d },
      })),
    interpretar: a('arrendatario_direccion', (t) => t.trim()),
  },
};

const esPasoDato = (p: string): p is PasoDato => (ORDEN as readonly string[]).includes(p);
const pendiente = (d: Datos, paso: PasoDato) => CAMPOS_DE[paso].some((c) => d[c] === undefined);

// --- Asistente -----------------------------------------------------------------------------------

/**
 * Asistente guiado con botones para armar un contrato. No sabe nada de Telegram: recibe texto,
 * botones o documentos leídos y devuelve la tarjeta a mostrar. Así se puede probar sin red.
 */
export class Asistente {
  constructor(
    private readonly catalogo: Catalogo,
    private readonly hoy: () => string,
    /** Opcional: sin él, solo se entienden respuestas de un dato a la vez. */
    private readonly extractor?: Extractor,
  ) {}

  iniciar(e: EstadoAsistente): Salida {
    Object.assign(e, estadoInicial(), { paso: 'documento' });
    return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO), nueva: true };
  }

  /** Contrato nuevo con el inmueble ya elegido (desde el informe de inmuebles): solo falta la cédula. */
  nuevoEn(e: EstadoAsistente, direccion: string): Salida {
    Object.assign(e, estadoInicial(), { paso: 'documento' });
    e.datos.inmueble_direccion = direccion;
    e.edificio = separarUnidad(direccion).base;
    return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO), nueva: true };
  }

  /** Renovación de un contrato concreto (desde el informe de inmuebles): va directo al resumen. */
  renovarContrato(e: EstadoAsistente, anterior: DatosContrato): Salida {
    Object.assign(e, estadoInicial());
    const { datos, avisos } = this.renovacion(anterior);
    e.datos = datos;
    e.base = this.base(anterior);
    return { ...this.resumen(e, avisos), nueva: true };
  }

  /** /renovar: lista los últimos contratos para elegir cuál renovar. */
  renovar(e: EstadoAsistente): Salida {
    Object.assign(e, estadoInicial());
    const contratos = this.catalogo.contratosRenovables();
    if (!contratos.length) {
      return {
        tarjeta: {
          texto:
            '🔁 Renovar contrato\n\nTodavía no hay contratos para renovar: se guardan desde el próximo que generes.\n\n' +
            PEDIR_DOCUMENTO,
        },
        nueva: true,
      };
    }
    e.paso = 'renovar';
    e.ofertas = contratos.map((c) => ({ arrendatario_numero_documento: c.arrendatario_numero_documento }));
    const hoy = this.hoy();
    const botones = contratos.map((c, i) => {
      const fin = fechaFin(c.fecha_inicio, c.duracion_meses);
      const unidad = separarUnidad(c.inmueble_direccion).unidad;
      const nombre = c.arrendatario_nombre.split(' ').slice(0, 2).join(' ');
      return [
        {
          texto: `${nombre} · ${unidad ? `apto ${unidad}` : c.inmueble_direccion} · ${fin < hoy ? 'venció' : 'vence'} ${fechaCorta(fin)}`,
          data: `renovar:v${i}`,
        },
      ];
    });
    return { tarjeta: { texto: '🔁 Renovar contrato\n\n¿Cuál contrato quieres renovar?', botones }, nueva: true };
  }

  /** Vuelve a mostrar la tarjeta del paso actual (p. ej. tras un error al generar). */
  actual(e: EstadoAsistente, aviso?: string): Salida {
    const avisos = aviso ? [aviso] : [];
    switch (e.paso) {
      case 'inicio':
      case 'listo':
      case 'documento':
        return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO, undefined, avisos) };
      case 'renovar':
        return this.renovar(e);
      case 'confirmar_documento':
        return this.confirmacionDocumento(e, avisos);
      case 'propuesta':
        return this.mostrarPropuesta(e, avisos);
      case 'resumen':
        return this.resumen(e, avisos);
      case 'corregir':
        return this.menuCorregir(e, avisos);
      case 'coarrendatarios':
        return this.menuCoarrendatarios(e, avisos);
      default:
        return this.preguntar(e, e.paso, avisos);
    }
  }

  /**
   * El contrato no pasó la verificación y no se envió. Si es por un dato, se pide ese dato y luego se vuelve al
   * resumen; si no, mensaje general (el detalle queda en la bitácora).
   */
  problemaAlGenerar(e: EstadoAsistente, problemas: Problema[]): Salida {
    e.volverAResumen = true;
    const deDato = problemas.find((p) => (p.tipo === 'dato_faltante' || p.tipo === 'dato_invalido') && p.campo);
    if (deDato) {
      const campo = deDato.campo!;
      const aviso = `⚠️ No envié el contrato: falta o no es válido el dato "${ETIQUETAS[campo]}". ${deDato.detalle}`;
      const paso = ORDEN.find((p) => p !== 'unidad' && CAMPOS_DE[p].includes(campo));
      if (paso) return this.preguntar(e, paso, [aviso], true);
      if (campo === 'coarrendatarios') return this.menuCorregir(e, [aviso]);
      if (campo.startsWith('arrendatario_')) {
        e.paso = 'documento';
        e.reemplazarPrincipal = true;
        return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO, undefined, [aviso]) };
      }
    }
    return this.resumen(e, [
      '⚠️ No envié el contrato: el documento no pasó la verificación. Quedó registrado; intenta de nuevo y, si se repite, avísale al administrador.',
    ]);
  }

  private base(anterior: DatosContrato): EstadoAsistente['base'] {
    return { datos: { ...anterior }, id: this.catalogo.idDe(anterior) };
  }

  /** Tarjeta final después de enviar el contrato. */
  generado(e: EstadoAsistente, avisos: string[] = []): Mensaje {
    return {
      texto:
        `✅ Contrato generado\n\n${describir(e.datos)}\n\n` +
        avisos.map((a) => `${a}\n\n`).join('') +
        '🖨️ Imprímelo y fírmenlo ambas partes.\nPara otro contrato, envía la foto de la siguiente cédula 📷',
    };
  }

  /** Resultado de leer una foto de documento (o de interpretarlo desde texto). */
  async recibirDocumento(e: EstadoAsistente, doc: DocumentoDetectado): Promise<Salida> {
    const nueva = e.paso === 'inicio' || e.paso === 'listo';
    if (nueva) this.iniciar(e);
    e.documentoParcial = undefined;

    // Dos cédulas seguidas (p. ej. un álbum): la anterior, aún sin confirmar, se da por buena.
    const avisos: string[] = [];
    if (e.paso === 'confirmar_documento' && e.documento) avisos.push(this.incorporarPendiente(e));

    if (!doc.nombre || !doc.numero || doc.observacion) {
      e.paso = 'documento';
      const leido = [doc.nombre && `Nombre: ${doc.nombre}`, doc.numero && `Número: ${doc.numero}`].filter(Boolean);
      const aviso =
        '🤔 No pude leer bien el documento' +
        (doc.observacion ? ` (${doc.observacion})` : '') +
        '.' +
        (leido.length ? `\nAlcancé a leer:\n${leido.join('\n')}` : '');
      return { tarjeta: this.tarjeta(e, `Envía otra foto más nítida o escribe el nombre y el número. Ej.: ${EJEMPLO_DOCUMENTO}`, undefined, [...avisos, aviso]), nueva };
    }

    e.documento = { ...doc, tipo: doc.tipo ?? 'CC' };
    e.paso = 'confirmar_documento';
    return { ...this.confirmacionDocumento(e, avisos), nueva };
  }

  async recibirTexto(e: EstadoAsistente, texto: string): Promise<Salida> {
    switch (e.paso) {
      case 'inicio':
      case 'listo':
      case 'renovar':
      case 'documento':
      case 'confirmar_documento': {
        const nueva = e.paso === 'inicio' || e.paso === 'listo' || e.paso === 'renovar';
        const avisos: string[] = [];
        if (senalesDeDatos(texto) >= 2) {
          if (nueva) this.iniciar(e);
          const libre = await this.interpretarLibre(e, texto);
          if (libre === FALLO_IA) avisos.push(AVISO_IA);
          else if (libre) return { ...libre, nueva };
        }
        // Nombre y número pueden llegar en mensajes separados: "Brayan Munar Vásquez", luego "CC 1019141472".
        const doc = interpretarDocumentoEscrito(texto);
        const junto = { ...(e.paso === 'documento' ? e.documentoParcial : undefined), ...doc };
        if (junto.nombre && junto.numero) {
          if (nueva) this.iniciar(e);
          // Lo escrito reemplaza la lectura pendiente y, como la foto, se confirma antes de usarlo.
          if (e.paso === 'confirmar_documento') e.documento = undefined;
          return { ...(await this.recibirDocumento(e, { tipo: 'CC', ...junto })), nueva };
        }
        if (nueva) return this.iniciar(e);
        if (e.paso === 'documento' && (doc.nombre || doc.numero)) {
          e.documentoParcial = junto;
          const falta = junto.nombre
            ? `🔢 ¿Cuál es el número de documento de ${junto.nombre}?`
            : '👤 ¿Cuál es el nombre completo del arrendatario?';
          return { tarjeta: this.tarjeta(e, falta, undefined, avisos) };
        }
        return this.actual(e, [...avisos, '🤔 No entendí el nombre y número del documento.'].join('\n'));
      }
      case 'propuesta':
      case 'resumen':
      case 'corregir':
      case 'coarrendatarios': {
        // Correcciones escritas: "cambia el canon a 800 mil".
        const libre = await this.interpretarLibre(e, texto);
        if (libre && libre !== FALLO_IA) return libre;
        return (
          this.correccionDocumento(e, texto) ??
          this.actual(e, libre === FALLO_IA ? AVISO_IA : '👇 Usa los botones o escribe qué cambiar.')
        );
      }
      default: {
        const paso = e.paso;
        // Varios datos en un mensaje: se interpretan todos. Uno solo: intérprete local, y Claude si no lo entiende.
        const varios = senalesDeDatos(texto) >= 2;
        const valor = varios ? null : PREGUNTAS[paso].interpretar(texto, this.contexto(e));
        if (valor) return this.aplicar(e, paso, valor);
        const libre = await this.interpretarLibre(e, texto);
        if (libre && libre !== FALLO_IA) return libre;
        const avisos = [`🤔 No entendí "${texto.slice(0, 60)}".`];
        if (libre === FALLO_IA) avisos.push(AVISO_IA);
        return this.preguntar(e, paso, avisos, true);
      }
    }
  }

  /** `data` tiene la forma "<paso>:<acción>", tal como se generó en los botones. */
  async recibirBoton(e: EstadoAsistente, data: string): Promise<Salida> {
    const [paso, accion = ''] = data.split(':');
    const obsoleto = (): Salida => ({ ...this.actual(e), obsoleto: true });
    if (paso !== e.paso) return obsoleto();

    switch (e.paso) {
      case 'renovar': {
        const numero = e.ofertas[Number(accion.slice(1))]?.arrendatario_numero_documento;
        const anterior = numero ? this.catalogo.arrendatario(numero)?.ultimoContrato : undefined;
        if (!anterior) return obsoleto();
        const { datos, avisos } = this.renovacion(anterior);
        e.datos = datos;
        e.base = this.base(anterior);
        return this.resumen(e, avisos);
      }

      case 'confirmar_documento':
        if (accion === 'ok' && e.documento) return this.confirmarDocumento(e, e.documento);
        if (accion === 'agregar' && e.documento) return this.agregarCoarrendatario(e, e.documento);
        e.paso = 'documento';
        return { tarjeta: this.tarjeta(e, `✏️ Escribe el nombre completo y el número del documento. Ej.: ${EJEMPLO_DOCUMENTO}`) };

      case 'propuesta':
        if (accion === 'ok' && e.propuesta) {
          for (const [k, v] of Object.entries(e.propuesta)) {
            if ((e.datos as Record<string, unknown>)[k] === undefined) (e.datos as Record<string, unknown>)[k] = v;
          }
        }
        else e.base = undefined; // paso a paso: ya no es una renovación del anterior
        e.propuesta = undefined;
        return this.avanzar(e);

      case 'resumen':
        if (accion === 'generar') {
          if (!estaCompleto(e.datos)) return this.avanzar(e);
          e.paso = 'listo';
          return {
            tarjeta: { texto: `📄 Contrato\n\n${describir(e.datos)}\n\n⏳ Generando el contrato…` },
            generar: e.datos,
          };
        }
        if (accion === 'corregir') return this.menuCorregir(e);
        Object.assign(e, estadoInicial());
        return { tarjeta: { texto: '❌ Contrato cancelado.\n\nEnvía otra foto de cédula cuando quieras empezar uno nuevo.' } };

      case 'corregir':
        e.volverAResumen = true;
        if (accion === 'volver') return this.resumen(e);
        if (accion === 'documento') {
          e.paso = 'documento';
          e.reemplazarPrincipal = true;
          return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO) };
        }
        if (accion === 'coarrendatarios') return this.menuCoarrendatarios(e);
        return esPasoDato(accion) ? this.preguntar(e, accion) : this.resumen(e);

      case 'coarrendatarios': {
        const i = Number(accion.slice(1));
        const quitado = accion.startsWith('q') ? e.datos.coarrendatarios?.[i] : undefined;
        if (!quitado) return this.resumen(e);
        e.datos.coarrendatarios = e.datos.coarrendatarios!.filter((_, j) => j !== i);
        const aviso = `🗑 Quité a ${quitado.nombre}.`;
        return e.datos.coarrendatarios.length ? this.menuCoarrendatarios(e, [aviso]) : this.resumen(e, [aviso]);
      }

      default: {
        if (!esPasoDato(e.paso)) return obsoleto();
        const actual = e.paso;
        // Fecha: "Otra fecha" abre un calendario; sus botones son "cal<AAAA-MM>" (cambiar de mes) y "d<AAAA-MM-DD>".
        if (actual === 'fecha' && accion === 'otro') return this.calendario(e, this.hoy().slice(0, 7));
        if (actual === 'fecha' && /^cal\d{4}-\d{2}$/.test(accion)) return this.calendario(e, accion.slice(3));
        if (actual === 'fecha' && /^d\d{4}-\d{2}-\d{2}$/.test(accion)) return this.aplicar(e, 'fecha', { fecha_inicio: accion.slice(1) });
        if (actual === 'fecha' && accion === 'opciones') return this.preguntar(e, 'fecha');
        if (accion === 'otro') return this.preguntar(e, actual, [], true);
        if (accion === 'atras') return this.atras(e, actual);
        const i = Number(accion.slice(1));
        if (!accion.startsWith('v') || !(i in e.ofertas)) return obsoleto();
        return this.aplicar(e, actual, e.ofertas[i]!);
      }
    }
  }

  // --- Pasos internos ----------------------------------------------------------------------------

  private async confirmarDocumento(e: EstadoAsistente, doc: DocumentoDetectado): Promise<Salida> {
    const { guardados, errores } = validarParcial({
      arrendatario_nombre: doc.nombre,
      arrendatario_tipo_documento: doc.tipo ?? 'CC',
      arrendatario_numero_documento: doc.numero,
    });
    const problemas = Object.values(errores);
    const porTipo = guardados.arrendatario_numero_documento
      ? errorDocumento(guardados.arrendatario_tipo_documento!, guardados.arrendatario_numero_documento)
      : null;
    if (porTipo) problemas.push(porTipo);
    if (problemas.length) {
      e.paso = 'documento';
      return { tarjeta: this.tarjeta(e, `Escribe el nombre y número correctos. Ej.: ${EJEMPLO_DOCUMENTO}`, undefined, [`⚠️ ${problemas.join(' ')}`]) };
    }
    Object.assign(e.datos, guardados);
    e.datos.coarrendatarios = (e.datos.coarrendatarios ?? []).filter(
      (p) => p.numero !== guardados.arrendatario_numero_documento,
    );
    e.documento = undefined;
    e.reemplazarPrincipal = false;

    const yaConocido = this.catalogo.arrendatario(guardados.arrendatario_numero_documento!);
    const avisos = yaConocido ? ['👋 Ya tuvo un contrato antes; te sugiero sus datos anteriores.'] : [];

    // Si es una corrección o el contrato ya está avanzado, sigue donde iba.
    if (e.volverAResumen || e.datos.inmueble_direccion) return this.avanzar(e, avisos);

    if (yaConocido?.ultimoContrato) {
      const renovacion = this.renovacion(yaConocido.ultimoContrato);
      e.propuesta = renovacion.datos;
      e.base = this.base(yaConocido.ultimoContrato);
      e.paso = 'propuesta';
      return this.mostrarPropuesta(e, renovacion.avisos);
    }

    const propuesta = this.proponer(e);
    if (!propuesta) return this.avanzar(e, avisos);
    e.propuesta = propuesta;
    e.paso = 'propuesta';
    return this.mostrarPropuesta(e, avisos);
  }

  /**
   * Aplica los datos que el extractor encuentre en un mensaje libre. Devuelve null si no hay extractor o no
   * entendió nada, y FALLO_IA si no se pudo consultar, para que quien llama responda como siempre.
   */
  private async interpretarLibre(e: EstadoAsistente, texto: string): Promise<Salida | null | typeof FALLO_IA> {
    if (!this.extractor) return null;
    const pregunta = esPasoDato(e.paso) ? PREGUNTAS[e.paso] : undefined;
    let extraidos: DatosExtraidos;
    try {
      extraidos = await this.extractor.extraer(texto, {
        hoy: this.hoy(),
        edificios: this.catalogo.edificios(10),
        pregunta: pregunta && (typeof pregunta.pregunta === 'string' ? pregunta.pregunta : pregunta.titulo),
      });
    } catch (err) {
      console.error('[asistente] Error interpretando mensaje libre:', err);
      return FALLO_IA;
    }

    const { apartamento, ...campos } = extraidos;
    const avisos: string[] = [];
    if (apartamento && !campos.inmueble_direccion) {
      const unico = this.catalogo.edificios(2);
      const edificio = e.edificio ?? (unico.length === 1 ? unico[0] : undefined);
      if (edificio) campos.inmueble_direccion = componerDireccion(edificio, String(apartamento));
      else avisos.push(`🤔 ¿De qué edificio es el apto ${apartamento}?`);
    }

    const { guardados, errores } = validarParcial(campos);
    for (const [campo, error] of Object.entries(errores)) {
      avisos.push(`⚠️ ${ETIQUETAS[campo as CampoContrato]}: ${error}`);
    }
    if (!Object.keys(guardados).length && !avisos.length) return null;

    // Aceptar la sugerencia y corregir encima: "sí, pero a 800 mil".
    if (e.paso === 'propuesta' && e.propuesta) {
      e.datos = { ...e.propuesta, ...e.datos };
      e.propuesta = undefined;
    }

    // Edificio sin apartamento: se guarda y se pregunta el apartamento.
    let faltaApartamento = false;
    if (guardados.inmueble_direccion) {
      const { base, unidad } = separarUnidad(guardados.inmueble_direccion);
      e.edificio = base;
      await this.catalogo.agregarEdificio(base);
      if (unidad) {
        // Mismo formato que con botones, aunque llegue "…, Bogotá apto 302".
        guardados.inmueble_direccion = componerDireccion(base, unidad);
        if (e.datos.arrendatario_direccion && e.datos.arrendatario_direccion === e.datos.inmueble_direccion) {
          e.datos.arrendatario_direccion = guardados.inmueble_direccion;
        }
        await this.catalogo.agregarInmueble(guardados.inmueble_direccion);
      } else {
        delete guardados.inmueble_direccion;
        faltaApartamento = true;
      }
    }

    Object.assign(e.datos, guardados);
    const entendidos = CAMPOS.filter((c) => c in guardados).map((c) => ETIQUETAS[c].toLowerCase());
    if (entendidos.length) avisos.unshift(`✍️ Entendí: ${entendidos.join(', ')}.`);

    if (faltaApartamento) return this.preguntar(e, 'unidad', avisos);
    if (['resumen', 'corregir', 'propuesta'].includes(e.paso)) e.volverAResumen = true;
    return this.avanzar(e, avisos);
  }

  /**
   * Cédula escrita desde el resumen ("1019141472" o "Brayan Munar 1019141472"): corrige al arrendatario
   * principal, con la misma confirmación que una foto. Un número suelto solo cuenta si parece cédula (7 a 10
   * dígitos y no es un celular), para no confundirlo con un valor.
   */
  private correccionDocumento(e: EstadoAsistente, texto: string): Salida | null {
    if ((e.paso !== 'resumen' && e.paso !== 'corregir') || !e.datos.arrendatario_nombre) return null;
    const doc = interpretarDocumentoEscrito(texto);
    if (!doc.numero) return null;
    const suelto = !doc.nombre && !doc.tipo;
    if (suelto && (!/^\d{7,10}$/.test(doc.numero) || /^3\d{9}$/.test(doc.numero) || senalesDeDatos(texto))) return null;
    e.documento = {
      nombre: doc.nombre ?? e.datos.arrendatario_nombre,
      tipo: doc.tipo ?? e.datos.arrendatario_tipo_documento ?? 'CC',
      numero: doc.numero,
    };
    e.reemplazarPrincipal = true;
    e.volverAResumen = true;
    e.paso = 'confirmar_documento';
    return this.confirmacionDocumento(e);
  }

  /**
   * Contrato que continúa al anterior: mismos datos, empieza el día siguiente al vencimiento y sin depósito
   * (ya se entregó). El canon se mantiene; los avisos recuerdan revisarlo.
   */
  private renovacion(anterior: DatosContrato): { datos: Datos; avisos: string[] } {
    const fin = fechaFin(anterior.fecha_inicio, anterior.duracion_meses);
    const inicio = sumarDias(fin, 1);
    const avisos = [
      `🔁 Renovación del contrato que ${fin < this.hoy() ? 'venció' : 'vence'} el ${fechaALetras(fin)}.`,
      '💰 Mismo canon anterior; corrígelo si hay reajuste.',
    ];
    if (anterior.deposito > 0) avisos.push('🔐 Sin depósito: ya se entregó en el contrato anterior. Corrígelo si aplica.');
    if (inicio < this.hoy()) avisos.push('⚠️ La fecha de inicio ya pasó; corrígela si el nuevo contrato empieza después.');
    return {
      datos: { ...anterior, coarrendatarios: anterior.coarrendatarios ?? [], fecha_inicio: inicio, deposito: 0 },
      avisos,
    };
  }

  /** Sugerencia completa con lo usado antes. Solo si hay al menos inmueble y canon para sugerir. */
  private proponer(e: EstadoAsistente): Datos | undefined {
    const anterior = this.catalogo.arrendatario(e.datos.arrendatario_numero_documento!);
    const direccion = anterior?.ultimoInmueble ?? this.catalogo.inmuebles(1)[0];
    if (!direccion) return undefined;
    const inmueble = this.catalogo.inmueble(direccion);
    const precio = inmueble?.ultimoPrecio ?? this.catalogo.precios(direccion, 1)[0];
    if (!precio) return undefined;

    const p: Datos = {
      inmueble_direccion: inmueble?.direccion ?? direccion,
      precio_mensual: precio,
      deposito: inmueble?.ultimoDeposito,
      duracion_meses: this.catalogo.duraciones(1)[0] ?? 6,
      fecha_inicio: primeroDelMesSiguiente(this.hoy()),
    };
    if (anterior) {
      Object.assign(p, {
        numero_ocupantes: anterior.ocupantes,
        arrendatario_celular: anterior.celular ?? '',
        arrendatario_correo: anterior.correo ?? '',
        arrendatario_direccion: anterior.direccion,
      });
    }
    // Quita lo que no se pudo sugerir para que se pregunte después.
    for (const k of Object.keys(p) as (keyof DatosContrato)[]) if (p[k] === undefined) delete p[k];
    return p;
  }

  private async aplicar(e: EstadoAsistente, paso: PasoDato, valor: Datos): Promise<Salida> {
    const { guardados, errores } = validarParcial(valor);
    const problemas = Object.values(errores);
    if (problemas.length) return this.preguntar(e, paso, problemas.map((p) => `⚠️ ${p}`), true);
    if (guardados.numero_ocupantes !== undefined && guardados.numero_ocupantes < personas(e.datos)) {
      return this.preguntar(e, paso, [`⚠️ Son ${personas(e.datos)} arrendatarios: los ocupantes no pueden ser menos.`], true);
    }

    const avisos: string[] = [];

    // Se eligió o escribió un edificio: se guarda y, si no trae apartamento, falta preguntar cuál.
    if (paso === 'inmueble' && guardados.inmueble_direccion) {
      const { base, unidad } = separarUnidad(guardados.inmueble_direccion);
      e.edificio = base;
      if (await this.catalogo.agregarEdificio(base)) avisos.push('💾 Guardé este edificio para la próxima vez.');
      if (!unidad) return this.preguntar(e, 'unidad', avisos);
    }

    if (guardados.inmueble_direccion) {
      const nueva = guardados.inmueble_direccion;
      // Si la notificación iba "a la del inmueble", que siga al inmueble nuevo.
      if (e.datos.arrendatario_direccion && e.datos.arrendatario_direccion === e.datos.inmueble_direccion) {
        e.datos.arrendatario_direccion = nueva;
      }
      await this.catalogo.agregarInmueble(nueva);
    }
    Object.assign(e.datos, guardados);
    return this.avanzar(e, avisos);
  }

  private avanzar(e: EstadoAsistente, avisos: string[] = []): Salida {
    if (!e.datos.arrendatario_numero_documento || !e.datos.arrendatario_nombre) {
      e.paso = 'documento';
      return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO, undefined, avisos) };
    }
    if (e.volverAResumen) return this.resumen(e, avisos);
    const siguiente = ORDEN.find((p) => pendiente(e.datos, p));
    return siguiente ? this.preguntar(e, siguiente, avisos) : this.resumen(e, avisos);
  }

  /** Vuelve a la pregunta anterior (o al documento si es la primera). */
  private atras(e: EstadoAsistente, paso: PasoDato): Salida {
    // Corrigiendo un dato desde el resumen, "atrás" es volver al resumen sin cambiarlo (el apartamento vuelve
    // al edificio, por si se quiere elegir otro).
    if (e.volverAResumen && paso !== 'unidad') return this.resumen(e);
    const i = ORDEN.indexOf(paso);
    if (i === 0) {
      e.paso = 'documento';
      return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO) };
    }
    return this.preguntar(e, ORDEN[i - 1]!);
  }

  /**
   * Calendario del mes `mes` (AAAA-MM) para elegir la fecha de inicio con un toque, como en un formulario web.
   * Semanas de lunes a domingo; hoy va entre corchetes y la fecha ya elegida con ✅. También se puede escribir.
   */
  private calendario(e: EstadoAsistente, mes: string): Salida {
    e.paso = 'fecha';
    const [anio, m] = mes.split('-').map(Number) as [number, number];
    const iso = (d: number) => `${mes}-${String(d).padStart(2, '0')}`;
    const otroMes = (delta: number) => {
      const total = anio * 12 + (m - 1) + delta;
      return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
    };
    const nada = { texto: '·', data: `fecha:cal${mes}` }; // celdas sin acción: redibujan el mismo mes
    const diasDelMes = new Date(Date.UTC(anio, m, 0)).getUTCDate();
    const blancos = (new Date(Date.UTC(anio, m - 1, 1)).getUTCDay() + 6) % 7; // lunes = 0

    const celdas: Boton[] = Array.from({ length: blancos }, () => nada);
    for (let d = 1; d <= diasDelMes; d++) {
      const texto = iso(d) === e.datos.fecha_inicio ? `✅${d}` : iso(d) === this.hoy() ? `[${d}]` : String(d);
      celdas.push({ texto, data: `fecha:d${iso(d)}` });
    }
    while (celdas.length % 7) celdas.push(nada);

    const filas: Boton[][] = [
      [
        { texto: '◀️', data: `fecha:cal${otroMes(-1)}` },
        { texto: fechaALetras(`${mes}-01`).replace(/^1 de /, ''), data: `fecha:cal${mes}` },
        { texto: '▶️', data: `fecha:cal${otroMes(1)}` },
      ],
      ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((texto) => ({ ...nada, texto })),
    ];
    for (let i = 0; i < celdas.length; i += 7) filas.push(celdas.slice(i, i + 7));
    filas.push([{ texto: '⬅️ Atrás', data: 'fecha:opciones' }]); // vuelve a las fechas rápidas
    return {
      tarjeta: this.tarjeta(e, `${PREGUNTAS.fecha.pregunta as string}\n📅 Toca el día, o escríbela (ej.: 15/11/2026).`, filas),
    };
  }

  /** `escribir`: el usuario va a escribir el valor; se muestra la ayuda en vez de los botones de opciones. */
  private preguntar(e: EstadoAsistente, paso: PasoDato, avisos: string[] = [], escribir = false): Salida {
    const c = this.contexto(e);
    if (paso === 'unidad' && !c.edificio) return this.preguntar(e, 'inmueble', avisos);
    const p = PREGUNTAS[paso];
    const opciones = p.opciones(c);
    e.paso = paso;
    e.ofertas = opciones.map((o) => o.valor);

    // Sin valores guardados todavía (primera vez): se pide escribirlo directamente.
    const haySugerencias = opciones.some((o) => !o.fija);
    const mostrarAyuda = escribir || !haySugerencias;

    const filas: Boton[][] = [];
    // Valores guardados en filas de `porFila`; las opciones fijas, cada una en su propia fila.
    let enFila = 0;
    opciones.forEach((o, i) => {
      const boton = { texto: o.etiqueta, data: `${paso}:v${i}` };
      if (o.fija) {
        filas.push([boton]);
        enFila = 0;
        return;
      }
      if (enFila % p.porFila === 0) filas.push([]);
      filas.at(-1)!.push(boton);
      enFila++;
    });
    const navegacion: Boton[] = [];
    if (haySugerencias && !escribir) navegacion.push({ texto: p.otro, data: `${paso}:otro` });
    const alResumen = e.volverAResumen && paso !== 'unidad';
    navegacion.push({ texto: alResumen ? '↩️ Volver al resumen' : '⬅️ Atrás', data: `${paso}:atras` });
    filas.push(navegacion);

    const pregunta = typeof p.pregunta === 'function' ? p.pregunta(c) : p.pregunta;
    const texto = mostrarAyuda ? `${pregunta}\n✍️ ${p.ayuda}` : pregunta;
    return { tarjeta: this.tarjeta(e, texto, filas, avisos) };
  }

  private resumen(e: EstadoAsistente, avisos: string[] = []): Salida {
    const faltante = ORDEN.find((p) => pendiente(e.datos, p));
    if (faltante) {
      e.volverAResumen = false;
      return this.preguntar(e, faltante, avisos);
    }
    e.paso = 'resumen';
    e.volverAResumen = false;
    if (e.base) {
      const cambios = compararConAnterior(e.base.datos, e.datos as DatosContrato);
      avisos = [
        ...avisos,
        cambios.length
          ? `🔁 Cambios respecto al contrato anterior:\n${cambios.map((c) => `• ${c.etiqueta}: ${c.antes} → ${c.despues}`).join('\n')}`
          : '🔁 Igual al contrato anterior.',
      ];
    }
    const revisar = this.revisar(e.datos);
    if (revisar.length) avisos = [...avisos, `🔎 Revisa antes de generar:\n${revisar.map((r) => `• ${r}`).join('\n')}`];
    return {
      tarjeta: {
        texto: this.componer(
          '📄 Resumen del contrato',
          describir(e.datos),
          avisos,
          '¿Genero el contrato?\n📷 ¿Otro arrendatario? Envía su cédula.',
        ),
        botones: [
          [{ texto: '✅ Generar contrato', data: 'resumen:generar' }],
          [
            { texto: '✏️ Corregir', data: 'resumen:corregir' },
            { texto: '❌ Cancelar', data: 'resumen:cancelar' },
          ],
        ],
      },
    };
  }

  /**
   * Datos válidos pero raros, que suelen ser un error al escribir o al interpretar: se muestran en el resumen
   * para revisarlos antes de generar (no impiden generar).
   */
  private revisar(d: Datos): string[] {
    const r: string[] = [];
    const numero = d.arrendatario_numero_documento;
    if (numero && d.arrendatario_tipo_documento === 'CC' && numero.length < 7) {
      r.push(`La cédula tiene solo ${numero.length} dígitos (${formatoMiles(Number(numero))}).`);
    }
    const anterior = numero ? this.catalogo.arrendatario(numero) : undefined;
    if (anterior && d.arrendatario_nombre && anterior.nombre !== d.arrendatario_nombre) {
      r.push(`Esa cédula ya estaba registrada a nombre de ${anterior.nombre}.`);
    }
    const ultimo = d.inmueble_direccion ? this.catalogo.inmueble(d.inmueble_direccion)?.ultimoPrecio : undefined;
    if (d.precio_mensual && ultimo && Math.abs(d.precio_mensual - ultimo) / ultimo > 0.4) {
      r.push(`El canon (${pesos(d.precio_mensual)}) es muy distinto al anterior de este inmueble (${pesos(ultimo)}).`);
    }
    if (d.precio_mensual && d.deposito && d.deposito > 2 * d.precio_mensual) {
      r.push(`El depósito (${pesos(d.deposito)}) es más del doble del canon.`);
    }
    if (d.fecha_inicio) {
      const hoy = this.hoy();
      if (d.fecha_inicio < sumarDias(hoy, -30)) r.push(`La fecha de inicio (${fechaALetras(d.fecha_inicio)}) ya pasó hace más de un mes.`);
      else if (d.fecha_inicio > sumarDias(hoy, 180)) r.push(`La fecha de inicio (${fechaALetras(d.fecha_inicio)}) es en más de 6 meses.`);
    }
    return r;
  }

  private confirmacionDocumento(e: EstadoAsistente, avisos: string[] = []): Salida {
    const d = e.documento!;
    const leido =
      `🪪 Leí este documento:\n\n${d.nombre}\n` +
      `${TIPOS_DOCUMENTO[d.tipo ?? 'CC']}: ${documento(d.tipo ?? 'CC', d.numero!.replace(/[.\s-]/g, ''))}\n\n` +
      (this.hayPrincipal(e) ? '¿Es otro arrendatario de este contrato? Revisa bien el número.' : '¿Está correcto? Revisa bien el número.');
    const botones: Boton[][] = this.hayPrincipal(e)
      ? [
          [{ texto: '👥 Agregar como otro arrendatario', data: 'confirmar_documento:agregar' }],
          [{ texto: `🔄 Reemplazar a ${e.datos.arrendatario_nombre!.split(' ')[0]}`, data: 'confirmar_documento:ok' }],
          [{ texto: '✏️ Corregir', data: 'confirmar_documento:editar' }],
        ]
      : [
          [
            { texto: '✅ Sí, continuar', data: 'confirmar_documento:ok' },
            { texto: '✏️ Corregir', data: 'confirmar_documento:editar' },
          ],
        ];
    return { tarjeta: this.tarjeta(e, leido, botones, avisos) };
  }

  private mostrarPropuesta(e: EstadoAsistente, avisos: string[] = []): Salida {
    return {
      tarjeta: {
        texto: this.componer(
          '📄 Contrato nuevo',
          describir({ ...e.datos, ...e.propuesta }),
          avisos,
          '💡 Te sugiero estos datos según contratos anteriores. ¿Los usamos?',
        ),
        botones: [
          [{ texto: '✅ Usar sugerencia', data: 'propuesta:ok' }],
          [{ texto: '✏️ Elegir paso a paso', data: 'propuesta:paso' }],
        ],
      },
    };
  }

  private menuCorregir(e: EstadoAsistente, avisos: string[] = []): Salida {
    e.paso = 'corregir';
    const conCo = !!e.datos.coarrendatarios?.length;
    const filas: Boton[][] = [[{ texto: conCo ? '🪪 Arrendatario principal' : '🪪 Arrendatario', data: 'corregir:documento' }]];
    if (conCo) filas.push([{ texto: '👥 Quitar co-arrendatario', data: 'corregir:coarrendatarios' }]);
    const corregibles = ORDEN.filter((p) => p !== 'unidad'); // el apartamento se corrige desde "Inmueble"
    for (let i = 0; i < corregibles.length; i += 2) {
      filas.push(corregibles.slice(i, i + 2).map((p) => ({ texto: PREGUNTAS[p].titulo, data: `corregir:${p}` })));
    }
    filas.push([{ texto: '↩️ Volver al resumen', data: 'corregir:volver' }]);
    return { tarjeta: { texto: this.componer('📄 Resumen del contrato', describir(e.datos), avisos, '✏️ ¿Qué quieres corregir?'), botones: filas } };
  }

  private menuCoarrendatarios(e: EstadoAsistente, avisos: string[] = []): Salida {
    e.paso = 'coarrendatarios';
    const filas: Boton[][] = (e.datos.coarrendatarios ?? []).map((p, i) => [
      { texto: `🗑 ${p.nombre}`, data: `coarrendatarios:q${i}` },
    ]);
    filas.push([{ texto: '↩️ Volver al resumen', data: 'coarrendatarios:volver' }]);
    return {
      tarjeta: {
        texto: this.componer('📄 Resumen del contrato', describir(e.datos), avisos, '👥 ¿A quién quito del contrato?'),
        botones: filas,
      },
    };
  }

  /** Hay arrendatario principal y no se está corrigiendo: una cédula nueva puede ser otro arrendatario. */
  private hayPrincipal(e: EstadoAsistente): boolean {
    return !!e.datos.arrendatario_numero_documento && !e.reemplazarPrincipal;
  }

  private validarPersona(doc: DocumentoDetectado): { nombre: string; tipo: TipoDocumento; numero: string } | string {
    const { guardados, errores } = validarParcial({
      arrendatario_nombre: doc.nombre,
      arrendatario_tipo_documento: doc.tipo ?? 'CC',
      arrendatario_numero_documento: doc.numero,
    });
    const problemas = Object.values(errores);
    const porTipo = guardados.arrendatario_numero_documento
      ? errorDocumento(guardados.arrendatario_tipo_documento!, guardados.arrendatario_numero_documento)
      : null;
    if (porTipo) problemas.push(porTipo);
    if (problemas.length) return problemas.join(' ');
    return {
      nombre: guardados.arrendatario_nombre!,
      tipo: guardados.arrendatario_tipo_documento!,
      numero: guardados.arrendatario_numero_documento!,
    };
  }

  /** Suma una persona como co-arrendatario. Devuelve el aviso a mostrar. */
  private sumarCoarrendatario(e: EstadoAsistente, doc: DocumentoDetectado): string {
    const p = this.validarPersona(doc);
    if (typeof p === 'string') return `⚠️ ${doc.nombre ?? 'Documento'}: ${p}`;
    const lista = e.datos.coarrendatarios ?? [];
    if (p.numero === e.datos.arrendatario_numero_documento || lista.some((c) => c.numero === p.numero)) {
      return `⚠️ ${p.nombre} ya está en el contrato.`;
    }
    if (lista.length >= MAX_COARRENDATARIOS) return `⚠️ Máximo ${MAX_COARRENDATARIOS} co-arrendatarios; no agregué a ${p.nombre}.`;
    e.datos.coarrendatarios = [...lista, p];
    return `👥 Agregué a ${p.nombre} como arrendatario.`;
  }

  private async agregarCoarrendatario(e: EstadoAsistente, doc: DocumentoDetectado): Promise<Salida> {
    const aviso = this.sumarCoarrendatario(e, doc);
    e.documento = undefined;
    return this.continuar(e, [aviso]);
  }

  /** Cédula pendiente de confirmar cuando llega otra: principal si no hay, si no co-arrendatario. */
  private incorporarPendiente(e: EstadoAsistente): string {
    const doc = e.documento!;
    e.documento = undefined;
    if (this.hayPrincipal(e)) return this.sumarCoarrendatario(e, doc);
    const p = this.validarPersona(doc);
    if (typeof p === 'string') return `⚠️ ${doc.nombre ?? 'Documento'}: ${p}`;
    e.datos.arrendatario_nombre = p.nombre;
    e.datos.arrendatario_tipo_documento = p.tipo;
    e.datos.arrendatario_numero_documento = p.numero;
    e.reemplazarPrincipal = false;
    return `🪪 Arrendatario: ${p.nombre}.`;
  }

  /** Sigue donde iba el contrato después de agregar a alguien. */
  private continuar(e: EstadoAsistente, avisos: string[]): Salida {
    if (e.propuesta) {
      e.paso = 'propuesta';
      return this.mostrarPropuesta(e, avisos);
    }
    if (!e.datos.inmueble_direccion && !e.volverAResumen) {
      const propuesta = this.proponer(e);
      if (propuesta) {
        e.propuesta = propuesta;
        e.paso = 'propuesta';
        return this.mostrarPropuesta(e, avisos);
      }
    }
    return this.avanzar(e, avisos);
  }

  private contexto(e: EstadoAsistente): Contexto {
    return {
      datos: e.datos,
      catalogo: this.catalogo,
      hoy: this.hoy(),
      edificio: e.edificio ?? (e.datos.inmueble_direccion ? separarUnidad(e.datos.inmueble_direccion).base : ''),
    };
  }

  /** Tarjeta del contrato en curso: datos ya respondidos arriba, avisos y la pregunta actual abajo. */
  private tarjeta(e: EstadoAsistente, pregunta: string, botones?: Boton[][], avisos: string[] = []): Mensaje {
    return { texto: this.componer('📄 Contrato nuevo', describir(e.datos), avisos, pregunta), botones };
  }

  private componer(titulo: string, datos: string, avisos: string[], pie: string): string {
    return [titulo, datos, avisos.join('\n'), pie].filter(Boolean).join('\n\n');
  }
}
