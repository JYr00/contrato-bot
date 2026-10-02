import type { EstadoAsistente } from '../flujo/asistente.js';
import { estadoInicial } from '../flujo/asistente.js';

export interface Session {
  chatId: number;
  estado: EstadoAsistente;
  actualizado: number;
}

/** Puerto de persistencia: hoy en memoria, mañana Redis o PostgreSQL sin tocar el asistente. */
export interface SessionStore {
  get(chatId: number): Promise<Session>;
  save(session: Session): Promise<void>;
  reset(chatId: number): Promise<Session>;
}

export function nuevaSesion(chatId: number): Session {
  return { chatId, estado: estadoInicial(), actualizado: Date.now() };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sesiones = new Map<number, Session>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

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
