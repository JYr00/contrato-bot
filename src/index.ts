import { dirname, join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';

import { config } from './config.js';
import { ContractRenderer, nombreArchivo } from './contract/render.js';
import type { DatosContrato } from './contract/schema.js';
import { ArchivosContratos } from './datos/archivos.js';
import { Catalogo } from './datos/catalogo.js';
import { Respaldo } from './datos/respaldo.js';
import { Asistente, type Mensaje, type Salida } from './flujo/asistente.js';
import { Inventario } from './flujo/inventario.js';
import { ExtractorDatos } from './ia/extractor-datos.js';
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
const carpetaDatos = dirname(config.CATALOGO_PATH);
const archivos = new ArchivosContratos(join(carpetaDatos, 'contratos'));
const respaldo = new Respaldo(config.CATALOGO_PATH, join(carpetaDatos, 'ultimo-respaldo.txt'));
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date());
const claude = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const asistente = new Asistente(catalogo, hoy, new ExtractorDatos(claude, config.ANTHROPIC_MODEL));
const lector = new LectorDocumento(claude, config.ANTHROPIC_MODEL);
const inventario = new Inventario(catalogo, hoy);
const sesiones = new InMemorySessionStore();
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

const teclado = (m: Mensaje) =>
  m.botones && InlineKeyboard.from(m.botones.map((fila) => fila.map((b) => InlineKeyboard.text(b.texto, b.data))));

const noModificado = (err: unknown) => String((err as Error)?.message).includes('message is not modified');

/** Edita la tarjeta en su mensaje; si ya no se puede (borrada, muy vieja), la envía de nuevo. */
async function editarTarjeta(ctx: Context, session: Session, m: Mensaje) {
  if (session.tarjetaId) {
    try {
      await ctx.api.editMessageText(session.chatId, session.tarjetaId, m.texto, { reply_markup: teclado(m) });
      return;
    } catch (err) {
      if (noModificado(err)) return;
    }
  }
  session.tarjetaId = (await ctx.reply(m.texto, { reply_markup: teclado(m) })).message_id;
}

/**
 * Muestra la tarjeta del contrato en curso. Con un botón se edita en el mismo mensaje; si el usuario
 * escribió o envió una foto, la tarjeta se vuelve a enviar abajo para que quede a la vista (la anterior se
 * borra). Un contrato nuevo conserva la tarjeta anterior, sin botones, como constancia.
 */
async function mostrar(ctx: Context, session: Session, salida: Salida) {
  const anterior = session.tarjetaId;
  const desdeLaTarjeta = !!anterior && ctx.callbackQuery?.message?.message_id === anterior;

  if (desdeLaTarjeta && !salida.nueva) {
    await editarTarjeta(ctx, session, salida.tarjeta);
  } else {
    if (anterior && salida.nueva) await ctx.api.editMessageReplyMarkup(session.chatId, anterior).catch(() => undefined);
    else if (anterior) await ctx.api.deleteMessage(session.chatId, anterior).catch(() => undefined);
    session.tarjetaId = (await ctx.reply(salida.tarjeta.texto, { reply_markup: teclado(salida.tarjeta) })).message_id;
  }

  if (salida.generar) await generar(ctx, session, salida.generar);
  await sesiones.save(session);
}

async function generar(ctx: Context, session: Session, datos: DatosContrato) {
  try {
    await ctx.replyWithChatAction('upload_document');
    const contrato = await renderer.generar(datos);
    if (contrato.pdf) await ctx.replyWithDocument(new InputFile(contrato.pdf, `${contrato.nombreBase}.pdf`));
    await ctx.replyWithDocument(new InputFile(contrato.docx, `${contrato.nombreBase}.docx`));
    const id = await catalogo.registrarContrato(datos);
    await archivos.guardar(id, contrato).catch((err) => console.error(`[contratos] No se pudo guardar ${id}:`, err));
    await editarTarjeta(ctx, session, asistente.generado(session.estado));
    console.log(`[chat ${session.chatId}] Contrato generado: ${contrato.nombreBase}`);
  } catch (err) {
    console.error(`[chat ${session.chatId}] Error generando el contrato:`, err);
    session.estado.paso = 'resumen';
    const salida = asistente.actual(session.estado, '⚠️ Tuve un problema generando el contrato. Intenta de nuevo.');
    await editarTarjeta(ctx, session, salida.tarjeta);
  }
}

/** Vuelve a enviar los archivos de un contrato ya generado (desde el informe de inmuebles). */
async function reenviar(ctx: Context, datos: DatosContrato, id?: string) {
  await ctx.replyWithChatAction('upload_document');
  // Los archivos originales si se guardaron (contratos de antes se vuelven a generar).
  const contrato = (id && (await archivos.leer(id))) || (await renderer.generar(datos));
  const nombre = nombreArchivo(datos);
  const caption = `📄 Copia del contrato de ${datos.arrendatario_nombre}`;
  if (contrato.pdf) await ctx.replyWithDocument(new InputFile(contrato.pdf, `${nombre}.pdf`), { caption });
  await ctx.replyWithDocument(new InputFile(contrato.docx, `${nombre}.docx`), contrato.pdf ? {} : { caption });
}

/** Envía el catálogo a esos chats. Devuelve cuántos lo recibieron. */
/** Único chat donde se manejan los respaldos: tienen datos personales de todos los arrendatarios. */
const chatRespaldo = config.RESPALDO_CHAT_ID ?? config.USUARIOS_AUTORIZADOS[0];

async function enviarRespaldo(chats: number[], motivo: string): Promise<number> {
  const archivo = await respaldo.archivo(hoy());
  if (!archivo) return 0;
  const caption =
    `💾 Respaldo ${motivo} · ${hoy()}\n\nGuarda este archivo: con él se recupera todo (edificios, apartamentos, ` +
    'historial de contratos y arrendatarios). Contiene datos personales; no lo reenvíes.';
  let enviados = 0;
  for (const chat of chats) {
    try {
      await bot.api.sendDocument(chat, new InputFile(archivo.datos, archivo.nombre), { caption });
      enviados++;
    } catch (err) {
      console.error(`[respaldo] No se pudo enviar a ${chat}:`, (err as Error).message);
    }
  }
  if (enviados) await respaldo.marcar();
  return enviados;
}

/** Respaldo automático: se revisa al arrancar y cada 6 horas; se envía si pasaron 7 días del último. */
async function revisarRespaldo() {
  try {
    if (await respaldo.toca()) {
      if (!chatRespaldo) return;
      if (await enviarRespaldo([chatRespaldo], 'semanal')) console.log(`[respaldo] Enviado al chat ${chatRespaldo}.`);
    }
  } catch (err) {
    console.error('[respaldo] Error:', err);
  }
}

const responder = (ctx: Context, m: Mensaje) => ctx.reply(m.texto, { reply_markup: teclado(m) });

// Frases para pedir el informe sin comando (solo sin números, para no confundirlas con datos de un contrato).
const PIDE_LIBRES = /\b(vac[ií]os?|libres?|desocupad[oa]s?|disponibles?)\b/i;
const PIDE_INFORME = /\b(inmuebles?|apartamentos?|aptos?|informe|reporte|ocupad[oa]s?|contratos)\b/i;

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
  await mostrar(ctx, session, asistente.iniciar(session.estado));
});

bot.command('renovar', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  await mostrar(ctx, session, asistente.renovar(session.estado));
});

bot.command('cancelar', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  if (session.tarjetaId && session.estado.paso !== 'listo') {
    await ctx.api.editMessageText(ctx.chat.id, session.tarjetaId, '❌ Contrato cancelado.').catch(() => undefined);
  }
  await sesiones.reset(ctx.chat.id);
  await ctx.reply('Listo, descarté el contrato en curso. Envía una foto de cédula o escribe /nuevo para empezar otro.');
});

// /inmuebles (y su alias /direcciones): informe con botones. Con texto, agrega ese edificio.
bot.command(['inmuebles', 'direcciones'], async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  session.inventario.esperando = undefined;
  const texto = ctx.match.trim();
  await responder(ctx, texto ? await inventario.agregarEdificio(texto) : inventario.resumen());
});

bot.command('respaldo', async (ctx) => {
  if (ctx.chat.id !== chatRespaldo) {
    return void (await ctx.reply('🔒 Los respaldos se manejan en otro chat. Pídeselo a quien los recibe.'));
  }
  const enviados = await enviarRespaldo([ctx.chat.id], 'manual');
  if (!enviados) await ctx.reply('Todavía no hay datos para respaldar.');
});

bot.command('contratos', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  session.inventario.esperando = undefined;
  await responder(ctx, inventario.contratos());
});

bot.command('libres', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  session.inventario.esperando = undefined;
  await responder(ctx, inventario.libres());
});

// Va antes del manejador general de botones: los "inv:…" no son del contrato en curso.
bot.callbackQuery(/^inv:/, async (ctx) => {
  const session = await sesiones.get(ctx.chat!.id);
  const mensaje = ctx.callbackQuery.message;
  const texto = mensaje && 'text' in mensaje ? (mensaje.text ?? '') : '';
  const { mensaje: m, accion } = await inventario.boton(session.inventario, ctx.callbackQuery.data, texto);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(m.texto, { reply_markup: teclado(m) }).catch((err) => {
    if (!noModificado(err)) throw err;
  });
  if (accion?.tipo === 'reenviar') await reenviar(ctx, accion.datos, accion.id);
  if (accion?.tipo === 'borrado') await archivos.borrar(accion.id);
  if (accion?.tipo === 'renovar') await mostrar(ctx, session, asistente.renovarContrato(session.estado, accion.datos));
  if (accion?.tipo === 'nuevo') await mostrar(ctx, session, asistente.nuevoEn(session.estado, accion.direccion));
  await sesiones.save(session);
});

bot.on(['message:photo', 'message:document'], async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  await ctx.replyWithChatAction('typing');
  try {
    const imagen = await descargarImagen(ctx);
    if (typeof imagen === 'string') return void (await ctx.reply(imagen));
    const leyendo = await ctx.reply('🔎 Leyendo el documento…');
    const doc = await lector.leer(imagen.datos, imagen.tipo).finally(() =>
      ctx.api.deleteMessage(ctx.chat.id, leyendo.message_id).catch(() => undefined),
    );
    await mostrar(ctx, session, await asistente.recibirDocumento(session.estado, doc));
  } catch (err) {
    console.error(`[chat ${session.chatId}] Error leyendo el documento:`, err);
    await ctx.reply('No pude leer la imagen. Intenta otra vez o escribe el nombre y número. Ej.: Laura Gómez Pérez CC 1020345678');
  }
});

bot.on('message:text', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  const texto = ctx.message.text;

  // Respuesta a lo que se pidió escribir desde ⚙️ Ajustes del informe (agregar o corregir).
  const deInventario = await inventario.texto(session.inventario, texto);
  if (deInventario) return void (await responder(ctx, deInventario));

  // "muéstrame los apartamentos vacíos" sin contrato en curso.
  if ((session.estado.paso === 'inicio' || session.estado.paso === 'listo') && !/\d/.test(texto)) {
    if (PIDE_LIBRES.test(texto)) return void (await responder(ctx, inventario.libres()));
    if (PIDE_INFORME.test(texto)) return void (await responder(ctx, inventario.resumen()));
  }

  await ctx.replyWithChatAction('typing');
  await mostrar(ctx, session, await asistente.recibirTexto(session.estado, texto));
});

bot.on('callback_query:data', async (ctx) => {
  const session = await sesiones.get(ctx.chat!.id);
  const salida = await asistente.recibirBoton(session.estado, ctx.callbackQuery.data);
  if (salida.obsoleto) return ctx.answerCallbackQuery({ text: 'Ese botón ya no está activo.' });
  await ctx.answerCallbackQuery();
  await mostrar(ctx, session, salida);
});

bot.on('message', (ctx) => ctx.reply('Envía una foto de la cédula del arrendatario o escribe /nuevo 🙂'));

bot.catch((err) => console.error('Error no controlado:', err.error));

await bot.api.setMyCommands([
  { command: 'nuevo', description: 'Crear un contrato nuevo' },
  { command: 'renovar', description: 'Renovar un contrato anterior' },
  { command: 'cancelar', description: 'Descartar el contrato en curso' },
  { command: 'inmuebles', description: 'Informe de edificios y apartamentos' },
  { command: 'libres', description: 'Apartamentos libres' },
  { command: 'contratos', description: 'Últimos contratos: ver, reenviar o borrar' },
  { command: 'respaldo', description: 'Recibir un respaldo de todos los datos' },
]);

if (!config.USUARIOS_AUTORIZADOS.length) {
  console.warn('⚠️  USUARIOS_AUTORIZADOS está vacío: nadie puede usar el bot. Escríbele para conocer tu ID.');
}

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

setTimeout(revisarRespaldo, 60_000);
setInterval(revisarRespaldo, 6 * 60 * 60 * 1000);

console.log('Bot iniciado (long polling)…');
await bot.start();
