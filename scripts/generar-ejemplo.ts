/**
 * Genera un contrato de ejemplo con datos ficticios en ./out, sin Telegram ni API de Claude.
 * Útil para revisar la plantilla después de editarla:  npm run ejemplo
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { ContractRenderer } from '../src/contract/render.js';
import { estaCompleto, validarParcial, VALORES_POR_DEFECTO } from '../src/contract/schema.js';

const { guardados, errores } = validarParcial({
  ...VALORES_POR_DEFECTO,
  arrendatario_nombre: 'Laura Gómez Pérez',
  arrendatario_tipo_documento: 'CC',
  arrendatario_numero_documento: '1020345678',
  apartamento: '201',
  numero_ocupantes: 2,
  canon_mensual: 1500000,
  duracion_meses: 12,
  fecha_inicio: '2026-11-01',
  arrendatario_direccion: 'Carrera 105 i 67 d 31 apto 201, Bogotá',
  arrendatario_correo: 'laura.gomez@example.com',
  arrendatario_celular: '310 555 1234',
});

if (Object.keys(errores).length || !estaCompleto(guardados)) {
  console.error('Datos de ejemplo inválidos:', errores);
  process.exit(1);
}

const renderer = await ContractRenderer.desdeArchivo(
  'templates/contrato-arrendamiento.docx',
  { correo: 'arrendador@example.com', celular: '3001112233' },
  process.env.SOFFICE_PATH ?? 'soffice',
);
const contrato = await renderer.generar(guardados);

await mkdir('out', { recursive: true });
await writeFile(`out/${contrato.nombreBase}.docx`, contrato.docx);
if (contrato.pdf) await writeFile(`out/${contrato.nombreBase}.pdf`, contrato.pdf);
console.log(`Generado: out/${contrato.nombreBase}.docx${contrato.pdf ? ' y .pdf' : ' (sin PDF: falta LibreOffice)'}`);
