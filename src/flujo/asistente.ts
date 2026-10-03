import { fechaALetras, formatoMiles } from '../contract/numero-a-letras.js';
import {
  ABREVIATURA_DOCUMENTO,
  TIPOS_DOCUMENTO,
  VALORES_POR_DEFECTO,
  estaCompleto,
  validarParcial,
  type CampoContrato,
  type DatosContrato,
} from '../contract/schema.js';
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
  separarUnidad,
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

export type Paso = 'inicio' | 'documento' | 'confirmar_documento' | 'propuesta' | PasoDato | 'resumen' | 'corregir' | 'listo';

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
  propuesta?: Datos;
  /** Edificio elegido (dirección sin apartamento), mientras se pregunta el apartamento. */
  edificio?: string;
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

export function estadoInicial(): EstadoAsistente {
  // Las claves opcionales van explícitas para que Object.assign(e, estadoInicial()) también las limpie.
  return {
    paso: 'inicio',
    datos: { ...VALORES_POR_DEFECTO },
    ofertas: [],
    documento: undefined,
    propuesta: undefined,
    edificio: undefined,
    volverAResumen: false,
  };
}

// --- Formato -------------------------------------------------------------------------------------

const pesos = (n: number) => `$${formatoMiles(n)}`;
const meses = (n: number) =>
  n === 1 ? '1 mes' : n % 12 === 0 ? `${n} meses (${n / 12} ${n === 12 ? 'año' : 'años'})` : `${n} meses`;
const personas = (n: number) => (n === 1 ? '1 persona' : `${n} personas`);
const documento = (tipo: TipoDocumento, numero: string) =>
  `${ABREVIATURA_DOCUMENTO[tipo]} ${/^\d+$/.test(numero) ? formatoMiles(Number(numero)) : numero}`;
const contacto = (d: Datos) =>
  [d.arrendatario_celular, d.arrendatario_correo].filter(Boolean).join(' · ') || '(en blanco)';

const EJEMPLO_DOCUMENTO = 'Laura Gómez Pérez CC 1020345678';
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
    d.inmueble_direccion && `🏠 ${d.inmueble_direccion}`,
    d.precio_mensual && `💰 Precio: ${pesos(d.precio_mensual)} mensuales`,
    d.deposito !== undefined && `🔐 Canon (depósito): ${d.deposito ? pesos(d.deposito) : 'sin canon'}`,
    d.precio_mensual &&
      d.deposito &&
      `💵 Al iniciar: ${pesos(d.precio_mensual + d.deposito)} (primer mes + canon)`,
    d.duracion_meses && `📅 Duración: ${meses(d.duracion_meses)}`,
    periodo,
    d.numero_ocupantes && `👥 Ocupantes: ${personas(d.numero_ocupantes)}`,
    (d.arrendatario_celular !== undefined || d.arrendatario_correo !== undefined) && `📱 Contacto: ${contacto(d)}`,
    d.arrendatario_direccion && `📬 Notificaciones: ${d.arrendatario_direccion}`,
  ];
  return lineas.filter(Boolean).join('\n');
}

// --- Definición de cada pregunta ----------------------------------------------------------------

interface Opcion {
  etiqueta: string;
  valor: Datos;
  /** Opción fija (ej. "Sin canon"), no un valor guardado: si solo hay de estas, se pide escribir. */
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
    titulo: 'Precio',
    pregunta: '💰 ¿Cuál es el precio del arriendo mensual?',
    ayuda: 'Escribe el precio mensual. Ej.: 1.500.000 o "1,5 millones"',
    otro: '➕ Otro valor',
    porFila: 3,
    opciones: (c) =>
      c.catalogo.precios(c.datos.inmueble_direccion, 3).map((v) => ({ etiqueta: pesos(v), valor: { precio_mensual: v } })),
    interpretar: a('precio_mensual', interpretarPesos),
  },
  deposito: {
    titulo: 'Canon',
    pregunta: '🔐 ¿Cuál es el canon (depósito inicial)?',
    ayuda: 'Escribe el valor del canon que se paga al inicio. Ej.: 500.000. Si no hay canon, escribe 0.',
    otro: '➕ Otro valor',
    porFila: 3,
    opciones: (c) => [
      ...c.catalogo.depositos(c.datos.inmueble_direccion, 2).map((v) => ({ etiqueta: pesos(v), valor: { deposito: v } })),
      { etiqueta: 'Sin canon', valor: { deposito: 0 }, fija: true },
    ],
    interpretar: a('deposito', (t) => (/^\s*(0|no|ninguno|sin( canon)?)\s*$/i.test(t) ? 0 : interpretarPesos(t))),
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
    otro: '➕ Otra fecha',
    porFila: 1,
    opciones: (c) => [
      { etiqueta: `Hoy, ${fechaALetras(c.hoy)}`, valor: { fecha_inicio: c.hoy } },
      { etiqueta: fechaALetras(primeroDelMesSiguiente(c.hoy)), valor: { fecha_inicio: primeroDelMesSiguiente(c.hoy) } },
    ],
    interpretar: a('fecha_inicio', interpretarFecha),
  },
  ocupantes: {
    titulo: 'Ocupantes',
    pregunta: '👥 ¿Cuántas personas vivirán en el inmueble?',
    ayuda: 'Escribe el número de personas.',
    otro: '➕ Otro',
    porFila: 4,
    opciones: (c) =>
      unicos([previo(c)?.ocupantes, 1, 2, 3, 4])
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
  ) {}

  iniciar(e: EstadoAsistente): Salida {
    Object.assign(e, estadoInicial(), { paso: 'documento' });
    return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO), nueva: true };
  }

  /** Vuelve a mostrar la tarjeta del paso actual (p. ej. tras un error al generar). */
  actual(e: EstadoAsistente, aviso?: string): Salida {
    const avisos = aviso ? [aviso] : [];
    switch (e.paso) {
      case 'inicio':
      case 'listo':
      case 'documento':
        return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO, undefined, avisos) };
      case 'confirmar_documento':
        return this.confirmacionDocumento(e, avisos);
      case 'propuesta':
        return this.mostrarPropuesta(e, avisos);
      case 'resumen':
        return this.resumen(e, avisos);
      case 'corregir':
        return this.menuCorregir(e, avisos);
      default:
        return this.preguntar(e, e.paso, avisos);
    }
  }

  /** Tarjeta final después de enviar el contrato. */
  generado(e: EstadoAsistente): Mensaje {
    return {
      texto:
        `✅ Contrato generado\n\n${describir(e.datos)}\n\n` +
        '🖨️ Imprímelo y fírmenlo ambas partes.\nPara otro contrato, envía la foto de la siguiente cédula 📷',
    };
  }

  /** Resultado de leer una foto de documento (o de interpretarlo desde texto). */
  async recibirDocumento(e: EstadoAsistente, doc: DocumentoDetectado): Promise<Salida> {
    const nueva = e.paso === 'inicio' || e.paso === 'listo';
    if (nueva) this.iniciar(e);

    if (!doc.nombre || !doc.numero || doc.observacion) {
      e.paso = 'documento';
      const leido = [doc.nombre && `Nombre: ${doc.nombre}`, doc.numero && `Número: ${doc.numero}`].filter(Boolean);
      const aviso =
        '🤔 No pude leer bien el documento' +
        (doc.observacion ? ` (${doc.observacion})` : '') +
        '.' +
        (leido.length ? `\nAlcancé a leer:\n${leido.join('\n')}` : '');
      return { tarjeta: this.tarjeta(e, `Envía otra foto más nítida o escribe el nombre y el número. Ej.: ${EJEMPLO_DOCUMENTO}`, undefined, [aviso]), nueva };
    }

    e.documento = { ...doc, tipo: doc.tipo ?? 'CC' };
    e.paso = 'confirmar_documento';
    return { ...this.confirmacionDocumento(e), nueva };
  }

  async recibirTexto(e: EstadoAsistente, texto: string): Promise<Salida> {
    switch (e.paso) {
      case 'inicio':
      case 'listo':
      case 'documento':
      case 'confirmar_documento': {
        const nueva = e.paso === 'inicio' || e.paso === 'listo';
        const doc = interpretarDocumentoEscrito(texto);
        if (doc.nombre && doc.numero) {
          if (nueva) this.iniciar(e);
          return { ...(await this.confirmarDocumento(e, { tipo: 'CC', ...doc })), nueva };
        }
        if (nueva) return this.iniciar(e);
        return this.actual(e, '🤔 No entendí el nombre y número del documento.');
      }
      case 'propuesta':
      case 'resumen':
      case 'corregir':
        return this.actual(e, '👇 Usa los botones para continuar.');
      default: {
        const paso = e.paso;
        const valor = PREGUNTAS[paso].interpretar(texto, this.contexto(e));
        if (!valor) return this.preguntar(e, paso, [`🤔 No entendí "${texto.slice(0, 60)}".`], true);
        return this.aplicar(e, paso, valor);
      }
    }
  }

  /** `data` tiene la forma "<paso>:<acción>", tal como se generó en los botones. */
  async recibirBoton(e: EstadoAsistente, data: string): Promise<Salida> {
    const [paso, accion = ''] = data.split(':');
    const obsoleto = (): Salida => ({ ...this.actual(e), obsoleto: true });
    if (paso !== e.paso) return obsoleto();

    switch (e.paso) {
      case 'confirmar_documento':
        if (accion === 'ok' && e.documento) return this.confirmarDocumento(e, e.documento);
        e.paso = 'documento';
        return { tarjeta: this.tarjeta(e, `✏️ Escribe el nombre completo y el número del documento. Ej.: ${EJEMPLO_DOCUMENTO}`) };

      case 'propuesta':
        if (accion === 'ok' && e.propuesta) {
          for (const [k, v] of Object.entries(e.propuesta)) {
            if ((e.datos as Record<string, unknown>)[k] === undefined) (e.datos as Record<string, unknown>)[k] = v;
          }
        }
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
          return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO) };
        }
        return esPasoDato(accion) ? this.preguntar(e, accion) : this.resumen(e);

      default: {
        if (!esPasoDato(e.paso)) return obsoleto();
        const actual = e.paso;
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
    if (problemas.length) {
      e.paso = 'documento';
      return { tarjeta: this.tarjeta(e, `Escribe el nombre y número correctos. Ej.: ${EJEMPLO_DOCUMENTO}`, undefined, [`⚠️ ${problemas.join(' ')}`]) };
    }
    Object.assign(e.datos, guardados);
    e.documento = undefined;

    const yaConocido = this.catalogo.arrendatario(guardados.arrendatario_numero_documento!);
    const avisos = yaConocido ? ['👋 Ya tuvo un contrato antes; te sugiero sus datos anteriores.'] : [];

    // Si es una corrección o el contrato ya está avanzado, sigue donde iba.
    if (e.volverAResumen || e.datos.inmueble_direccion) return this.avanzar(e, avisos);

    const propuesta = this.proponer(e);
    if (!propuesta) return this.avanzar(e, avisos);
    e.propuesta = propuesta;
    e.paso = 'propuesta';
    return this.mostrarPropuesta(e, avisos);
  }

  /** Sugerencia completa con lo usado antes. Solo si hay al menos inmueble y precio para sugerir. */
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
    if (e.volverAResumen) return this.resumen(e, avisos);
    const siguiente = ORDEN.find((p) => pendiente(e.datos, p));
    return siguiente ? this.preguntar(e, siguiente, avisos) : this.resumen(e, avisos);
  }

  /** Vuelve a la pregunta anterior (o al documento si es la primera). */
  private atras(e: EstadoAsistente, paso: PasoDato): Salida {
    const i = ORDEN.indexOf(paso);
    if (i === 0) {
      e.paso = 'documento';
      return { tarjeta: this.tarjeta(e, PEDIR_DOCUMENTO) };
    }
    return this.preguntar(e, ORDEN[i - 1]!);
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
    navegacion.push({ texto: '⬅️ Atrás', data: `${paso}:atras` });
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
    return {
      tarjeta: {
        texto: this.componer('📄 Resumen del contrato', describir(e.datos), avisos, '¿Genero el contrato?'),
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

  private confirmacionDocumento(e: EstadoAsistente, avisos: string[] = []): Salida {
    const d = e.documento!;
    const leido =
      `🪪 Leí este documento:\n\n${d.nombre}\n` +
      `${TIPOS_DOCUMENTO[d.tipo ?? 'CC']}: ${documento(d.tipo ?? 'CC', d.numero!.replace(/[.\s-]/g, ''))}\n\n` +
      '¿Está correcto? Revisa bien el número.';
    return {
      tarjeta: this.tarjeta(e, leido, [
        [
          { texto: '✅ Sí, continuar', data: 'confirmar_documento:ok' },
          { texto: '✏️ Corregir', data: 'confirmar_documento:editar' },
        ],
      ], avisos),
    };
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
    const filas: Boton[][] = [[{ texto: '🪪 Arrendatario', data: 'corregir:documento' }]];
    const corregibles = ORDEN.filter((p) => p !== 'unidad'); // el apartamento se corrige desde "Inmueble"
    for (let i = 0; i < corregibles.length; i += 2) {
      filas.push(corregibles.slice(i, i + 2).map((p) => ({ texto: PREGUNTAS[p].titulo, data: `corregir:${p}` })));
    }
    filas.push([{ texto: '↩️ Volver al resumen', data: 'corregir:volver' }]);
    return { tarjeta: { texto: this.componer('📄 Resumen del contrato', describir(e.datos), avisos, '✏️ ¿Qué quieres corregir?'), botones: filas } };
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
