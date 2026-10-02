import Anthropic from '@anthropic-ai/sdk';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';

import { config } from './config.js';
import { ContractRenderer } from './contract/render.js';
import type { DatosContrato } from './contract/schema.js';
import { Catalogo } from './datos/catalogo.js';
import { Asistente, type Mensaje, type Salida } from './flujo/asistente.js';
import { LectorDocumento, type TipoImagen } from './ia/lector-documento.js';
import { InMemorySessionStore, type Session } from './session/store.js';

const ZONA_HORARIA = 'America/Bogota';
const MAX_IMAGEN = 5 * 1024 * 1024; // límite de la API de Claude por imagen

const renderer = await ContractRenderer.desdeArchivo(
  config.PLANTILLA_PATH,
  { correo: config.ARRENDADOR_CORREO, celular: config.ARRENDADOR_CELULAR },
  config.SOFFICE_PATH,
);
const catalogo = await Catalogo.abrir(config.CATALOGO_PATH);
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date());
const asistente = new Asistente(catalogo, hoy);
const lector = new LectorDocumento(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }), config.ANTHROPIC_MODEL);
const sesiones = new InMemorySessionStore();
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

const teclado = (m: Mensaje) =>
  m.botones && InlineKeyboard.from(m.botones.map((fila) => fila.map((b) => InlineKeyboard.text(b.texto, b.data))));

async function responder(ctx: Context, session: Session, salida: Salida) {
  for (const m of salida.mensajes) await ctx.reply(m.texto, { reply_markup: teclado(m) });
  if (salida.generar) await generar(ctx, session, salida.generar);
  await sesiones.save(session);
}

async function generar(ctx: Context, session: Session, datos: DatosContrato) {
  try {
    await ctx.replyWithChatAction('upload_document');
    const contrato = await renderer.generar(datos);
    if (contrato.pdf) await ctx.replyWithDocument(new InputFile(contrato.pdf, `${contrato.nombreBase}.pdf`));
    await ctx.replyWithDocument(new InputFile(contrato.docx, `${contrato.nombreBase}.docx`));
    await catalogo.registrarContrato(datos);
    await ctx.reply('✅ Listo. Imprímelo y fírmenlo ambas partes.\n\nPara otro contrato, envía la foto de la siguiente cédula 📷');
    console.log(`[chat ${session.chatId}] Contrato generado: ${contrato.nombreBase}`);
  } catch (err) {
    console.error(`[chat ${session.chatId}] Error generando el contrato:`, err);
    session.estado.paso = 'resumen';
    await ctx.reply('Tuve un problema generando el contrato. Intenta de nuevo con el botón ✅ Generar contrato.');
  }
}

/** Descarga la imagen del mensaje (foto o archivo de imagen) desde Telegram. */
async function descargarImagen(ctx: Context): Promise<{ datos: Buffer; tipo: TipoImagen } | string> {
  const doc = ctx.message?.document;
  let tipo: TipoImagen = 'image/jpeg';
  if (doc) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(doc.mime_type ?? '')) {
      return 'Ese archivo no es una imagen. Envía una foto de la cédula (JPG o PNG).';
    }
    tipo = doc.mime_type as TipoImagen;
  }
  const archivo = await ctx.getFile();
  if ((archivo.file_size ?? 0) > MAX_IMAGEN) return 'La imagen es muy pesada (máx. 5 MB). Envíala como foto, no como archivo.';
  const r = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${archivo.file_path}`);
  if (!r.ok) throw new Error(`Telegram respondió ${r.status} al descargar la imagen`);
  return { datos: Buffer.from(await r.arrayBuffer()), tipo };
}

// Solo usuarios autorizados: el bot maneja datos personales de terceros.
bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (id && config.USUARIOS_AUTORIZADOS.includes(id)) return next();
  console.warn(`Acceso denegado al usuario ${id} (@${ctx.from?.username ?? '-'})`);
  if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: 'No autorizado' });
  if (ctx.chat?.type === 'private') {
    await ctx.reply(`🔒 Este bot es privado.\nTu ID de Telegram es ${id}. Para usarlo, agrégalo a USUARIOS_AUTORIZADOS.`);
  }
});

bot.command(['start', 'nuevo'], async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  await responder(ctx, session, asistente.iniciar(session.estado));
});

bot.command('cancelar', async (ctx) => {
  await sesiones.reset(ctx.chat.id);
  await ctx.reply('Listo, descarté el contrato en curso. Envía una foto de cédula o escribe /nuevo para empezar otro.');
});

bot.on(['message:photo', 'message:document'], async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  await ctx.replyWithChatAction('typing');
  try {
    const imagen = await descargarImagen(ctx);
    if (typeof imagen === 'string') return void (await ctx.reply(imagen));
    await ctx.reply('🔎 Leyendo el documento…');
    const doc = await lector.leer(imagen.datos, imagen.tipo);
    await responder(ctx, session, await asistente.recibirDocumento(session.estado, doc));
  } catch (err) {
    console.error(`[chat ${session.chatId}] Error leyendo el documento:`, err);
    await ctx.reply('No pude leer la imagen. Intenta otra vez o escribe el nombre y número. Ej.: Laura Gómez Pérez CC 1020345678');
  }
});

bot.on('message:text', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  await responder(ctx, session, await asistente.recibirTexto(session.estado, ctx.message.text));
});

bot.on('callback_query:data', async (ctx) => {
  const session = await sesiones.get(ctx.chat!.id);
  const data = ctx.callbackQuery.data;
  const salida = await asistente.recibirBoton(session.estado, data);
  if (salida.obsoleto) return ctx.answerCallbackQuery({ text: 'Ese botón ya no está activo.' });
  await ctx.answerCallbackQuery();

  // Deja constancia de lo elegido y quita los botones del mensaje anterior.
  const mensaje = ctx.callbackQuery.message;
  const elegido = mensaje?.reply_markup?.inline_keyboard.flat().find((b) => 'callback_data' in b && b.callback_data === data);
  if (mensaje && 'text' in mensaje && mensaje.text) {
    await ctx.editMessageText(`${mensaje.text}\n\n✔️ ${elegido?.text ?? ''}`).catch(() => undefined);
  }
  await responder(ctx, session, salida);
});

bot.on('message', (ctx) => ctx.reply('Envía una foto de la cédula del arrendatario o escribe /nuevo 🙂'));

bot.catch((err) => console.error('Error no controlado:', err.error));

await bot.api.setMyCommands([
  { command: 'nuevo', description: 'Crear un contrato nuevo' },
  { command: 'cancelar', description: 'Descartar el contrato en curso' },
]);

if (!config.USUARIOS_AUTORIZADOS.length) {
  console.warn('⚠️  USUARIOS_AUTORIZADOS está vacío: nadie puede usar el bot. Escríbele para conocer tu ID.');
}

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

console.log('Bot iniciado (long polling)…');
await bot.start();
