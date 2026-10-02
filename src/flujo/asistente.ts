import { fechaALetras, formatoMiles } from '../contract/numero-a-letras.js';
import {
  ABREVIATURA_DOCUMENTO,
  ETIQUETAS,
  TIPOS_DOCUMENTO,
  VALORES_POR_DEFECTO,
  estaCompleto,
  validarParcial,
  type DatosContrato,
} from '../contract/schema.js';
import type { Catalogo } from '../datos/catalogo.js';
import {
  interpretarDocumentoEscrito,
  interpretarEntero,
  interpretarFecha,
  interpretarMeses,
  interpretarPesos,
  primeroDelMesSiguiente,
} from './interpretar.js';

/** Campos que se preguntan uno por uno, en este orden, después del documento. */
export const ORDEN = [
  'inmueble_direccion',
  'precio_mensual',
  'deposito',
  'duracion_meses',
  'fecha_inicio',
  'numero_ocupantes',
  'arrendatario_celular',
  'arrendatario_correo',
  'arrendatario_direccion',
] as const;
export type CampoPreguntado = (typeof ORDEN)[number];

export type Paso = 'inicio' | 'documento' | 'confirmar_documento' | 'propuesta' | CampoPreguntado | 'resumen' | 'corregir' | 'listo';

type TipoDocumento = DatosContrato['arrendatario_tipo_documento'];

export interface DocumentoDetectado {
  nombre?: string;
  tipo?: TipoDocumento;
  numero?: string;
  /** Por qué no se pudo leer bien (foto borrosa, no es un documento…). */
  observacion?: string;
}

export interface EstadoAsistente {
  paso: Paso;
  datos: Partial<DatosContrato>;
  /** Valores detrás de los botones del paso actual: el botón "v2" es ofertas[2]. */
  ofertas: (string | number)[];
  documento?: DocumentoDetectado;
  propuesta?: Partial<DatosContrato>;
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

export interface Salida {
  mensajes: Mensaje[];
  /** Datos completos y confirmados: el adaptador debe generar y enviar el contrato. */
  generar?: DatosContrato;
  /** El botón pertenece a un paso anterior y se ignoró. */
  obsoleto?: boolean;
}

export function estadoInicial(): EstadoAsistente {
  return { paso: 'inicio', datos: { ...VALORES_POR_DEFECTO }, ofertas: [], volverAResumen: false };
}

// --- Formato -------------------------------------------------------------------------------------

const pesos = (n: number) => `$${formatoMiles(n)}`;
const meses = (n: number) => (n === 1 ? '1 mes' : n % 12 === 0 ? `${n} meses (${n / 12} ${n === 12 ? 'año' : 'años'})` : `${n} meses`);
const personas = (n: number) => (n === 1 ? '1 persona' : `${n} personas`);
const documento = (tipo: TipoDocumento, numero: string) =>
  `${ABREVIATURA_DOCUMENTO[tipo]} ${/^\d+$/.test(numero) ? formatoMiles(Number(numero)) : numero}`;

const EJEMPLO_DOCUMENTO = 'Laura Gómez Pérez CC 1020345678';

// --- Definición de cada pregunta ----------------------------------------------------------------

interface Opcion {
  etiqueta: string;
  valor: string | number;
}

interface Contexto {
  datos: Partial<DatosContrato>;
  catalogo: Catalogo;
  hoy: string;
}

interface Pregunta {
  pregunta: string;
  /** Qué escribir cuando el usuario elige "otro" o no hay opciones guardadas. */
  ayuda: string;
  otro: string;
  porFila: number;
  opciones(c: Contexto): Opcion[];
  interpretar(texto: string, hoy: string): unknown;
}

const previo = (c: Contexto) =>
  c.datos.arrendatario_numero_documento ? c.catalogo.arrendatario(c.datos.arrendatario_numero_documento) : undefined;

const unicos = <T>(valores: (T | undefined | null | '')[]) => [...new Set(valores.filter((v): v is T => !!v || v === 0))];

const PREGUNTAS: Record<CampoPreguntado, Pregunta> = {
  inmueble_direccion: {
    pregunta: '🏠 ¿Qué inmueble se va a arrendar?',
    ayuda: 'Escribe la dirección completa del inmueble, con apartamento si aplica. Ej.: Carrera 105 i 67 d 31 apto 201, Bogotá',
    otro: '➕ Otra dirección',
    porFila: 1,
    opciones: (c) =>
      unicos([previo(c)?.ultimoInmueble, ...c.catalogo.inmuebles(3)])
        .slice(0, 3)
        .map((d) => ({ etiqueta: d, valor: d })),
    interpretar: (t) => t.trim(),
  },
  precio_mensual: {
    pregunta: '💰 ¿Cuál es el precio del arriendo mensual?',
    ayuda: 'Escribe el precio mensual. Ej.: 1.500.000 o "1,5 millones"',
    otro: '➕ Otro valor',
    porFila: 3,
    opciones: (c) => c.catalogo.precios(c.datos.inmueble_direccion, 3).map((v) => ({ etiqueta: pesos(v), valor: v })),
    interpretar: interpretarPesos,
  },
  deposito: {
    pregunta: '🔐 ¿Cuál es el canon (depósito inicial)?',
    ayuda: 'Escribe el valor del canon que se paga al inicio. Ej.: 500.000. Si no hay canon, escribe 0.',
    otro: '➕ Otro valor',
    porFila: 3,
    opciones: (c) => [
      ...c.catalogo.depositos(c.datos.inmueble_direccion, 2).map((v) => ({ etiqueta: pesos(v), valor: v })),
      { etiqueta: 'Sin canon', valor: 0 },
    ],
    interpretar: (t) => (/^\s*(0|no|ninguno|sin( canon)?)\s*$/i.test(t) ? 0 : interpretarPesos(t)),
  },
  duracion_meses: {
    pregunta: '📅 ¿Por cuánto tiempo es el arriendo?',
    ayuda: 'Escribe la duración. Ej.: 9 meses, 1 año',
    otro: '➕ Otro',
    porFila: 2,
    opciones: (c) => unicos([3, 6, ...c.catalogo.duraciones(3)]).slice(0, 4).map((n) => ({ etiqueta: meses(n), valor: n })),
    interpretar: interpretarMeses,
  },
  fecha_inicio: {
    pregunta: '🗓️ ¿Desde qué fecha empieza el contrato?',
    ayuda: 'Escribe la fecha de inicio. Ej.: 15/11/2026 o "15 de noviembre"',
    otro: '➕ Otra fecha',
    porFila: 1,
    opciones: (c) => [
      { etiqueta: `Hoy, ${fechaALetras(c.hoy)}`, valor: c.hoy },
      { etiqueta: fechaALetras(primeroDelMesSiguiente(c.hoy)), valor: primeroDelMesSiguiente(c.hoy) },
    ],
    interpretar: interpretarFecha,
  },
  numero_ocupantes: {
    pregunta: '👥 ¿Cuántas personas vivirán en el inmueble?',
    ayuda: 'Escribe el número de personas.',
    otro: '➕ Otro',
    porFila: 4,
    opciones: (c) => unicos([previo(c)?.ocupantes, 1, 2, 3, 4]).slice(0, 4).sort((a, b) => a - b).map((n) => ({ etiqueta: String(n), valor: n })),
    interpretar: interpretarEntero,
  },
  arrendatario_celular: {
    pregunta: '📱 Celular del arrendatario (para notificaciones):',
    ayuda: 'Escribe el celular (10 dígitos). Ej.: 310 555 1234',
    otro: '➕ Otro número',
    porFila: 1,
    opciones: (c) => [
      ...unicos([previo(c)?.celular]).map((v) => ({ etiqueta: v, valor: v })),
      { etiqueta: 'Dejar en blanco', valor: '' },
    ],
    interpretar: (t) => t,
  },
  arrendatario_correo: {
    pregunta: '✉️ Correo del arrendatario (para notificaciones):',
    ayuda: 'Escribe el correo electrónico.',
    otro: '➕ Otro correo',
    porFila: 1,
    opciones: (c) => [
      ...unicos([previo(c)?.correo]).map((v) => ({ etiqueta: v, valor: v })),
      { etiqueta: 'Dejar en blanco', valor: '' },
    ],
    interpretar: (t) => t,
  },
  arrendatario_direccion: {
    pregunta: '📬 ¿Dónde recibirá notificaciones el arrendatario?',
    ayuda: 'Escribe la dirección de notificación del arrendatario.',
    otro: '➕ Otra dirección',
    porFila: 1,
    opciones: (c) =>
      unicos([c.datos.inmueble_direccion, previo(c)?.direccion]).map((d) => ({
        etiqueta: d === c.datos.inmueble_direccion ? `📍 La del inmueble arrendado` : d,
        valor: d,
      })),
    interpretar: (t) => t.trim(),
  },
};

const esCampoPreguntado = (p: string): p is CampoPreguntado => (ORDEN as readonly string[]).includes(p);

// --- Asistente -----------------------------------------------------------------------------------

/**
 * Asistente guiado con botones para armar un contrato. No sabe nada de Telegram: recibe texto,
 * botones o documentos leídos y devuelve mensajes con botones. Así se puede probar sin red.
 */
export class Asistente {
  constructor(
    private readonly catalogo: Catalogo,
    private readonly hoy: () => string,
  ) {}

  iniciar(e: EstadoAsistente): Salida {
    Object.assign(e, estadoInicial(), { paso: 'documento' });
    return {
      mensajes: [
        {
          texto:
            '📄 Nuevo contrato de arrendamiento.\n\n' +
            '📷 Envía una foto de la cédula del arrendatario (por el frente, sin reflejos).\n\n' +
            `También puedes escribir el nombre y el número. Ej.: ${EJEMPLO_DOCUMENTO}`,
        },
      ],
    };
  }

  /** Resultado de leer una foto de documento (o de interpretarlo desde texto). */
  async recibirDocumento(e: EstadoAsistente, doc: DocumentoDetectado): Promise<Salida> {
    if (e.paso === 'inicio' || e.paso === 'listo') this.iniciar(e);

    if (!doc.nombre || !doc.numero || doc.observacion) {
      e.paso = 'documento';
      const leido = [doc.nombre && `Nombre: ${doc.nombre}`, doc.numero && `Número: ${doc.numero}`].filter(Boolean);
      return this.decir(
        '🤔 No pude leer bien el documento' +
          (doc.observacion ? ` (${doc.observacion})` : '') +
          '.' +
          (leido.length ? `\nAlcancé a leer:\n${leido.join('\n')}` : '') +
          `\n\nEnvía otra foto más nítida o escribe el nombre completo y el número. Ej.: ${EJEMPLO_DOCUMENTO}`,
      );
    }

    e.documento = { ...doc, tipo: doc.tipo ?? 'CC' };
    e.paso = 'confirmar_documento';
    return { mensajes: [this.mensajeConfirmarDocumento(e)] };
  }

  async recibirTexto(e: EstadoAsistente, texto: string): Promise<Salida> {
    switch (e.paso) {
      case 'inicio':
      case 'listo':
      case 'documento':
      case 'confirmar_documento': {
        const doc = interpretarDocumentoEscrito(texto);
        if (doc.nombre && doc.numero) {
          if (e.paso === 'inicio' || e.paso === 'listo') this.iniciar(e);
          return this.confirmarDocumento(e, { tipo: 'CC', ...doc });
        }
        if (e.paso === 'inicio' || e.paso === 'listo') return this.iniciar(e);
        return this.decir(
          `No entendí el nombre y número del documento. Escríbelos así: ${EJEMPLO_DOCUMENTO}\nO envía una foto de la cédula 📷`,
        );
      }
      case 'propuesta':
      case 'resumen':
      case 'corregir':
        return { mensajes: [{ texto: 'Usa los botones para continuar 👇' }, ...this.repetir(e).mensajes] };
      default: {
        const campo = e.paso;
        const valor = PREGUNTAS[campo].interpretar(texto, this.hoy());
        if (valor === null || valor === undefined || valor === '') {
          return { mensajes: [{ texto: `No entendí ese valor. ${PREGUNTAS[campo].ayuda}` }] };
        }
        return this.aplicar(e, campo, valor);
      }
    }
  }

  /** `data` tiene la forma "<paso>:<acción>", tal como se generó en los botones. */
  async recibirBoton(e: EstadoAsistente, data: string): Promise<Salida> {
    const [paso, accion = ''] = data.split(':');
    if (paso !== e.paso) return { mensajes: [], obsoleto: true };

    switch (e.paso) {
      case 'confirmar_documento':
        if (accion === 'ok' && e.documento) return this.confirmarDocumento(e, e.documento);
        e.paso = 'documento';
        return this.decir(`Escribe el nombre completo y el número del documento. Ej.: ${EJEMPLO_DOCUMENTO}`);

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
          return { mensajes: [{ texto: '⏳ Generando el contrato…' }], generar: e.datos };
        }
        if (accion === 'corregir') return { mensajes: [this.mensajeCorregir(e)] };
        Object.assign(e, estadoInicial());
        return this.decir('❌ Contrato cancelado. Envía otra foto de cédula cuando quieras empezar uno nuevo.');

      case 'corregir':
        e.volverAResumen = true;
        if (accion === 'volver') return this.resumen(e);
        if (accion === 'documento') {
          e.paso = 'documento';
          return this.decir(`📷 Envía otra foto de la cédula o escribe el nombre y número. Ej.: ${EJEMPLO_DOCUMENTO}`);
        }
        return esCampoPreguntado(accion) ? this.preguntar(e, accion) : this.resumen(e);

      default: {
        if (!esCampoPreguntado(e.paso)) return { mensajes: [], obsoleto: true };
        const campo = e.paso;
        if (accion === 'otro') return this.decir(PREGUNTAS[campo].ayuda);
        const i = Number(accion.slice(1));
        if (!accion.startsWith('v') || !(i in e.ofertas)) return { mensajes: [], obsoleto: true };
        return this.aplicar(e, campo, e.ofertas[i]);
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
      return this.decir(`⚠️ ${problemas.join(' ')}\nEscribe el nombre y número correctos. Ej.: ${EJEMPLO_DOCUMENTO}`);
    }
    Object.assign(e.datos, guardados);
    e.documento = undefined;

    const yaConocido = this.catalogo.arrendatario(guardados.arrendatario_numero_documento!);
    const saludo: Mensaje[] = yaConocido
      ? [{ texto: `👋 ${guardados.arrendatario_nombre} ya tuvo un contrato antes; te sugiero sus datos anteriores.` }]
      : [];

    // Si es una corrección o el contrato ya está avanzado, sigue donde iba.
    if (e.volverAResumen || e.datos.inmueble_direccion) return this.con(saludo, this.avanzar(e));

    const propuesta = this.proponer(e);
    if (!propuesta) return this.con(saludo, this.avanzar(e));
    e.propuesta = propuesta;
    e.paso = 'propuesta';
    return this.con(saludo, { mensajes: [this.mensajePropuesta(propuesta)] });
  }

  /** Sugerencia completa con lo usado antes. Solo si hay al menos inmueble y precio para sugerir. */
  private proponer(e: EstadoAsistente): Partial<DatosContrato> | undefined {
    const anterior = this.catalogo.arrendatario(e.datos.arrendatario_numero_documento!);
    const direccion = anterior?.ultimoInmueble ?? this.catalogo.inmuebles(1)[0];
    if (!direccion) return undefined;
    const inmueble = this.catalogo.inmueble(direccion);
    const precio = inmueble?.ultimoPrecio ?? this.catalogo.precios(direccion, 1)[0];
    if (!precio) return undefined;

    const p: Partial<DatosContrato> = {
      inmueble_direccion: inmueble?.direccion ?? direccion,
      precio_mensual: precio,
      deposito: inmueble?.ultimoDeposito,
      duracion_meses: this.catalogo.duraciones(1)[0] ?? 6,
      fecha_inicio: primeroDelMesSiguiente(this.hoy()),
    };
    if (anterior) {
      Object.assign(p, {
        numero_ocupantes: anterior.ocupantes,
        arrendatario_celular: anterior.celular,
        arrendatario_correo: anterior.correo,
        arrendatario_direccion: anterior.direccion,
      });
    }
    // Quita lo que no se pudo sugerir para que se pregunte después.
    for (const k of Object.keys(p) as (keyof DatosContrato)[]) if (p[k] === undefined) delete p[k];
    return p;
  }

  private async aplicar(e: EstadoAsistente, campo: CampoPreguntado, valor: unknown): Promise<Salida> {
    const { guardados, errores } = validarParcial({ [campo]: valor });
    if (errores[campo]) return this.con([{ texto: `⚠️ ${errores[campo]}` }], this.preguntar(e, campo));

    const extra: Mensaje[] = [];
    if (campo === 'inmueble_direccion') {
      const nueva = guardados.inmueble_direccion!;
      // Si la notificación iba "a la del inmueble", que siga al inmueble nuevo.
      if (e.datos.arrendatario_direccion && e.datos.arrendatario_direccion === e.datos.inmueble_direccion) {
        e.datos.arrendatario_direccion = nueva;
      }
      if (await this.catalogo.agregarInmueble(nueva)) extra.push({ texto: '💾 Guardé esta dirección para la próxima vez.' });
    }
    Object.assign(e.datos, guardados);
    return this.con(extra, this.avanzar(e));
  }

  private avanzar(e: EstadoAsistente): Salida {
    if (e.volverAResumen) return this.resumen(e);
    const siguiente = ORDEN.find((c) => e.datos[c] === undefined);
    return siguiente ? this.preguntar(e, siguiente) : this.resumen(e);
  }

  private preguntar(e: EstadoAsistente, campo: CampoPreguntado): Salida {
    const p = PREGUNTAS[campo];
    const opciones = p.opciones({ datos: e.datos, catalogo: this.catalogo, hoy: this.hoy() });
    e.paso = campo;
    e.ofertas = opciones.map((o) => o.valor);

    const filas: Boton[][] = [];
    opciones.forEach((o, i) => {
      if (i % p.porFila === 0) filas.push([]);
      filas.at(-1)!.push({ texto: o.etiqueta, data: `${campo}:v${i}` });
    });
    // Sin valores guardados todavía (primera vez): se pide escribirlo directamente.
    const haySugerencias = opciones.some((o) => o.valor !== '' && o.valor !== 0);
    if (haySugerencias) filas.push([{ texto: p.otro, data: `${campo}:otro` }]);
    return {
      mensajes: [
        {
          texto: haySugerencias ? p.pregunta : `${p.pregunta}\n${p.ayuda}`,
          botones: filas.length ? filas : undefined,
        },
      ],
    };
  }

  private resumen(e: EstadoAsistente): Salida {
    const faltante = ORDEN.find((c) => e.datos[c] === undefined);
    if (faltante) {
      e.volverAResumen = false;
      return this.preguntar(e, faltante);
    }
    e.paso = 'resumen';
    e.volverAResumen = false;
    return {
      mensajes: [
        {
          texto: `📄 Resumen del contrato\n\n${this.describir(e.datos)}\n\n¿Genero el contrato?`,
          botones: [
            [{ texto: '✅ Generar contrato', data: 'resumen:generar' }],
            [
              { texto: '✏️ Corregir', data: 'resumen:corregir' },
              { texto: '❌ Cancelar', data: 'resumen:cancelar' },
            ],
          ],
        },
      ],
    };
  }

  private describir(d: Partial<DatosContrato>): string {
    const lineas = [
      d.arrendatario_nombre && `👤 ${d.arrendatario_nombre} · ${documento(d.arrendatario_tipo_documento!, d.arrendatario_numero_documento!)}`,
      d.inmueble_direccion && `🏠 ${d.inmueble_direccion}`,
      d.precio_mensual && `💰 Precio: ${pesos(d.precio_mensual)} mensuales`,
      d.deposito !== undefined && `🔐 Canon (depósito): ${d.deposito ? pesos(d.deposito) : 'sin canon'}`,
      d.duracion_meses && `📅 Duración: ${meses(d.duracion_meses)}`,
      d.fecha_inicio && `🗓️ Inicia: ${fechaALetras(d.fecha_inicio)}`,
      d.numero_ocupantes && `👥 Ocupantes: ${personas(d.numero_ocupantes)}`,
      d.arrendatario_celular !== undefined && `📱 Celular: ${d.arrendatario_celular || '(en blanco)'}`,
      d.arrendatario_correo !== undefined && `✉️ Correo: ${d.arrendatario_correo || '(en blanco)'}`,
      d.arrendatario_direccion && `📬 Notificaciones: ${d.arrendatario_direccion}`,
    ];
    return lineas.filter(Boolean).join('\n');
  }

  private mensajeConfirmarDocumento(e: EstadoAsistente): Mensaje {
    const d = e.documento!;
    return {
      texto: `🪪 Leí este documento:\n\n${d.nombre}\n${TIPOS_DOCUMENTO[d.tipo ?? 'CC']}: ${documento(d.tipo ?? 'CC', d.numero!.replace(/[.\s-]/g, ''))}\n\n¿Está correcto? Revisa bien el número.`,
      botones: [
        [
          { texto: '✅ Sí, continuar', data: 'confirmar_documento:ok' },
          { texto: '✏️ Corregir', data: 'confirmar_documento:editar' },
        ],
      ],
    };
  }

  private mensajePropuesta(p: Partial<DatosContrato>): Mensaje {
    return {
      texto: `💡 Te sugiero esto según contratos anteriores:\n\n${this.describir(p)}\n\n¿Lo usamos?`,
      botones: [
        [{ texto: '✅ Usar sugerencia', data: 'propuesta:ok' }],
        [{ texto: '✏️ Elegir paso a paso', data: 'propuesta:paso' }],
      ],
    };
  }

  private mensajeCorregir(e: EstadoAsistente): Mensaje {
    e.paso = 'corregir';
    const filas: Boton[][] = [[{ texto: '🪪 Arrendatario', data: 'corregir:documento' }]];
    for (let i = 0; i < ORDEN.length; i += 2) {
      filas.push(ORDEN.slice(i, i + 2).map((c) => ({ texto: ETIQUETAS[c], data: `corregir:${c}` })));
    }
    filas.push([{ texto: '↩️ Volver al resumen', data: 'corregir:volver' }]);
    return { texto: '¿Qué quieres corregir?', botones: filas };
  }

  private repetir(e: EstadoAsistente): Salida {
    if (e.paso === 'propuesta' && e.propuesta) return { mensajes: [this.mensajePropuesta(e.propuesta)] };
    if (e.paso === 'corregir') return { mensajes: [this.mensajeCorregir(e)] };
    return this.resumen(e);
  }

  private decir(texto: string): Salida {
    return { mensajes: [{ texto }] };
  }

  private con(antes: Mensaje[], salida: Salida): Salida {
    return { ...salida, mensajes: [...antes, ...salida.mensajes] };
  }
}
