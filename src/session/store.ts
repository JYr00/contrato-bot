import type Anthropic from '@anthropic-ai/sdk';

import type { DatosContrato } from '../contract/schema.js';

export interface Session {
  chatId: number;
  consentimiento: boolean;
  datos: Partial<DatosContrato>;
  messages: Anthropic.MessageParam[];
  contratosGenerados: number;
  actualizado: number;
}

/** Puerto de persistencia: hoy en memoria, mañana Redis o PostgreSQL sin tocar el agente. */
export interface SessionStore {
  get(chatId: number): Promise<Session>;
  save(session: Session): Promise<void>;
  reset(chatId: number, conservarConsentimiento?: boolean): Promise<Session>;
}

export function nuevaSesion(chatId: number, datos: Partial<DatosContrato> = {}): Session {
  return { chatId, consentimiento: false, datos, messages: [], contratosGenerados: 0, actualizado: Date.now() };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sesiones = new Map<number, Session>();

  constructor(
    private readonly valoresPorDefecto: Partial<DatosContrato> = {},
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  async get(chatId: number): Promise<Session> {
    const s = this.sesiones.get(chatId);
    if (s && Date.now() - s.actualizado < this.ttlMs) return s;
    const nueva = nuevaSesion(chatId, { ...this.valoresPorDefecto });
    this.sesiones.set(chatId, nueva);
    return nueva;
  }

  async save(session: Session): Promise<void> {
    session.actualizado = Date.now();
    this.sesiones.set(session.chatId, session);
  }

  async reset(chatId: number, conservarConsentimiento = true): Promise<Session> {
    const anterior = this.sesiones.get(chatId);
    const nueva = nuevaSesion(chatId, { ...this.valoresPorDefecto });
    nueva.consentimiento = conservarConsentimiento && !!anterior?.consentimiento;
    this.sesiones.set(chatId, nueva);
    return nueva;
  }
}
