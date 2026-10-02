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

/**
 * Cada campo variable del contrato con su validación.
 * El agente solo puede guardar datos que pasen por aquí.
 */
export const campos = {
  arrendatario_nombre: z
    .string()
    .trim()
    .min(5, 'Debe ser el nombre completo (nombres y apellidos).')
    .max(120)
    .refine((s) => s.split(/\s+/).length >= 2, 'Debe incluir nombres y apellidos.')
    .transform((s) => s.replace(/\s+/g, ' ').toUpperCase()),
  arrendatario_tipo_documento: z.enum(['CC', 'CE', 'PA', 'PPT'], {
    errorMap: () => ({ message: 'Tipo de documento debe ser CC, CE, PA o PPT.' }),
  }),
  arrendatario_numero_documento: z
    .string()
    .transform((s) => s.replace(/[.\s-]/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4,15}$/, 'Número de documento inválido.')),
  apartamento: z.string().trim().min(1).max(20, 'Número de apartamento demasiado largo.'),
  numero_ocupantes: z.coerce.number().int().min(1).max(15, 'Máximo 15 ocupantes.'),
  canon_mensual: z.coerce
    .number()
    .int('El canon debe ser un valor entero en pesos.')
    .min(100_000, 'El canon parece demasiado bajo; debe estar en pesos colombianos.')
    .max(100_000_000, 'El canon parece demasiado alto; confirma el valor.'),
  duracion_meses: z.coerce.number().int().min(1).max(120, 'Máximo 120 meses.'),
  fecha_inicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado AAAA-MM-DD.')
    .refine(fechaValida, 'La fecha no existe.'),
  arrendatario_direccion: z.string().trim().min(5, 'Dirección incompleta.').max(150),
  arrendatario_correo: z.string().trim().toLowerCase().email('Correo electrónico inválido.'),
  arrendatario_celular: z
    .string()
    .transform((s) => s.replace(/[\s()-]/g, '').replace(/^\+?57/, ''))
    .pipe(z.string().regex(/^3\d{9}$/, 'Celular colombiano inválido (10 dígitos, empieza por 3).')),
  numero_ejemplares: z.coerce.number().int().min(1).max(5),
} satisfies Record<string, z.ZodTypeAny>;

export type CampoContrato = keyof typeof campos;
export type DatosContrato = { [K in CampoContrato]: z.output<(typeof campos)[K]> };

export const CAMPOS: CampoContrato[] = Object.keys(campos) as CampoContrato[];

/** Descripción de cada campo: la usa el agente para saber qué preguntar. */
export const DESCRIPCIONES: Record<CampoContrato, string> = {
  arrendatario_nombre: 'Nombre completo del arrendatario (nombres y apellidos).',
  arrendatario_tipo_documento:
    'Tipo de documento: CC (cédula de ciudadanía), CE (cédula de extranjería), PA (pasaporte) o PPT.',
  arrendatario_numero_documento: 'Número del documento de identidad, solo dígitos/letras.',
  apartamento: 'Número del apartamento dentro de Carrera 105 i 67 d 31 (ej. "201").',
  numero_ocupantes: 'Cuántas personas vivirán en el inmueble.',
  canon_mensual: 'Canon mensual en pesos colombianos, como entero sin puntos (ej. 1500000).',
  duracion_meses: 'Duración del contrato en meses (ej. 12).',
  fecha_inicio: 'Fecha de inicio del contrato en formato AAAA-MM-DD.',
  arrendatario_direccion: 'Dirección del arrendatario para notificaciones.',
  arrendatario_correo: 'Correo electrónico del arrendatario.',
  arrendatario_celular: 'Celular del arrendatario (10 dígitos).',
  numero_ejemplares: 'Número de ejemplares firmados del contrato (por defecto 2).',
};

export const VALORES_POR_DEFECTO: Partial<DatosContrato> = { numero_ejemplares: 2 };

export interface ResultadoValidacion {
  guardados: Partial<DatosContrato>;
  errores: Partial<Record<CampoContrato, string>>;
  ignorados: string[];
}

/** Valida un lote parcial de datos. Lo que es válido se devuelve normalizado. */
export function validarParcial(entrada: Record<string, unknown>): ResultadoValidacion {
  const resultado: ResultadoValidacion = { guardados: {}, errores: {}, ignorados: [] };
  for (const [clave, valor] of Object.entries(entrada)) {
    if (valor === null || valor === undefined || valor === '') continue;
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
