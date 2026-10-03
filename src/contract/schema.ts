import { z } from 'zod';

export const TIPOS_DOCUMENTO = {
  CC: 'cédula de ciudadanía',
  CE: 'cédula de extranjería',
  PA: 'pasaporte',
  PPT: 'Permiso por Protección Temporal',
} as const;

export const ABREVIATURA_DOCUMENTO: Record<keyof typeof TIPOS_DOCUMENTO, string> = {
  CC: 'C.C.',
  CE: 'C.E.',
  PA: 'Pasaporte',
  PPT: 'PPT',
};

function fechaValida(iso: string): boolean {
  const [a, m, d] = iso.split('-').map(Number);
  const fecha = new Date(Date.UTC(a!, m! - 1, d!));
  return fecha.getUTCFullYear() === a && fecha.getUTCMonth() === m! - 1 && fecha.getUTCDate() === d;
}

const pesos = (campo: string, minimo: number) =>
  z.coerce
    .number()
    .int(`${campo} debe ser un valor entero en pesos.`)
    .min(minimo, `${campo} parece demasiado bajo; debe estar en pesos colombianos.`)
    .max(100_000_000, `${campo} parece demasiado alto; confirma el valor.`);

/** Texto opcional: '' significa "se dejó en blanco a propósito" (queda una línea para llenar a mano). */
const opcional = <T extends z.ZodTypeAny>(esquema: T) => z.literal('').or(esquema);

const nombrePersona = z
  .string()
  .trim()
  .min(5, 'Debe ser el nombre completo (nombres y apellidos).')
  .max(120)
  .refine((s) => s.split(/\s+/).length >= 2, 'Debe incluir nombres y apellidos.')
  .transform((s) => s.replace(/\s+/g, ' ').toUpperCase());
const tipoDocumento = z.enum(['CC', 'CE', 'PA', 'PPT'], {
  errorMap: () => ({ message: 'Tipo de documento debe ser CC, CE, PA o PPT.' }),
});
const numeroDocumento = z
  .string()
  .transform((s) => s.replace(/[.\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4,15}$/, 'Número de documento inválido.'));

export const MAX_COARRENDATARIOS = 3;

/**
 * Cada campo variable del contrato con su validación.
 * Ningún dato llega a la plantilla sin pasar por aquí.
 */
export const campos = {
  arrendatario_nombre: nombrePersona,
  arrendatario_tipo_documento: tipoDocumento,
  arrendatario_numero_documento: numeroDocumento,
  /** Otros arrendatarios que firman y responden solidariamente (las notificaciones van al principal). */
  coarrendatarios: z
    .array(z.object({ nombre: nombrePersona, tipo: tipoDocumento, numero: numeroDocumento }))
    .max(MAX_COARRENDATARIOS, `Máximo ${MAX_COARRENDATARIOS} co-arrendatarios.`),
  inmueble_direccion: z
    .string()
    .trim()
    .min(8, 'Dirección incompleta: incluye calle/carrera, número y apartamento si aplica.')
    .max(150)
    .transform((s) => s.replace(/\s+/g, ' ')),
  precio_mensual: pesos('El precio', 100_000),
  deposito: z.coerce
    .number()
    .int('El canon debe ser un valor entero en pesos.')
    .min(0)
    .max(100_000_000, 'El canon parece demasiado alto; confirma el valor.')
    .refine((n) => n === 0 || n >= 10_000, 'El canon parece demasiado bajo; debe estar en pesos colombianos.'),
  duracion_meses: z.coerce.number().int().min(1, 'Mínimo 1 mes.').max(120, 'Máximo 120 meses.'),
  fecha_inicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado AAAA-MM-DD.')
    .refine(fechaValida, 'La fecha no existe.'),
  numero_ocupantes: z.coerce.number().int().min(1).max(15, 'Máximo 15 ocupantes.'),
  arrendatario_celular: opcional(
    z
      .string()
      .transform((s) => s.replace(/[\s()-]/g, '').replace(/^\+?57/, ''))
      .pipe(z.string().regex(/^3\d{9}$/, 'Celular colombiano inválido (10 dígitos, empieza por 3).')),
  ),
  arrendatario_correo: opcional(z.string().trim().toLowerCase().email('Correo electrónico inválido.')),
  arrendatario_direccion: z.string().trim().min(5, 'Dirección incompleta.').max(150),
  numero_ejemplares: z.coerce.number().int().min(1).max(5),
} satisfies Record<string, z.ZodTypeAny>;

export type CampoContrato = keyof typeof campos;
export type DatosContrato = { [K in CampoContrato]: z.output<(typeof campos)[K]> };

export const CAMPOS: CampoContrato[] = Object.keys(campos) as CampoContrato[];

/** Nombre corto de cada campo para el resumen y los mensajes de error. */
export const ETIQUETAS: Record<CampoContrato, string> = {
  arrendatario_nombre: 'Arrendatario',
  arrendatario_tipo_documento: 'Tipo de documento',
  arrendatario_numero_documento: 'Número de documento',
  coarrendatarios: 'Co-arrendatarios',
  inmueble_direccion: 'Inmueble',
  precio_mensual: 'Precio (arriendo mensual)',
  deposito: 'Canon (depósito inicial)',
  duracion_meses: 'Duración',
  fecha_inicio: 'Fecha de inicio',
  numero_ocupantes: 'Ocupantes',
  arrendatario_celular: 'Celular',
  arrendatario_correo: 'Correo',
  arrendatario_direccion: 'Dirección de notificación',
  numero_ejemplares: 'Ejemplares',
};

export const VALORES_POR_DEFECTO: Partial<DatosContrato> = { numero_ejemplares: 2, coarrendatarios: [] };

export interface ResultadoValidacion {
  guardados: Partial<DatosContrato>;
  errores: Partial<Record<CampoContrato, string>>;
  ignorados: string[];
}

/** Valida un lote parcial de datos. Lo que es válido se devuelve normalizado. */
export function validarParcial(entrada: Record<string, unknown>): ResultadoValidacion {
  const resultado: ResultadoValidacion = { guardados: {}, errores: {}, ignorados: [] };
  for (const [clave, valor] of Object.entries(entrada)) {
    if (valor === null || valor === undefined) continue;
    if (!(clave in campos)) {
      resultado.ignorados.push(clave);
      continue;
    }
    const campo = clave as CampoContrato;
    const parsed = campos[campo].safeParse(valor);
    if (parsed.success) (resultado.guardados as Record<string, unknown>)[campo] = parsed.data;
    else resultado.errores[campo] = parsed.error.issues[0]?.message ?? 'Valor inválido.';
  }
  return resultado;
}

export function camposFaltantes(datos: Partial<DatosContrato>): CampoContrato[] {
  return CAMPOS.filter((c) => datos[c] === undefined);
}

export function estaCompleto(datos: Partial<DatosContrato>): datos is DatosContrato {
  return camposFaltantes(datos).length === 0;
}
