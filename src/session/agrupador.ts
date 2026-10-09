/**
 * Junta los mensajes de texto que llegan seguidos al mismo chat y los entrega como uno solo.
 *
 * Es común pegar una conversación o escribir un dato por mensaje ("Brayan Munar", "cédula 1019141472",
 * "paga 600 mil"…). Procesados uno por uno, cada mensaje se interpreta sin los demás y los datos se cruzan;
 * juntos, se interpretan completos. Se espera `esperaMs` desde el último mensaje antes de procesar.
 *
 * grammY procesa una actualización a la vez, así que la espera no puede hacerse dentro del manejador (bloquearía
 * los mensajes que se quieren juntar): el texto se guarda y se procesa con un temporizador. Todo lo que toque la
 * sesión de un chat pasa por `enCola`, para que nunca corran dos cosas a la vez sobre la misma sesión.
 */
export class AgrupadorMensajes<C> {
  private readonly pendientes = new Map<number, { textos: string[]; ctx: C; temporizador: ReturnType<typeof setTimeout> }>();
  private readonly colas = new Map<number, Promise<void>>();

  constructor(
    private readonly esperaMs: number,
    /** Procesa el texto completo; `ctx` es el del último mensaje. Debe manejar sus propios errores. */
    private readonly procesar: (chatId: number, texto: string, ctx: C) => Promise<void>,
  ) {}

  /** Guarda el mensaje y reinicia la espera de ese chat. */
  agregar(chatId: number, texto: string, ctx: C): void {
    const previo = this.pendientes.get(chatId);
    if (previo) clearTimeout(previo.temporizador);
    const temporizador = setTimeout(() => void this.vaciar(chatId), this.esperaMs);
    this.pendientes.set(chatId, { textos: [...(previo?.textos ?? []), texto], ctx, temporizador });
  }

  hayPendiente(chatId: number): boolean {
    return this.pendientes.has(chatId);
  }

  /**
   * Procesa ya lo pendiente del chat (p. ej. antes de un botón, una foto o un comando, para respetar el orden)
   * y espera a que termine todo lo que esté en curso para ese chat.
   */
  vaciar(chatId: number): Promise<void> {
    const p = this.pendientes.get(chatId);
    if (!p) return this.colas.get(chatId) ?? Promise.resolve();
    clearTimeout(p.temporizador);
    this.pendientes.delete(chatId);
    return this.enCola(chatId, () => this.procesar(chatId, p.textos.join('\n'), p.ctx));
  }

  /** Corre `fn` cuando termine lo que ya esté en curso para ese chat. */
  enCola(chatId: number, fn: () => Promise<void>): Promise<void> {
    const siguiente = (this.colas.get(chatId) ?? Promise.resolve()).then(fn).catch((err) => {
      console.error(`[agrupador] Error procesando el chat ${chatId}:`, err);
    });
    this.colas.set(chatId, siguiente);
    void siguiente.finally(() => {
      if (this.colas.get(chatId) === siguiente) this.colas.delete(chatId);
    });
    return siguiente;
  }
}
