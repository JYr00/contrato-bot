/**
 * Interpretación determinista de lo que el usuario escribe cuando elige "otro valor".
 * Sin LLM: cada función devuelve null si no entiende, y el asistente vuelve a preguntar.
 */
import { MESES } from '../contract/numero-a-letras.js';

const PALABRAS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciocho: 18, veinte: 20,
  veinticuatro: 24, treinta: 30, treintaiseis: 36,
};

function sinTildes(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizar(s: string): string {
  return sinTildes(s.toLowerCase()).replace(/\s+/g, ' ').trim();
}

/** Primer número del texto, en cifras o en palabras ("seis", "un"). */
function primerNumero(texto: string): number | null {
  const t = normalizar(texto);
  const cifra = t.match(/\d+/);
  if (cifra) return Number(cifra[0]);
  for (const palabra of t.split(/[^a-z]+/)) if (palabra in PALABRAS) return PALABRAS[palabra]!;
  return null;
}

/**
 * Pesos colombianos: "1.500.000", "$1,500,000", "1.5 millones", "1 millón 200 mil", "850 mil", "900k",
 * "millón y medio". Devuelve un entero o null.
 */
export function interpretarPesos(texto: string): number | null {
  const t = normalizar(texto).replace(/\$|pesos|cop|m\/cte/g, ' ');
  const multiplicadores: [RegExp, number][] = [
    [/^(millones|millon|mill|mm|m)$/, 1_000_000],
    [/^(mil|k)$/, 1_000],
  ];

  let total = 0;
  let ultimoMultiplicador = 1;
  let encontrado = false;
  const partes = t.matchAll(/(\d+(?:[.,]\d+)*)?\s*(?<![a-z])(millones|millon|mill|mm|mil|k|m)?(?![a-z])/g);
  for (const [, cifra, unidad] of partes) {
    if (!cifra && !unidad) continue;
    const mult = unidad ? multiplicadores.find(([re]) => re.test(unidad))![1] : 1;
    let valor: number;
    if (!cifra) valor = 1; // "millón y medio", "mil"
    else if (/^\d{1,3}([.,]\d{3})+$/.test(cifra) && mult === 1) valor = Number(cifra.replace(/[.,]/g, ''));
    else if (/^\d{1,3}([.,]\d{3}){2,}$/.test(cifra)) valor = Number(cifra.replace(/[.,]/g, ''));
    else valor = Number(cifra.replace(',', '.'));
    if (!Number.isFinite(valor)) return null;
    total += valor * mult;
    ultimoMultiplicador = mult;
    encontrado = true;
  }
  if (!encontrado) return null;
  if (/y medio/.test(t)) total += ultimoMultiplicador / 2;
  return Math.round(total);
}

/** "6", "6 meses", "un año", "2 años", "año y medio" → meses. */
export function interpretarMeses(texto: string): number | null {
  const t = normalizar(texto);
  if (/^(un )?ano y medio$/.test(t)) return 18;
  const n = primerNumero(t) ?? (/\bano/.test(t) ? 1 : null);
  if (n === null) return null;
  return /\banos?\b/.test(t) ? n * 12 : n;
}

export function interpretarEntero(texto: string): number | null {
  return primerNumero(texto);
}

function iso(a: number, m: number, d: number): string {
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Suma días a una fecha ISO sin pasar por la zona horaria local. */
export function sumarDias(fechaIso: string, dias: number): string {
  const [a, m, d] = fechaIso.split('-').map(Number);
  const f = new Date(Date.UTC(a!, m! - 1, d! + dias));
  return iso(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate());
}

/** Primer día del mes siguiente a la fecha dada. */
export function primeroDelMesSiguiente(fechaIso: string): string {
  const [a, m] = fechaIso.split('-').map(Number);
  return m === 12 ? iso(a! + 1, 1, 1) : iso(a!, m! + 1, 1);
}

/**
 * "15/11/2026", "15-11", "2026-11-15", "15 de noviembre", "15 nov 2026", "hoy", "mañana".
 * Si no dan el año, usa la próxima ocurrencia a partir de hoy. No valida que el día exista: eso lo hace el esquema.
 */
export function interpretarFecha(texto: string, hoyIso: string): string | null {
  const t = normalizar(texto);
  if (t === 'hoy') return hoyIso;
  if (t === 'manana') return sumarDias(hoyIso, 1);

  const [anioHoy] = hoyIso.split('-').map(Number);
  const conAnio = (d: number, m: number, a?: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    if (a !== undefined) return iso(a < 100 ? 2000 + a : a, m, d);
    const candidata = iso(anioHoy!, m, d);
    return candidata >= hoyIso ? candidata : iso(anioHoy! + 1, m, d);
  };

  let r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) return conAnio(Number(r[3]), Number(r[2]), Number(r[1]));

  r = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (r) return conAnio(Number(r[1]), Number(r[2]), r[3] ? Number(r[3]) : undefined);

  r = t.match(/^(\d{1,2})\s*(?:de\s+)?([a-z]+)\.?(?:\s*(?:de|del)?\s*(\d{4}))?$/);
  if (r) {
    const mes = MESES.findIndex((nombre) => nombre.startsWith(r![2]!.slice(0, 3)) && r![2]!.length >= 3);
    if (mes >= 0) return conAnio(Number(r[1]), mes + 1, r[3] ? Number(r[3]) : undefined);
  }
  return null;
}

export interface DocumentoEscrito {
  nombre?: string;
  tipo?: 'CC' | 'CE' | 'PA' | 'PPT';
  numero?: string;
}

/** "Laura Gómez Pérez CC 1.020.345.678" → { nombre, tipo, numero } (lo que se pueda reconocer). */
export function interpretarDocumentoEscrito(texto: string): DocumentoEscrito {
  const r: DocumentoEscrito = {};
  let resto = ` ${texto} `;

  const tipos: [RegExp, DocumentoEscrito['tipo']][] = [
    [/\b(c\.?\s?e\.?|c[eé]dula de extranjer[ií]a)(?=\s|\d|$)/i, 'CE'],
    [/\b(ppt|permiso por protecci[oó]n temporal)\b/i, 'PPT'],
    [/\b(pasaporte|pa)\b/i, 'PA'],
    [/\b(c\.?\s?c\.?|c[eé]dula( de ciudadan[ií]a)?)(?=\s|\d|$)/i, 'CC'],
  ];
  for (const [re, tipo] of tipos) {
    if (re.test(resto)) {
      r.tipo = tipo;
      resto = resto.replace(re, ' ');
      break;
    }
  }

  const numero = resto.match(/[A-Z]{0,2}\d[\d.\s-]{2,}\d/i);
  if (numero) {
    r.numero = numero[0].replace(/[.\s-]/g, '');
    resto = resto.replace(numero[0], ' ');
  }

  const nombre = resto
    .replace(/\b(no|n[uú]mero|nro|n°|#|de|identificad[oa]|con)\b\.?/gi, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (nombre.split(' ').length >= 2) r.nombre = nombre;
  return r;
}

/** Suma meses conservando el día (31 ene + 1 mes → 28 feb). */
export function sumarMeses(fechaIso: string, meses: number): string {
  const [a, m, d] = fechaIso.split('-').map(Number);
  const total = a! * 12 + (m! - 1) + meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return iso(anio, mes, Math.min(d!, ultimoDia));
}

/** Último día del contrato: 15 oct + 3 meses → 14 ene. */
export function fechaFin(inicioIso: string, meses: number): string {
  return sumarDias(sumarMeses(inicioIso, meses), -1);
}

/**
 * Celular y/o correo en un solo texto: "310 555 1234 laura@x.com", "solo el correo laura@x.com",
 * "ninguno". Lo que no venga queda en blanco (''). Devuelve null si no reconoce nada.
 */
export function interpretarContacto(texto: string): { celular: string; correo: string } | null {
  if (/^\s*(no|ninguno|nada|en blanco|sin datos)\s*$/i.test(normalizar(texto))) return { celular: '', correo: '' };
  const correo = texto.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/)?.[0] ?? '';
  const digitos = texto.replace(correo, ' ').replace(/[^\d+]/g, '');
  const celular = digitos.length >= 7 ? digitos : '';
  return correo || celular ? { celular, correo } : null;
}

const UNIDAD = /^(.*?)[\s,]+(?:apartamento|apto|apt|ap)\b\.?\s*(?:no\.?\s*|#\s*)?([\w-]+)(.*)$/i;

/** "Carrera 105 i 67 d 31 apto 201, Bogotá" → { base: "Carrera 105 i 67 d 31, Bogotá", unidad: "201" } */
export function separarUnidad(direccion: string): { base: string; unidad?: string } {
  const m = direccion.trim().match(UNIDAD);
  if (!m) return { base: direccion.trim() };
  return { base: `${m[1]}${m[3]}`.trim(), unidad: m[2] };
}

/** Inverso de separarUnidad: pone "apto X" antes de la ciudad si la hay ("…31 apto 201, Bogotá"). */
export function componerDireccion(base: string, unidad?: string): string {
  if (!unidad) return base;
  const coma = base.indexOf(',');
  return coma < 0 ? `${base} apto ${unidad}` : `${base.slice(0, coma)} apto ${unidad}${base.slice(coma)}`;
}

/** "501", "apto 501", "Apartamento No. 501" → "501"; "casa", "ninguno" → '' (sin apartamento). */
export function interpretarUnidad(texto: string): string | null {
  const t = texto.trim();
  if (/^(casa|ninguno|no|sin( apartamento)?|completa)$/i.test(normalizar(t))) return '';
  const u = t.replace(/^(?:apartamento|apto|apt|ap)\b\.?\s*(?:no\.?\s*|#\s*)?/i, '').trim();
  return u && u.length <= 20 ? u : null;
}

const SENALES: RegExp[] = [
  /\$|\bmil\b|\bmill(o|on|ones)\b|\b\d{1,3}(\.\d{3})+\b|\b\d+\s*k\b/, // dinero
  /\bmes(es)?\b|\banos?\b/, // duración
  /\bdesde\b|\binicia|\bempieza|\b(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\b|\b\d{1,2}\/\d{1,2}\b/, // fecha
  /\b(apto|apartamento|apt)\b/, // apartamento
  /\bdeposito\b/, // depósito
  /\bpersonas?\b|\bocupantes?\b/, // ocupantes
];

/**
 * Cuántos tipos de dato distintos menciona un texto (dinero, duración, fecha, apartamento, depósito, ocupantes).
 * Con 2 o más, el mensaje trae varios datos a la vez y conviene interpretarlo completo.
 */
export function senalesDeDatos(texto: string): number {
  const t = normalizar(texto);
  return SENALES.filter((re) => re.test(t)).length;
}
