import { fechaALetras } from '../contract/numero-a-letras.js';
import { validarParcial, type DatosContrato } from '../contract/schema.js';
import type { Catalogo, ContratoGuardado } from '../datos/catalogo.js';
import { describir, type Boton, type Mensaje } from './asistente.js';
import { componerDireccion, fechaFin, interpretarUnidad, separarUnidad } from './interpretar.js';

/**
 * Informe de inmuebles (/inmuebles, /libres): edificios, apartamentos y si están ocupados, con botones.
 * Los botones llevan índices sobre listas en orden estable (alfabético y natural), con el prefijo "inv:".
 */

export type TipoEstado = 'ocupado' | 'por_vencer' | 'reservado' | 'libre';

export interface EstadoInmueble {
  tipo: TipoEstado;
  /** Contrato vigente (ocupado / por vencer) o el que va a empezar (reservado). */
  contrato?: DatosContrato;
  fin?: string;
  /** Días que faltan para el fin (vigente) o para el inicio (reservado). */
  dias?: number;
  /** Contrato que empieza después del vigente (ya renovado). */
  siguiente?: DatosContrato;
  /** Último contrato terminado. */
  anterior?: DatosContrato;
}

/** Lo que el adaptador debe hacer además de mostrar el mensaje. */
export type Accion =
  | { tipo: 'reenviar'; datos: DatosContrato }
  | { tipo: 'renovar'; datos: DatosContrato }
  | { tipo: 'nuevo'; direccion: string };

export interface RespuestaInventario {
  mensaje: Mensaje;
  accion?: Accion;
}

/** Texto pendiente de escribir (agregar o corregir en ⚙️ Ajustes). Vive en la sesión. */
export interface EstadoInventario {
  esperando?: 'apartamentos' | 'edificio' | 'direccion_edificio' | 'numero_apartamento';
  edificio?: number;
  unidad?: number;
}

const DIAS_POR_VENCER = 30;
const EMOJI: Record<TipoEstado, string> = { ocupado: '🔴', por_vencer: '🟡', reservado: '🔵', libre: '🟢' };

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (iso: string) => {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES_CORTOS[m! - 1]} ${a}`;
};
const diasEntre = (desde: string, hasta: string) => {
  const t = (iso: string) => {
    const [a, m, d] = iso.split('-').map(Number);
    return Date.UTC(a!, m! - 1, d!);
  };
  return Math.round((t(hasta) - t(desde)) / 86_400_000);
};
const finDe = (c: DatosContrato) => fechaFin(c.fecha_inicio, c.duracion_meses);
const nombreCorto = (c: DatosContrato) =>
  c.arrendatario_nombre.split(' ').slice(0, 2).join(' ') + (c.coarrendatarios?.length ? ` (+${c.coarrendatarios.length})` : '');
const etiquetaUnidad = (direccion: string) => {
  const u = separarUnidad(direccion).unidad;
  return u ? u : 'casa';
};

/** Estado de un inmueble a la fecha `hoy`, según sus contratos (el más reciente primero). */
export function estadoInmueble(contratos: DatosContrato[], hoy: string): EstadoInmueble {
  const vigente = contratos.find((c) => c.fecha_inicio <= hoy && hoy <= finDe(c));
  const futuros = contratos.filter((c) => c.fecha_inicio > hoy).sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));
  const anterior = contratos.filter((c) => finDe(c) < hoy).sort((a, b) => finDe(b).localeCompare(finDe(a)))[0];

  if (vigente) {
    const fin = finDe(vigente);
    const dias = diasEntre(hoy, fin);
    return {
      tipo: dias <= DIAS_POR_VENCER ? 'por_vencer' : 'ocupado',
      contrato: vigente,
      fin,
      dias,
      siguiente: futuros[0],
      anterior,
    };
  }
  if (futuros[0]) {
    return { tipo: 'reservado', contrato: futuros[0], fin: finDe(futuros[0]), dias: diasEntre(hoy, futuros[0].fecha_inicio), anterior };
  }
  return { tipo: 'libre', anterior };
}

/** Una línea por inmueble en la vista del edificio. */
function lineaEstado(etiqueta: string, e: EstadoInmueble): string {
  const c = e.contrato;
  switch (e.tipo) {
    case 'ocupado':
      return `${EMOJI.ocupado} ${etiqueta} · ${nombreCorto(c!)} · hasta ${fechaCorta(e.fin!)}`;
    case 'por_vencer':
      return `${EMOJI.por_vencer} ${etiqueta} · ${nombreCorto(c!)} · vence ${fechaCorta(e.fin!)} (${e.dias} días)${e.siguiente ? ' · 🔁 renovado' : ''}`;
    case 'reservado':
      return `${EMOJI.reservado} ${etiqueta} · ${nombreCorto(c!)} · inicia ${fechaCorta(c!.fecha_inicio)}`;
    case 'libre':
      return `${EMOJI.libre} ${etiqueta} · libre${e.anterior ? ` desde ${fechaCorta(finDe(e.anterior))}` : ''}`;
  }
}

const EJEMPLO_EDIFICIO = 'Calle 80 # 12-34, Bogotá';

export class Inventario {
  constructor(
    private readonly catalogo: Catalogo,
    private readonly hoy: () => string,
  ) {}

  /** Informe general: cada edificio con su ocupación. */
  resumen(aviso?: string): Mensaje {
    const edificios = this.catalogo.edificiosOrdenados();
    const hoy = this.hoy();
    const bloques: string[] = [];
    const botones: Boton[][] = [];
    let libres = 0;

    edificios.forEach((edificio, i) => {
      const estados = this.catalogo.inmueblesDe(edificio).map((d) => estadoInmueble(this.catalogo.contratosDe(d), hoy));
      const cuenta = (t: TipoEstado) => estados.filter((e) => e.tipo === t).length;
      const ocupados = cuenta('ocupado') + cuenta('por_vencer');
      libres += cuenta('libre');
      const partes = [
        cuenta('ocupado') && `${EMOJI.ocupado} ${cuenta('ocupado')} ocupado${cuenta('ocupado') === 1 ? '' : 's'}`,
        cuenta('por_vencer') && `${EMOJI.por_vencer} ${cuenta('por_vencer')} por vencer`,
        cuenta('reservado') && `${EMOJI.reservado} ${cuenta('reservado')} por iniciar`,
        cuenta('libre') && `${EMOJI.libre} ${cuenta('libre')} libre${cuenta('libre') === 1 ? '' : 's'}`,
      ].filter(Boolean);
      bloques.push(`${edificio}\n${estados.length ? partes.join(' · ') : 'sin apartamentos registrados'}`);
      botones.push([{ texto: `🏢 ${edificio} · ${ocupados}/${estados.length}`, data: `inv:e:${i}` }]);
    });

    if (libres) botones.push([{ texto: `${EMOJI.libre} Ver libres (${libres})`, data: 'inv:libres' }]);
    botones.push([{ texto: '⚙️ Ajustes', data: 'inv:aj' }]);
    const cuerpo = edificios.length ? bloques.join('\n\n') : 'Todavía no hay inmuebles registrados.';
    return {
      texto: [aviso, `🏢 Inmuebles · ${fechaALetras(hoy)}`, cuerpo].filter(Boolean).join('\n\n'),
      botones,
    };
  }

  /**
   * Apartamentos libres agrupados por edificio: un botón de encabezado por edificio (abre su vista) y debajo
   * solo los números, en filas de 4. Al final, los que se desocupan pronto sin renovar.
   */
  libres(): Mensaje {
    const hoy = this.hoy();
    const botones: Boton[][] = [];
    const pronto: string[] = [];
    let total = 0;
    let edificios = 0;

    this.catalogo.edificiosOrdenados().forEach((edificio, i) => {
      const sinCiudad = edificio.split(',')[0]!;
      const libres: Boton[] = [];
      this.catalogo.inmueblesDe(edificio).forEach((direccion, j) => {
        const e = estadoInmueble(this.catalogo.contratosDe(direccion), hoy);
        if (e.tipo === 'libre') libres.push({ texto: etiquetaUnidad(direccion), data: `inv:u:${i}:${j}` });
        if (e.tipo === 'por_vencer' && !e.siguiente) {
          pronto.push(`${EMOJI.por_vencer} ${etiquetaUnidad(direccion)} · ${sinCiudad} · ${fechaCorta(e.fin!)}`);
        }
      });
      if (!libres.length) return;
      total += libres.length;
      edificios++;
      botones.push([{ texto: `🏢 ${sinCiudad} · ${libres.length} libre${libres.length === 1 ? '' : 's'}`, data: `inv:e:${i}` }]);
      for (let k = 0; k < libres.length; k += 4) botones.push(libres.slice(k, k + 4));
    });

    const texto = [
      total
        ? `${EMOJI.libre} Libres hoy: ${total} en ${edificios} edificio${edificios === 1 ? '' : 's'}`
        : `${EMOJI.libre} No hay inmuebles libres hoy.`,
      pronto.length ? `Se desocupan pronto (sin renovar):\n${pronto.join('\n')}` : '',
      total ? 'Toca un apartamento para ver el detalle o hacer un contrato.' : '',
    ];
    return {
      texto: texto.filter(Boolean).join('\n\n'),
      botones: [...botones, [{ texto: '↩️ Inmuebles', data: 'inv:inicio' }]],
    };
  }

  /** Apartamentos de un edificio, con su estado. */
  edificio(i: number, aviso?: string): Mensaje {
    const edificio = this.catalogo.edificiosOrdenados()[i];
    if (!edificio) return this.resumen('La lista cambió; vuelve a elegir.');
    const hoy = this.hoy();
    const inmuebles = this.catalogo.inmueblesDe(edificio);
    const estados = inmuebles.map((d) => estadoInmueble(this.catalogo.contratosDe(d), hoy));

    const botones: Boton[][] = [];
    inmuebles.forEach((d, j) => {
      if (j % 3 === 0) botones.push([]);
      botones.at(-1)!.push({ texto: `${EMOJI[estados[j]!.tipo]} ${etiquetaUnidad(d)}`, data: `inv:u:${i}:${j}` });
    });
    botones.push([
      { texto: '⚙️ Ajustes', data: `inv:aje:${i}` },
      { texto: '↩️ Inmuebles', data: 'inv:inicio' },
    ]);

    const lineas = inmuebles.length
      ? inmuebles.map((d, j) => lineaEstado(etiquetaUnidad(d), estados[j]!)).join('\n')
      : 'Sin apartamentos registrados. Agrégalos desde ⚙️ Ajustes.';
    return { texto: [aviso, `🏢 ${edificio}`, lineas].filter(Boolean).join('\n\n'), botones };
  }

  /** Detalle de un apartamento: contrato vigente, siguiente y anterior. */
  unidad(i: number, j: number, aviso?: string): Mensaje {
    const edificio = this.catalogo.edificiosOrdenados()[i];
    const direccion = edificio && this.catalogo.inmueblesDe(edificio)[j];
    if (!direccion) return this.resumen('La lista cambió; vuelve a elegir.');
    const hoy = this.hoy();
    const contratos = this.catalogo.contratosDe(direccion);
    const e = estadoInmueble(contratos, hoy);

    const titulo: Record<TipoEstado, string> = {
      ocupado: `${EMOJI.ocupado} Ocupado · faltan ${e.dias} días`,
      por_vencer: `${EMOJI.por_vencer} Vence en ${e.dias} días`,
      reservado: `${EMOJI.reservado} Libre · contrato que inicia en ${e.dias} días`,
      libre: `${EMOJI.libre} Libre`,
    };
    const partes = [aviso, `🏠 ${direccion}`, titulo[e.tipo]];
    if (e.contrato) partes.push(`📄 Contrato ${e.tipo === 'reservado' ? 'por iniciar' : 'vigente'}\n${describir(e.contrato)}`);
    if (e.siguiente) partes.push(`🔁 Renovado: ${nombreCorto(e.siguiente)} desde ${fechaCorta(e.siguiente.fecha_inicio)}`);
    if (e.anterior) {
      partes.push(
        `🕓 Anterior: ${nombreCorto(e.anterior)} · ${fechaCorta(e.anterior.fecha_inicio)} – ${fechaCorta(finDe(e.anterior))}`,
      );
    }

    const botones: Boton[][] = [];
    if (contratos.length) {
      botones.push([
        { texto: '📄 Reenviar contrato', data: `inv:reenviar:${i}:${j}` },
        { texto: '🔁 Renovar', data: `inv:renovar:${i}:${j}` },
      ]);
    }
    if (contratos.length) botones.push([{ texto: `🗂 Contratos (${contratos.length})`, data: `inv:uc:${i}:${j}` }]);
    botones.push([{ texto: '📝 Nuevo contrato aquí', data: `inv:nuevo:${i}:${j}` }]);
    botones.push([
      { texto: '⚙️ Ajustes', data: `inv:aju:${i}:${j}` },
      { texto: '↩️ Volver', data: `inv:e:${i}` },
    ]);
    return { texto: partes.filter(Boolean).join('\n\n'), botones };
  }

  /** /contratos: los últimos contratos generados, para revisarlos o borrar los hechos por error. */
  contratos(aviso?: string): Mensaje {
    const recientes = this.catalogo.contratosRecientes(10);
    return {
      texto: [
        aviso,
        '🗂 Últimos contratos generados',
        recientes.length ? 'Toca uno para ver el detalle o reenviarlo.' : 'Todavía no hay contratos.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      botones: [...recientes.map((c) => [this.botonContrato(c, true)]), [{ texto: '↩️ Inmuebles', data: 'inv:inicio' }]],
    };
  }

  /** Historial de contratos de un apartamento. */
  contratosDeUnidad(i: number, j: number): Mensaje {
    const edificio = this.catalogo.edificiosOrdenados()[i];
    const direccion = edificio && this.catalogo.inmueblesDe(edificio)[j];
    if (!direccion) return this.resumen('La lista cambió; vuelve a elegir.');
    const contratos = this.catalogo.contratosGuardadosDe(direccion);
    return {
      texto: `🗂 Contratos de ${direccion}

Toca uno para ver el detalle o reenviarlo.`,
      botones: [...contratos.map((c) => [this.botonContrato(c, false)]), [{ texto: '↩️ Volver', data: `inv:u:${i}:${j}` }]],
    };
  }

  /** Detalle de un contrato guardado. */
  detalleContrato(id: string, aviso?: string): Mensaje {
    const c = this.catalogo.contrato(id);
    if (!c) return this.contratos('Ese contrato ya no existe.');
    const generado = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(c.generado));
    return {
      texto: [aviso, `📄 Contrato de ${c.datos.arrendatario_nombre}`, describir(c.datos), `🕓 Generado el ${fechaALetras(generado)}`]
        .filter(Boolean)
        .join('\n\n'),
      botones: [
        [{ texto: '📄 Reenviar', data: `inv:creenv:${id}` }],
        [
          { texto: '⚙️ Ajustes', data: `inv:ajc:${id}` },
          { texto: '↩️ Contratos', data: 'inv:contratos' },
        ],
      ],
    };
  }

  // --- ⚙️ Ajustes: agregar, corregir y borrar, separados de las vistas normales ---------------------

  ajustesResumen(aviso?: string): Mensaje {
    return {
      texto: [
        aviso,
        '⚙️ Ajustes de inmuebles',
        'Para corregir o borrar un edificio o apartamento, entra a él y toca ⚙️ Ajustes.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      botones: [[{ texto: '➕ Agregar edificio', data: 'inv:addedif' }], [{ texto: '↩️ Volver', data: 'inv:inicio' }]],
    };
  }

  ajustesEdificio(i: number, aviso?: string): Mensaje {
    const edificio = this.catalogo.edificiosOrdenados()[i];
    if (!edificio) return this.resumen('La lista cambió; vuelve a elegir.');
    return {
      texto: [aviso, `⚙️ Ajustes de ${edificio}`].filter(Boolean).join('\n\n'),
      botones: [
        [{ texto: '➕ Agregar apartamentos', data: `inv:addapto:${i}` }],
        [{ texto: '✏️ Cambiar dirección', data: `inv:rene:${i}` }],
        [{ texto: '🗑 Borrar edificio', data: `inv:deledif:${i}` }],
        [{ texto: '↩️ Volver', data: `inv:e:${i}` }],
      ],
    };
  }

  ajustesUnidad(i: number, j: number, aviso?: string): Mensaje {
    const edificio = this.catalogo.edificiosOrdenados()[i];
    const direccion = edificio && this.catalogo.inmueblesDe(edificio)[j];
    if (!direccion) return this.resumen('La lista cambió; vuelve a elegir.');
    const botones: Boton[][] = [];
    if (separarUnidad(direccion).unidad) botones.push([{ texto: '✏️ Cambiar número', data: `inv:renu:${i}:${j}` }]);
    botones.push([{ texto: '🗑 Quitar apartamento', data: `inv:delu:${i}:${j}` }]);
    botones.push([{ texto: '↩️ Volver', data: `inv:u:${i}:${j}` }]);
    return { texto: [aviso, `⚙️ Ajustes de ${direccion}`].filter(Boolean).join('\n\n'), botones };
  }

  ajustesContrato(id: string): Mensaje {
    const c = this.catalogo.contrato(id);
    if (!c) return this.contratos('Ese contrato ya no existe.');
    const d = c.datos;
    return {
      texto: `⚙️ Ajustes del contrato de ${d.arrendatario_nombre}\n${d.inmueble_direccion} · desde ${fechaALetras(d.fecha_inicio)}`,
      botones: [[{ texto: '🗑 Borrar contrato', data: `inv:cdel:${id}` }], [{ texto: '↩️ Volver', data: `inv:c:${id}` }]],
    };
  }

  /** Pide escribir un valor (agregar o corregir), con un botón para cancelar y volver a `volver`. */
  private pedir(texto: string, volver: string): Mensaje {
    return { texto, botones: [[{ texto: '↩️ Cancelar', data: volver }]] };
  }

  /** "LAURA GÓMEZ · apto 301 · 15 oct 2026" (con o sin el inmueble). */
  private botonContrato(c: ContratoGuardado, conInmueble: boolean): Boton {
    const d = c.datos;
    const donde = conInmueble ? ` · ${etiquetaUnidad(d.inmueble_direccion) === 'casa' ? d.inmueble_direccion.split(',')[0] : `apto ${etiquetaUnidad(d.inmueble_direccion)}`}` : '';
    return { texto: `${nombreCorto(d)}${donde} · ${fechaCorta(d.fecha_inicio)}`, data: `inv:c:${c.id}` };
  }

  /**
   * Respuesta a un botón "inv:…". `textoMensaje` es el mensaje donde se tocó: para borrar se exige que
   * nombre lo mismo que se va a borrar, por si la lista cambió entre mostrarla y confirmar.
   */
  async boton(estado: EstadoInventario, data: string, textoMensaje = ''): Promise<RespuestaInventario> {
    const [, accion, a, b] = data.split(':');
    const i = Number(a);
    const j = Number(b);
    estado.esperando = undefined;
    const edificio = this.catalogo.edificiosOrdenados()[i];
    const direccion = edificio !== undefined ? this.catalogo.inmueblesDe(edificio)[j] : undefined;

    switch (accion) {
      case 'inicio':
        return { mensaje: this.resumen() };
      case 'aj':
        return { mensaje: this.ajustesResumen() };
      case 'aje':
        return { mensaje: this.ajustesEdificio(i) };
      case 'aju':
        return { mensaje: this.ajustesUnidad(i, j) };
      case 'ajc':
        return { mensaje: this.ajustesContrato(a!) };
      case 'rene':
        if (!edificio) return { mensaje: this.resumen('La lista cambió; vuelve a elegir.') };
        Object.assign(estado, { esperando: 'direccion_edificio', edificio: i });
        return {
          mensaje: this.pedir(
            `✏️ Dirección actual: ${edificio}\n\nEscribe la dirección correcta, sin apartamento. Ej.: ${EJEMPLO_EDIFICIO}`,
            `inv:aje:${i}`,
          ),
        };
      case 'renu':
        if (!direccion || !separarUnidad(direccion).unidad) return { mensaje: this.resumen('La lista cambió; vuelve a elegir.') };
        Object.assign(estado, { esperando: 'numero_apartamento', edificio: i, unidad: j });
        return {
          mensaje: this.pedir(
            `✏️ ${direccion}\n\nEscribe el número correcto del apartamento. Ej.: 301`,
            `inv:aju:${i}:${j}`,
          ),
        };
      case 'libres':
        return { mensaje: this.libres() };
      case 'e':
        return { mensaje: this.edificio(i) };
      case 'u':
        return { mensaje: this.unidad(i, j) };

      case 'addapto':
        if (!edificio) return { mensaje: this.resumen('La lista cambió; vuelve a elegir.') };
        Object.assign(estado, { esperando: 'apartamentos', edificio: i });
        return {
          mensaje: {
            texto: `🏢 ${edificio}\n\n✍️ Escribe el número del apartamento. Para varios, sepáralos con coma. Ej.: 401, 402`,
            botones: [[{ texto: '↩️ Cancelar', data: `inv:aje:${i}` }]],
          },
        };
      case 'addedif':
        estado.esperando = 'edificio';
        return {
          mensaje: {
            texto: `✍️ Escribe la dirección del edificio o casa, sin apartamento. Ej.: ${EJEMPLO_EDIFICIO}`,
            botones: [[{ texto: '↩️ Cancelar', data: 'inv:aj' }]],
          },
        };

      case 'deledif':
        if (!edificio) return { mensaje: this.resumen('La lista cambió; vuelve a elegir.') };
        return {
          mensaje: {
            texto: `🗑 ¿Borrar "${edificio}"?\n\nSe quita del informe y de las sugerencias, con sus apartamentos. Los contratos ya generados no se tocan.`,
            botones: [[{ texto: '🗑 Sí, borrar', data: `inv:deledifok:${i}` }, { texto: '↩️ No', data: `inv:aje:${i}` }]],
          },
        };
      case 'deledifok':
        if (!edificio || !textoMensaje.includes(`"${edificio}"`)) return { mensaje: this.resumen('La lista cambió; no borré nada.') };
        await this.catalogo.quitarEdificio(edificio);
        return { mensaje: this.resumen(`🗑 Borré: ${edificio}`) };

      case 'delu':
        if (!direccion) return { mensaje: this.resumen('La lista cambió; vuelve a elegir.') };
        return {
          mensaje: {
            texto: `🗑 ¿Quitar "${direccion}" del informe?\n\nLos contratos ya generados no se tocan.`,
            botones: [[{ texto: '🗑 Sí, quitar', data: `inv:deluok:${i}:${j}` }, { texto: '↩️ No', data: `inv:aju:${i}:${j}` }]],
          },
        };
      case 'deluok':
        if (!direccion || !textoMensaje.includes(`"${direccion}"`)) return { mensaje: this.resumen('La lista cambió; no quité nada.') };
        await this.catalogo.quitarInmueble(direccion);
        return { mensaje: this.edificio(i, `🗑 Quité: ${etiquetaUnidad(direccion)}`) };

      case 'contratos':
        return { mensaje: this.contratos() };
      case 'uc':
        return { mensaje: this.contratosDeUnidad(i, j) };
      case 'c':
        return { mensaje: this.detalleContrato(a!) };
      case 'creenv': {
        const c = this.catalogo.contrato(a!);
        if (!c) return { mensaje: this.contratos('Ese contrato ya no existe.') };
        return { mensaje: this.detalleContrato(a!), accion: { tipo: 'reenviar', datos: c.datos } };
      }
      case 'cdel': {
        const c = this.catalogo.contrato(a!);
        if (!c) return { mensaje: this.contratos('Ese contrato ya no existe.') };
        return {
          mensaje: {
            texto:
              `🗑 ¿Borrar el contrato de ${c.datos.arrendatario_nombre} en ${c.datos.inmueble_direccion}, ` +
              `del ${fechaALetras(c.datos.fecha_inicio)}?\n\nSe quita del historial y del informe, y el bot deja de ` +
              'sugerir lo que aprendió de él. Los archivos que ya se enviaron por el chat no se borran.',
            botones: [[{ texto: '🗑 Sí, borrar', data: `inv:cdelok:${a}` }, { texto: '↩️ No', data: `inv:ajc:${a}` }]],
          },
        };
      }
      case 'cdelok': {
        const borrado = await this.catalogo.borrarContrato(a!);
        if (!borrado) return { mensaje: this.contratos('Ese contrato ya no existe.') };
        const d = borrado.datos;
        const libre = estadoInmueble(this.catalogo.contratosDe(d.inmueble_direccion), this.hoy()).tipo === 'libre';
        const aviso = [
          `🗑 Borré el contrato de ${d.arrendatario_nombre} (${d.inmueble_direccion}).`,
          libre && `${EMOJI.libre} Ese inmueble quedó libre. Si no existe (dirección equivocada), quítalo desde /inmuebles.`,
        ]
          .filter(Boolean)
          .join('\n');
        return { mensaje: this.contratos(aviso) };
      }

      case 'reenviar':
      case 'renovar':
      case 'nuevo': {
        if (!direccion) return { mensaje: this.resumen('La lista cambió; vuelve a elegir.') };
        if (accion === 'nuevo') return { mensaje: this.unidad(i, j), accion: { tipo: 'nuevo', direccion } };
        const estadoActual = estadoInmueble(this.catalogo.contratosDe(direccion), this.hoy());
        // Reenviar: el vigente (o el último). Renovar: el más reciente, para continuar después de él.
        const datos =
          accion === 'reenviar'
            ? (estadoActual.contrato ?? this.catalogo.contratosDe(direccion)[0])
            : this.catalogo.contratosDe(direccion)[0];
        if (!datos) return { mensaje: this.unidad(i, j, 'Este inmueble no tiene contratos.') };
        return { mensaje: this.unidad(i, j), accion: { tipo: accion, datos } };
      }
      default:
        return { mensaje: this.resumen() };
    }
  }

  /** Texto escrito mientras se esperaba un apartamento o un edificio. null si no se esperaba nada. */
  async texto(estado: EstadoInventario, texto: string): Promise<Mensaje | null> {
    if (estado.esperando === 'apartamentos') {
      const edificio = this.catalogo.edificiosOrdenados()[estado.edificio ?? -1];
      estado.esperando = undefined;
      if (!edificio) return this.resumen('La lista cambió; vuelve a elegir.');
      const unidades = texto
        .split(/\s*(?:,|;|\by\b)\s*/i)
        .map((t) => interpretarUnidad(t))
        .filter((u): u is string => !!u);
      if (!unidades.length) {
        estado.esperando = 'apartamentos';
        return this.pedir('🤔 No entendí el número. Escríbelo así: 401, 402', `inv:aje:${estado.edificio}`);
      }
      const nuevos: string[] = [];
      for (const u of unidades) if (await this.catalogo.agregarInmueble(componerDireccion(edificio, u))) nuevos.push(u);
      const repetidos = unidades.filter((u) => !nuevos.includes(u));
      const aviso = [
        nuevos.length && `➕ Agregué: ${nuevos.join(', ')}`,
        repetidos.length && `Ya estaban: ${repetidos.join(', ')}`,
      ].filter(Boolean).join('\n');
      return this.edificio(estado.edificio!, aviso);
    }

    if (estado.esperando === 'edificio') {
      estado.esperando = undefined;
      return this.agregarEdificio(texto);
    }

    if (estado.esperando === 'direccion_edificio') {
      const i = estado.edificio!;
      const viejo = this.catalogo.edificiosOrdenados()[i];
      estado.esperando = undefined;
      if (!viejo) return this.resumen('La lista cambió; vuelve a elegir.');
      const { guardados, errores } = validarParcial({ inmueble_direccion: texto });
      const base = guardados.inmueble_direccion && separarUnidad(guardados.inmueble_direccion);
      if (!base || base.unidad) {
        estado.esperando = 'direccion_edificio';
        const problema = errores.inmueble_direccion ?? 'Escribe la dirección del edificio sin el apartamento.';
        return this.pedir(`⚠️ ${problema}\n\nEj.: ${EJEMPLO_EDIFICIO}`, `inv:aje:${i}`);
      }
      const error = await this.catalogo.renombrarEdificio(viejo, base.base);
      if (error) return this.ajustesEdificio(i, `⚠️ ${error}`);
      const nuevoI = this.catalogo.edificiosOrdenados().indexOf(base.base);
      return this.edificio(nuevoI >= 0 ? nuevoI : i, `✏️ Cambié la dirección:\n${viejo} → ${base.base}`);
    }

    if (estado.esperando === 'numero_apartamento') {
      const i = estado.edificio!;
      const j = estado.unidad!;
      const edificio = this.catalogo.edificiosOrdenados()[i];
      const direccion = edificio && this.catalogo.inmueblesDe(edificio)[j];
      estado.esperando = undefined;
      if (!direccion) return this.resumen('La lista cambió; vuelve a elegir.');
      const unidad = interpretarUnidad(texto);
      if (!unidad) {
        estado.esperando = 'numero_apartamento';
        return this.pedir('🤔 No entendí el número. Escríbelo así: 301', `inv:aju:${i}:${j}`);
      }
      const nueva = componerDireccion(edificio, unidad);
      const error = await this.catalogo.renombrarInmueble(direccion, nueva);
      if (error) return this.ajustesUnidad(i, j, `⚠️ ${error}`);
      const nuevoJ = this.catalogo.inmueblesDe(edificio).indexOf(nueva);
      return this.unidad(i, nuevoJ >= 0 ? nuevoJ : j, `✏️ Cambié ${etiquetaUnidad(direccion)} → ${unidad}`);
    }
    return null;
  }

  /** Guarda un edificio escrito a mano (si trae apartamento, también ese apartamento). */
  async agregarEdificio(texto: string): Promise<Mensaje> {
    const { guardados, errores } = validarParcial({ inmueble_direccion: texto });
    if (errores.inmueble_direccion) return this.resumen(`⚠️ ${errores.inmueble_direccion}`);
    const { base, unidad } = separarUnidad(guardados.inmueble_direccion!);
    const nuevo = await this.catalogo.agregarEdificio(base);
    if (unidad) await this.catalogo.agregarInmueble(componerDireccion(base, unidad));
    const i = this.catalogo.edificiosOrdenados().indexOf(base);
    const aviso = nuevo ? `💾 Guardé: ${base}${unidad ? '' : '\nAgrega sus apartamentos desde ⚙️ Ajustes.'}` : `Ya estaba guardado: ${base}`;
    return i >= 0 ? this.edificio(i, aviso) : this.resumen(aviso);
  }
}
