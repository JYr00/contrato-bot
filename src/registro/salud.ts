/**
 * Salud del bot mientras corre: lleva la cuenta de las fallas de la IA y de los contratos rechazados, y avisa
 * por Telegram al administrador cuando algo anda mal. Así no vuelve a pasar que la IA falle por días sin que
 * nadie se entere. Los avisos de un mismo tipo se espacian (`pausaMs`) para no llenar el chat.
 */
export class Salud {
  readonly arranque: number;
  private fallasSeguidasIA = 0;
  ultimoErrorIA?: { cuando: number; mensaje: string };
  ultimoExitoIA?: number;
  /** Contratos que no pasaron la verificación desde que arrancó el bot. */
  rechazados = 0;
  private readonly ultimoAviso = new Map<string, number>();

  constructor(
    private readonly avisar: (texto: string) => Promise<unknown>,
    private readonly umbralIA = 3,
    private readonly pausaMs = 30 * 60 * 1000,
    private readonly reloj = Date.now,
  ) {
    this.arranque = reloj();
  }

  /** La IA respondió. Si venía fallando, se avisa que volvió. */
  exitoIA(): void {
    if (this.fallasSeguidasIA >= this.umbralIA) void this.aviso('ia-ok', '✅ La IA volvió a responder.', 0);
    this.fallasSeguidasIA = 0;
    this.ultimoExitoIA = this.reloj();
  }

  /** La IA falló. Al llegar a `umbralIA` fallas seguidas, se avisa. */
  falloIA(err: unknown): void {
    const mensaje = String((err as Error)?.message ?? err).slice(0, 200);
    this.fallasSeguidasIA++;
    this.ultimoErrorIA = { cuando: this.reloj(), mensaje };
    if (this.fallasSeguidasIA === this.umbralIA) {
      void this.aviso(
        'ia',
        `⚠️ La IA falló ${this.umbralIA} veces seguidas.\n${mensaje}\n\n` +
          'Mientras tanto el bot no lee fotos ni mensajes largos. Revisa ANTHROPIC_API_KEY y la conexión; /estado muestra si ya responde.',
      );
    }
  }

  get iaFallando(): boolean {
    return this.fallasSeguidasIA > 0;
  }

  /** Un contrato no pasó la verificación: se avisa siempre (son raros y siempre importan). */
  contratoRechazado(detalle: string): void {
    this.rechazados++;
    void this.aviso('rechazo', `🚫 Un contrato no pasó la verificación y no se envió.\n${detalle}\n\nEl detalle está en la bitácora.`, 0);
  }

  /** Error inesperado (p. ej. al generar un contrato). */
  error(donde: string, err: unknown): void {
    void this.aviso('error', `⚠️ Error en el bot (${donde}): ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }

  private async aviso(clave: string, texto: string, pausaMs = this.pausaMs): Promise<void> {
    const ahora = this.reloj();
    const ultimo = this.ultimoAviso.get(clave);
    if (ultimo !== undefined && ahora - ultimo < pausaMs) return;
    this.ultimoAviso.set(clave, ahora);
    try {
      await this.avisar(texto);
    } catch (err) {
      console.error('[salud] No se pudo enviar el aviso:', err);
    }
  }
}

/** Envuelve una llamada a la IA para que la salud sepa si responde. */
export function vigilarIA<A extends unknown[], R>(fn: (...args: A) => Promise<R>, salud: Salud): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      const r = await fn(...args);
      salud.exitoIA();
      return r;
    } catch (err) {
      salud.falloIA(err);
      throw err;
    }
  };
}
