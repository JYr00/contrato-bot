/**
 * Conversión de números a letras en español (convención usada en contratos colombianos).
 * Determinista a propósito: el valor en letras nunca lo escribe el LLM.
 */

const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
const DIEZ_A_VEINTINUEVE = [
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO',
  'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO',
  'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE',
];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = [
  '', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS',
  'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS',
];

function menorQueMil(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const partes: string[] = [];
  const c = Math.floor(n / 100);
  const r = n % 100;
  if (c) partes.push(CENTENAS[c]!);
  if (r) {
    if (r < 10) partes.push(UNIDADES[r]!);
    else if (r < 30) partes.push(DIEZ_A_VEINTINUEVE[r - 10]!);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      partes.push(u ? `${DECENAS[d]} Y ${UNIDADES[u]}` : DECENAS[d]!);
    }
  }
  return partes.join(' ');
}

/** "UNO" → "UN" y "VEINTIUNO" → "VEINTIÚN" delante de MIL / MILLONES / sustantivos masculinos. */
function apocopar(s: string): string {
  return s.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/(^|\s)UNO$/, '$1UN');
}

function feminizar(s: string): string {
  return s.replace(/VEINTIUNO$|VEINTIÚN$/, 'VEINTIUNA').replace(/(^|\s)UNO?$/, '$1UNA');
}

/** Entero no negativo a letras en mayúscula (sin apócope final). */
export function enteroALetras(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Número inválido: ${n}`);
  if (n === 0) return 'CERO';

  const millones = Math.floor(n / 1_000_000);
  const resto = n % 1_000_000;
  const miles = Math.floor(resto / 1000);
  const unidades = resto % 1000;
  const partes: string[] = [];

  if (millones === 1) partes.push('UN MILLÓN');
  else if (millones > 1) partes.push(`${apocopar(enteroALetras(millones))} MILLONES`);

  if (miles === 1) partes.push('MIL');
  else if (miles > 1) partes.push(`${apocopar(menorQueMil(miles))} MIL`);

  if (unidades) partes.push(menorQueMil(unidades));
  return partes.join(' ');
}

/** 1500000 → "1.500.000" */
export function formatoMiles(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** 1500000 → "UN MILLÓN QUINIENTOS MIL PESOS ($1.500.000)" */
export function pesosALetras(n: number): string {
  const letras = apocopar(enteroALetras(n));
  const dePesos = n >= 1_000_000 && n % 1_000_000 === 0 ? 'DE PESOS' : 'PESOS';
  return `${letras} ${dePesos} ($${formatoMiles(n)})`;
}

/** 2, 'mes', 'meses' → "dos (2) meses"; 1, 'persona', 'personas', true → "una (1) persona" */
export function cantidad(n: number, singular: string, plural: string, femenino = false): string {
  const base = enteroALetras(n);
  const letras = (femenino ? feminizar(base) : apocopar(base)).toLowerCase();
  return `${letras} (${n}) ${n === 1 ? singular : plural}`;
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
  'noviembre', 'diciembre',
];

/** "2026-11-01" → "1 de noviembre de 2026" (sin pasar por Date para evitar desfases de zona horaria). */
export function fechaALetras(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES[m! - 1]} de ${a}`;
}
