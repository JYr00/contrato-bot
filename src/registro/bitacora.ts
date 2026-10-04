import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { InputFile, type Context, type MiddlewareFn, type Transformer } from 'grammy';

import type { ContextoExtraccion, DatosExtraidos, DocumentoDetectado, Extractor } from '../flujo/asistente.js';
import type { TipoImagen } from '../ia/lector-documento.js';

/**
 * Bitácora de interacciones: una línea JSON por evento en data/logs/interacciones/AAAA-MM-DD.jsonl (fecha de
 * Bogotá). Guarda lo necesario para reconstruir cada conversación más adelante:
 *
 * - "actualizacion": la actualización de Telegram tal como llegó (texto, botón tocado, comando, foto…).
 * - "salida":        cada llamada del bot a Telegram (método, texto, botones; archivos solo por nombre) y el
 *                    message_id que devolvió Telegram, para enlazar ediciones y botones posteriores.
 * - "ia":            lo que respondió Claude (lector de cédula, intérprete de mensajes), con su duración.
 * - "estado":        el estado de la conversación después de procesar cada actualización.
 * - "error" y "arranque".
 *
 * Contiene datos personales (nombres, cédulas, contratos): queda solo en local, dentro de data/.
 */

export const VERSION_BITACORA = 1;

export type Evento =
  | { tipo: 'arranque'; modelo: string; usuarios: number }
  | { tipo: 'actualizacion'; update: unknown }
  | { tipo: 'salida'; metodo: string; payload: unknown; resultado?: unknown; error?: string; ms: number }
  | { tipo: 'ia'; servicio: 'lector' | 'extractor'; entrada?: unknown; resultado?: unknown; error?: string; ms: number }
  | ({ tipo: 'estado'; ms: number } & EstadoConversacion)
  | { tipo: 'error'; mensaje: string; pila?: string };

/** Estado de la conversación que se guarda después de cada actualización. */
export interface EstadoConversacion {
  paso: string;
  datos: unknown;
  inventario: unknown;
  tarjetaId?: number;
}

/** Contexto de la actualización en curso: se adjunta solo a todo lo que se registra mientras se procesa. */
export interface ContextoBitacora {
  update_id: number;
  chat?: number;
  usuario?: number;
}

/** Métodos de Telegram que no aportan para reconstruir el flujo. */
const METODOS_OMITIDOS = new Set(['getUpdates', 'sendChatAction', 'getMe', 'setMyCommands', 'deleteWebhook', 'getFile']);

export class Bitacora {
  private readonly contexto = new AsyncLocalStorage<ContextoBitacora>();
  private cola: Promise<void> = Promise.resolve();

  constructor(
    private readonly carpeta: string,
    private readonly zonaHoraria = 'America/Bogota',
    private readonly reloj = () => new Date(),
  ) {}

  /** Ejecuta `fn` con el contexto de una actualización (update_id, chat y usuario se agregan a cada evento). */
  conContexto<T>(ctx: ContextoBitacora, fn: () => Promise<T>): Promise<T> {
    return this.contexto.run(ctx, fn);
  }

  /** Agrega el evento al archivo del día. Nunca falla: un problema con el log no debe tumbar el bot. */
  registrar(evento: Evento): Promise<void> {
    const ahora = this.reloj();
    const linea = JSON.stringify({ v: VERSION_BITACORA, ts: ahora.toISOString(), ...this.contexto.getStore(), ...evento });
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: this.zonaHoraria }).format(ahora);
    // En cola para que las líneas no se mezclen ni cambien de orden.
    this.cola = this.cola
      .then(async () => {
        await mkdir(this.carpeta, { recursive: true });
        await appendFile(join(this.carpeta, `${dia}.jsonl`), `${linea}\n`);
      })
      .catch((err) => console.error('[bitácora] No se pudo escribir:', (err as Error).message));
    return this.cola;
  }

  /** Espera a que se escriba todo lo pendiente (p. ej. antes de cerrar el bot o en pruebas). */
  vaciar(): Promise<void> {
    return this.cola;
  }

  /**
   * Middleware de grammY (va primero): registra cada actualización tal como llega, los errores y, al terminar,
   * el estado de la conversación (`estado` devuelve null para no registrarlo, p. ej. si no está autorizado).
   * Todo lo que se registre mientras tanto (salidas, IA) lleva el update_id, chat y usuario.
   */
  middleware(estado: (ctx: Context) => Promise<EstadoConversacion | null>): MiddlewareFn<Context> {
    return (ctx, next) =>
      this.conContexto({ update_id: ctx.update.update_id, chat: ctx.chat?.id, usuario: ctx.from?.id }, async () => {
        const inicio = Date.now();
        void this.registrar({ tipo: 'actualizacion', update: ctx.update });
        try {
          await next();
        } catch (err) {
          void this.registrar({ tipo: 'error', mensaje: (err as Error)?.message ?? String(err), pila: (err as Error)?.stack });
          throw err;
        } finally {
          const e = await estado(ctx).catch(() => null);
          if (e) void this.registrar({ tipo: 'estado', ...e, ms: Date.now() - inicio });
        }
      });
  }

  /**
   * Transformador de la API de grammY: registra cada llamada del bot a Telegram (salvo las de METODOS_OMITIDOS)
   * con su resultado. Se instala con `bot.api.config.use(bitacora.transformador())`.
   */
  transformador(): Transformer {
    return async (prev, metodo, payload, signal) => {
      if (METODOS_OMITIDOS.has(metodo)) return prev(metodo, payload, signal);
      const inicio = Date.now();
      try {
        const respuesta = await prev(metodo, payload, signal);
        void this.registrar({
          tipo: 'salida',
          metodo,
          payload: limpiar(payload),
          ...(respuesta.ok ? { resultado: resumirResultado(respuesta.result) } : { error: respuesta.description }),
          ms: Date.now() - inicio,
        });
        return respuesta;
      } catch (err) {
        void this.registrar({ tipo: 'salida', metodo, payload: limpiar(payload), error: (err as Error).message, ms: Date.now() - inicio });
        throw err;
      }
    };
  }
}

/** Copia del payload apta para JSON: los archivos quedan solo con su nombre (sin el contenido). */
export function limpiar(valor: unknown): unknown {
  if (valor instanceof InputFile) return { archivo: valor.filename ?? null };
  if (Buffer.isBuffer(valor)) return { bytes: valor.length };
  if (Array.isArray(valor)) return valor.map(limpiar);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, limpiar(v)]));
  }
  return valor;
}

/** De la respuesta de Telegram basta el message_id (o el valor simple, p. ej. true). */
function resumirResultado(resultado: unknown): unknown {
  if (resultado && typeof resultado === 'object' && 'message_id' in resultado) {
    return { message_id: (resultado as { message_id: number }).message_id };
  }
  return resultado;
}

const error = (err: unknown) => (err as Error)?.message ?? String(err);

/** Envuelve el lector de cédulas para registrar lo que leyó Claude (la imagen no se guarda, solo su tamaño). */
export function lectorConBitacora<L extends { leer(imagen: Buffer, tipo: TipoImagen): Promise<DocumentoDetectado> }>(
  lector: L,
  bitacora: Bitacora,
) {
  return {
    async leer(imagen: Buffer, tipo: TipoImagen): Promise<DocumentoDetectado> {
      const inicio = Date.now();
      const entrada = { tipo, bytes: imagen.length };
      try {
        const resultado = await lector.leer(imagen, tipo);
        void bitacora.registrar({ tipo: 'ia', servicio: 'lector', entrada, resultado, ms: Date.now() - inicio });
        return resultado;
      } catch (err) {
        void bitacora.registrar({ tipo: 'ia', servicio: 'lector', entrada, error: error(err), ms: Date.now() - inicio });
        throw err;
      }
    },
  };
}

/** Envuelve el intérprete de mensajes libres para registrar qué datos entendió Claude. */
export function extractorConBitacora(extractor: Extractor, bitacora: Bitacora): Extractor {
  return {
    async extraer(texto: string, contexto: ContextoExtraccion): Promise<DatosExtraidos> {
      const inicio = Date.now();
      const entrada = { texto, contexto };
      try {
        const resultado = await extractor.extraer(texto, contexto);
        void bitacora.registrar({ tipo: 'ia', servicio: 'extractor', entrada, resultado, ms: Date.now() - inicio });
        return resultado;
      } catch (err) {
        void bitacora.registrar({ tipo: 'ia', servicio: 'extractor', entrada, error: error(err), ms: Date.now() - inicio });
        throw err;
      }
    },
  };
}
