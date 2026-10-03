import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DatosContrato } from '../contract/schema.js';
import { separarUnidad } from '../flujo/interpretar.js';

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
  ultimoUso: number;
}

export interface DatosCatalogo {
  inmuebles: Inmueble[];
  precios: ValorUsado[];
  depositos: ValorUsado[];
  duraciones: ValorUsado[];
  arrendatarios: Record<string, ArrendatarioGuardado>;
}

const vacio = (): DatosCatalogo => ({ inmuebles: [], precios: [], depositos: [], duraciones: [], arrendatarios: {} });

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
      return new Catalogo(datos, ruta, reloj);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return new Catalogo(vacio(), ruta, reloj);
    }
  }

  static enMemoria(datos: Partial<DatosCatalogo> = {}, reloj = Date.now): Catalogo {
    return new Catalogo({ ...vacio(), ...structuredClone(datos) }, null, reloj);
  }

  inmuebles(n = 3): string[] {
    return recientes(this.datos.inmuebles).slice(0, n).map((i) => i.direccion);
  }

  /**
   * Edificios (dirección sin apartamento), del más reciente al más antiguo. Se deducen de los inmuebles
   * guardados; `fijos` son los configurados por el arrendador y siempre aparecen.
   */
  edificios(fijos: string[] = [], n = 4): string[] {
    const usados = recientes(this.datos.inmuebles).map((i) => separarUnidad(i.direccion).base);
    const vistos = new Set<string>();
    return [...usados, ...fijos]
      .filter((b) => !vistos.has(clave(b)) && vistos.add(clave(b)))
      .slice(0, n);
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
      ultimoUso: ahora,
    };
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
