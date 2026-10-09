import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EstadoAsistente } from '../flujo/asistente.js';
import { estadoInicial } from '../flujo/asistente.js';
import type { EstadoInventario } from '../flujo/inventario.js';

export interface Session {
  chatId: number;
  estado: EstadoAsistente;
  /** Mensaje de Telegram con la tarjeta del contrato en curso (se edita en cada paso). */
  tarjetaId?: number;
  /** Informe de inmuebles: si se espera que escriba un apartamento o un edificio. */
  inventario: EstadoInventario;
  actualizado: number;
}

/** Puerto de persistencia: hoy en memoria, mañana Redis o PostgreSQL sin tocar el asistente. */
export interface SessionStore {
  get(chatId: number): Promise<Session>;
  save(session: Session): Promise<void>;
  reset(chatId: number): Promise<Session>;
}

export function nuevaSesion(chatId: number): Session {
  return { chatId, estado: estadoInicial(), inventario: {}, actualizado: Date.now() };
}

export class InMemorySessionStore implements SessionStore {
  protected readonly sesiones = new Map<number, Session>();

  constructor(protected readonly ttlMs = 24 * 60 * 60 * 1000) {}

  async get(chatId: number): Promise<Session> {
    const s = this.sesiones.get(chatId);
    if (s && Date.now() - s.actualizado < this.ttlMs) return s;
    return this.reset(chatId);
  }

  async save(session: Session): Promise<void> {
    session.actualizado = Date.now();
    this.sesiones.set(session.chatId, session);
  }

  async reset(chatId: number): Promise<Session> {
    const nueva = nuevaSesion(chatId);
    this.sesiones.set(chatId, nueva);
    return nueva;
  }
}

/**
 * Sesiones guardadas en un archivo JSON (data/sesiones.json): un reinicio del bot (actualización, corte de luz,
 * recarga de `npm run dev`) no hace perder el contrato que alguien estaba armando.
 */
export class ArchivoSessionStore extends InMemorySessionStore {
  private escritura: Promise<void> = Promise.resolve();

  private constructor(
    private readonly ruta: string,
    ttlMs?: number,
  ) {
    super(ttlMs);
  }

  /** Abre el archivo (si no existe, empieza vacío). Las sesiones vencidas se descartan al leerlas. */
  static async abrir(ruta: string, ttlMs?: number): Promise<ArchivoSessionStore> {
    const store = new ArchivoSessionStore(ruta, ttlMs);
    try {
      const guardadas = JSON.parse(await readFile(ruta, 'utf8')) as Session[];
      for (const s of guardadas) {
        // Campos agregados después de guardarse la sesión quedan con su valor inicial.
        if (Date.now() - s.actualizado < store.ttlMs) store.sesiones.set(s.chatId, { ...s, estado: { ...estadoInicial(), ...s.estado } });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[sesiones] No se pudieron leer:', err);
    }
    return store;
  }

  override async save(session: Session): Promise<void> {
    await super.save(session);
    await this.guardar();
  }

  override async reset(chatId: number): Promise<Session> {
    const nueva = await super.reset(chatId);
    await this.guardar();
    return nueva;
  }

  /** Escrituras en fila y atómicas (archivo temporal + rename): nunca queda un JSON a medias. */
  private guardar(): Promise<void> {
    const contenido = JSON.stringify([...this.sesiones.values()]);
    this.escritura = this.escritura.then(async () => {
      try {
        await mkdir(dirname(this.ruta), { recursive: true });
        await writeFile(`${this.ruta}.tmp`, contenido);
        await rename(`${this.ruta}.tmp`, this.ruta);
      } catch (err) {
        console.error('[sesiones] No se pudieron guardar:', err);
      }
    });
    return this.escritura;
  }
}
