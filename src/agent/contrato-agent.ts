import Anthropic from '@anthropic-ai/sdk';

import type { ContratoGenerado, ContractRenderer } from '../contract/render.js';
import { camposFaltantes, estaCompleto, validarParcial } from '../contract/schema.js';
import type { Session } from '../session/store.js';
import { HERRAMIENTAS, construirSystemPrompt } from './prompt.js';

const MAX_ITERACIONES = 6;

export interface RespuestaAgente {
  texto: string;
  contrato?: ContratoGenerado;
}

interface ResultadoHerramienta {
  contenido: unknown;
  esError?: boolean;
}

export class ContratoAgent {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly renderer: ContractRenderer,
    private readonly zonaHoraria = 'America/Bogota',
  ) {}

  async responder(session: Session, mensajeUsuario: string): Promise<RespuestaAgente> {
    const puntoDeRestauracion = session.messages.length;
    session.messages.push({ role: 'user', content: mensajeUsuario });
    let contrato: ContratoGenerado | undefined;

    try {
      for (let i = 0; i < MAX_ITERACIONES; i++) {
        const respuesta = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: construirSystemPrompt(session.datos, this.hoy()),
          tools: HERRAMIENTAS,
          messages: session.messages,
        });
        session.messages.push({ role: 'assistant', content: respuesta.content });

        if (respuesta.stop_reason !== 'tool_use') {
          const texto = respuesta.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          return { texto, contrato };
        }

        const resultados: Anthropic.ToolResultBlockParam[] = [];
        for (const bloque of respuesta.content) {
          if (bloque.type !== 'tool_use') continue;
          const r = await this.ejecutar(session, bloque.name, bloque.input as Record<string, unknown>);
          if (r.contrato) contrato = r.contrato;
          resultados.push({
            type: 'tool_result',
            tool_use_id: bloque.id,
            content: JSON.stringify(r.contenido),
            is_error: r.esError ?? false,
          });
        }
        session.messages.push({ role: 'user', content: resultados });
      }
      return { texto: 'Se me complicó procesar eso. ¿Me lo puedes repetir?', contrato };
    } catch (err) {
      // Deja el historial consistente (sin tool_use huérfanos) para que el siguiente mensaje funcione.
      session.messages.length = puntoDeRestauracion;
      throw err;
    }
  }

  private async ejecutar(
    session: Session,
    nombre: string,
    input: Record<string, unknown>,
  ): Promise<ResultadoHerramienta & { contrato?: ContratoGenerado }> {
    switch (nombre) {
      case 'registrar_datos': {
        const { guardados, errores, ignorados } = validarParcial(input);
        Object.assign(session.datos, guardados);
        return {
          contenido: { guardados, errores, ignorados, faltan: camposFaltantes(session.datos) },
          esError: Object.keys(guardados).length === 0 && Object.keys(errores).length > 0,
        };
      }
      case 'generar_contrato': {
        if (input.confirmado !== true) {
          return { contenido: 'Primero muestra el resumen y obtén la confirmación del usuario.', esError: true };
        }
        if (!estaCompleto(session.datos)) {
          return { contenido: { error: 'Faltan datos', faltan: camposFaltantes(session.datos) }, esError: true };
        }
        const contrato = await this.renderer.generar(session.datos);
        session.contratosGenerados++;
        return {
          contenido: {
            ok: true,
            archivos: [`${contrato.nombreBase}.docx`, contrato.pdf ? `${contrato.nombreBase}.pdf` : null].filter(Boolean),
            nota: 'Los archivos se envían automáticamente después de tu mensaje. Recuérdale que debe imprimirlo y firmarlo con el arrendador.',
          },
          contrato,
        };
      }
      default:
        return { contenido: `Herramienta desconocida: ${nombre}`, esError: true };
    }
  }

  private hoy(): string {
    const ahora = new Date();
    const largo = new Intl.DateTimeFormat('es-CO', {
      timeZone: this.zonaHoraria,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(ahora);
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: this.zonaHoraria }).format(ahora);
    return `${largo} (${iso})`;
  }
}
