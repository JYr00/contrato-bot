import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DatosContrato } from '../contract/schema.js';
import { fechaFin, separarUnidad } from '../flujo/interpretar.js';

export interface Inmueble {
  direccion: string;
  usos: number;
  ultimoUso: number;
  ultimoPrecio?: number;
  ultimoDeposito?: number;
}

export interface ValorUsado {
  valor: number;
  usos: number;
  ultimoUso: number;
}

export interface ArrendatarioGuardado {
  tipo: DatosContrato['arrendatario_tipo_documento'];
  numero: string;
  nombre: string;
  celular?: string;
  correo?: string;
  direccion?: string;
  ocupantes?: number;
  ultimoInmueble?: string;
  /** Datos completos del último contrato generado: base para renovarlo. */
  ultimoContrato?: DatosContrato;
  ultimoUso: number;
}

export interface Edificio {
  direccion: string;
  ultimoUso: number;
}

/** Contrato generado, tal como se llenó: sirve para el informe de inmuebles y para reenviarlo. */
export interface ContratoGuardado {
  id: string;
  generado: number;
  datos: DatosContrato;
}

export interface DatosCatalogo {
  /** Edificios guardados a mano o al escribirlos (además de los deducidos de los inmuebles). */
  edificios: Edificio[];
  inmuebles: Inmueble[];
  precios: ValorUsado[];
  depositos: ValorUsado[];
  duraciones: ValorUsado[];
  arrendatarios: Record<string, ArrendatarioGuardado>;
  /** Todos los contratos generados, del más antiguo al más reciente. */
  contratos: ContratoGuardado[];
}

const vacio = (): DatosCatalogo => ({
  edificios: [],
  inmuebles: [],
  precios: [],
  depositos: [],
  duraciones: [],
  arrendatarios: {},
  contratos: [],
});

/**
 * Catálogos de antes del historial solo guardaban el último contrato de cada arrendatario:
 * se toman como historial inicial para que el informe de inmuebles no arranque vacío.
 */
function migrar(datos: DatosCatalogo): DatosCatalogo {
  if (datos.contratos.length) return datos;
  datos.contratos = Object.values(datos.arrendatarios)
    .filter((a) => a.ultimoContrato)
    .map((a) => ({
      id: `migrado-${a.numero}`,
      generado: a.ultimoUso,
      datos: { ...a.ultimoContrato!, coarrendatarios: a.ultimoContrato!.coarrendatarios ?? [] },
    }))
    .sort((a, b) => a.generado - b.generado);
  return datos;
}

/** Orden natural para apartamentos: 201, 202, 301, 1001. */
const ordenNatural = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });

const clave = (direccion: string) =>
  direccion.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const recientes = <T extends { ultimoUso: number; usos: number }>(lista: T[]) =>
  [...lista].sort((a, b) => b.ultimoUso - a.ultimoUso || b.usos - a.usos);

function usar(lista: ValorUsado[], valor: number, ahora: number) {
  const existente = lista.find((v) => v.valor === valor);
  if (existente) {
    existente.usos++;
    existente.ultimoUso = ahora;
  } else lista.push({ valor, usos: 1, ultimoUso: ahora });
}

/**
 * Lo que el arrendador ya usó antes: direcciones, precios, cánones, duraciones y arrendatarios.
 * Sirve para sugerir opciones en los botones. Se guarda en un JSON; ruta null = solo en memoria (pruebas).
 */
export class Catalogo {
  private constructor(
    private readonly datos: DatosCatalogo,
    private readonly ruta: string | null,
    private readonly reloj: () => number,
  ) {}

  static async abrir(ruta: string, reloj = Date.now): Promise<Catalogo> {
    try {
      const datos = { ...vacio(), ...JSON.parse(await readFile(ruta, 'utf8')) } as DatosCatalogo;
      return new Catalogo(migrar(datos), ruta, reloj);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return new Catalogo(vacio(), ruta, reloj);
    }
  }

  static enMemoria(datos: Partial<DatosCatalogo> = {}, reloj = Date.now): Catalogo {
    return new Catalogo(migrar({ ...vacio(), ...structuredClone(datos) }), null, reloj);
  }

  inmuebles(n = 3): string[] {
    return recientes(this.datos.inmuebles).slice(0, n).map((i) => i.direccion);
  }

  /**
   * Edificios (dirección sin apartamento), del más reciente al más antiguo: los guardados con
   * agregarEdificio y los deducidos de los inmuebles ya usados.
   */
  edificios(n = 4): string[] {
    const todos = [
      ...this.datos.edificios,
      ...this.datos.inmuebles.map((i) => ({ direccion: separarUnidad(i.direccion).base, ultimoUso: i.ultimoUso })),
    ].sort((a, b) => b.ultimoUso - a.ultimoUso);
    const vistos = new Set<string>();
    return todos
      .map((e) => e.direccion)
      .filter((d) => !vistos.has(clave(d)) && vistos.add(clave(d)))
      .slice(0, n);
  }

  /** Guarda (o marca como recién usado) un edificio. Devuelve true si no se conocía. */
  async agregarEdificio(direccion: string): Promise<boolean> {
    const k = clave(direccion);
    const nuevo = !this.edificios(Infinity).some((d) => clave(d) === k);
    const existente = this.datos.edificios.find((e) => clave(e.direccion) === k);
    if (existente) existente.ultimoUso = this.reloj();
    else this.datos.edificios.push({ direccion, ultimoUso: this.reloj() });
    await this.guardar();
    return nuevo;
  }

  /** Borra un edificio de las sugerencias, con sus apartamentos y precios guardados. */
  async quitarEdificio(direccion: string): Promise<boolean> {
    const k = clave(direccion);
    const antes = this.datos.edificios.length + this.datos.inmuebles.length;
    this.datos.edificios = this.datos.edificios.filter((e) => clave(e.direccion) !== k);
    this.datos.inmuebles = this.datos.inmuebles.filter((i) => clave(separarUnidad(i.direccion).base) !== k);
    if (this.datos.edificios.length + this.datos.inmuebles.length === antes) return false;
    await this.guardar();
    return true;
  }

  /** Todos los edificios en orden alfabético (orden estable para el informe de inmuebles). */
  edificiosOrdenados(): string[] {
    return this.edificios(Infinity).sort(ordenNatural);
  }

  /**
   * Inmuebles de un edificio (direcciones completas) en orden natural de apartamento. Si el edificio se
   * arrienda completo (casa), la dirección del edificio es su único inmueble.
   */
  inmueblesDe(edificio: string): string[] {
    const k = clave(edificio);
    return this.datos.inmuebles
      .filter((i) => clave(separarUnidad(i.direccion).base) === k)
      .map((i) => i.direccion)
      .sort((a, b) => ordenNatural(separarUnidad(a).unidad ?? '', separarUnidad(b).unidad ?? ''));
  }

  /** Contratos de un inmueble, el más reciente (por fecha de inicio) primero. */
  contratosDe(direccion: string): DatosContrato[] {
    const k = clave(direccion);
    return this.datos.contratos
      .filter((c) => clave(c.datos.inmueble_direccion) === k)
      .map((c) => c.datos)
      .sort((a, b) => b.fecha_inicio.localeCompare(a.fecha_inicio));
  }

  /** Apartamentos ya usados en un edificio, del más reciente al más antiguo. */
  unidades(edificio: string, n = 6): string[] {
    const k = clave(edificio);
    const unidades = recientes(this.datos.inmuebles)
      .map((i) => separarUnidad(i.direccion))
      .filter((s) => s.unidad && clave(s.base) === k)
      .map((s) => s.unidad!);
    return [...new Set(unidades)].slice(0, n);
  }

  inmueble(direccion: string): Inmueble | undefined {
    const k = clave(direccion);
    return this.datos.inmuebles.find((i) => clave(i.direccion) === k);
  }

  /** Guarda una dirección nueva. Devuelve false si ya existía. */
  async agregarInmueble(direccion: string): Promise<boolean> {
    if (this.inmueble(direccion)) return false;
    this.datos.inmuebles.push({ direccion, usos: 0, ultimoUso: this.reloj() });
    await this.guardar();
    return true;
  }

  async quitarInmueble(direccion: string): Promise<boolean> {
    const k = clave(direccion);
    const antes = this.datos.inmuebles.length;
    this.datos.inmuebles = this.datos.inmuebles.filter((i) => clave(i.direccion) !== k);
    if (this.datos.inmuebles.length === antes) return false;
    await this.guardar();
    return true;
  }

  /** Precios sugeridos: primero el último usado en ese inmueble, luego los más recientes en general. */
  precios(direccion?: string, n = 3): number[] {
    return this.sugerir(this.datos.precios, direccion && this.inmueble(direccion)?.ultimoPrecio, n);
  }

  depositos(direccion?: string, n = 2): number[] {
    return this.sugerir(this.datos.depositos, direccion && this.inmueble(direccion)?.ultimoDeposito, n);
  }

  duraciones(n = 3): number[] {
    return this.sugerir(this.datos.duraciones, undefined, n);
  }

  /** Últimos contratos de cada arrendatario, el que vence primero arriba. */
  contratosRenovables(n = 8): DatosContrato[] {
    const fin = (c: DatosContrato) => fechaFin(c.fecha_inicio, c.duracion_meses);
    return Object.values(this.datos.arrendatarios)
      .map((a) => a.ultimoContrato)
      .filter((c): c is DatosContrato => !!c)
      .sort((a, b) => fin(a).localeCompare(fin(b)))
      .slice(0, n);
  }

  arrendatario(numeroDocumento: string): ArrendatarioGuardado | undefined {
    return this.datos.arrendatarios[numeroDocumento];
  }

  /** Aprende de un contrato generado para sugerirlo la próxima vez. */
  async registrarContrato(d: DatosContrato): Promise<void> {
    const ahora = this.reloj();
    let inmueble = this.inmueble(d.inmueble_direccion);
    if (!inmueble) {
      inmueble = { direccion: d.inmueble_direccion, usos: 0, ultimoUso: ahora };
      this.datos.inmuebles.push(inmueble);
    }
    Object.assign(inmueble, {
      usos: inmueble.usos + 1,
      ultimoUso: ahora,
      ultimoPrecio: d.precio_mensual,
      ultimoDeposito: d.deposito,
    });

    usar(this.datos.precios, d.precio_mensual, ahora);
    if (d.deposito > 0) usar(this.datos.depositos, d.deposito, ahora);
    usar(this.datos.duraciones, d.duracion_meses, ahora);

    const previo = this.datos.arrendatarios[d.arrendatario_numero_documento];
    this.datos.arrendatarios[d.arrendatario_numero_documento] = {
      tipo: d.arrendatario_tipo_documento,
      numero: d.arrendatario_numero_documento,
      nombre: d.arrendatario_nombre,
      celular: d.arrendatario_celular || previo?.celular,
      correo: d.arrendatario_correo || previo?.correo,
      direccion: d.arrendatario_direccion,
      ocupantes: d.numero_ocupantes,
      ultimoInmueble: d.inmueble_direccion,
      ultimoContrato: { ...d },
      ultimoUso: ahora,
    };
    this.datos.contratos.push({ id: `${ahora.toString(36)}-${this.datos.contratos.length}`, generado: ahora, datos: { ...d } });
    await this.guardar();
  }

  private sugerir(lista: ValorUsado[], primero: number | undefined | '', n: number): number[] {
    const valores = recientes(lista).map((v) => v.valor);
    if (primero) valores.unshift(primero);
    return [...new Set(valores)].slice(0, n);
  }

  private async guardar(): Promise<void> {
    if (!this.ruta) return;
    await mkdir(dirname(this.ruta), { recursive: true });
    // Escritura atómica: si el proceso muere a mitad, el archivo anterior queda intacto.
    const temporal = `${this.ruta}.tmp`;
    await writeFile(temporal, JSON.stringify(this.datos, null, 2));
    await rename(temporal, this.ruta);
  }
}
