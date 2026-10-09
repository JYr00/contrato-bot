import { dirname, join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';

import { config } from './config.js';
import { ContractRenderer, nombreArchivo } from './contract/render.js';
import type { DatosContrato } from './contract/schema.js';
import { compararConAnterior, verificarDatos } from './contract/verificar.js';
import { ArchivosContratos } from './datos/archivos.js';
import { Catalogo } from './datos/catalogo.js';
import { Respaldo } from './datos/respaldo.js';
import { Asistente, type Mensaje, type Salida } from './flujo/asistente.js';
import { Inventario } from './flujo/inventario.js';
import { ExtractorDatos } from './ia/extractor-datos.js';
import { LectorDocumento, type TipoImagen } from './ia/lector-documento.js';
import { Bitacora, extractorConBitacora, lectorConBitacora } from './registro/bitacora.js';
import { Salud, vigilarIA } from './registro/salud.js';
import { AgrupadorMensajes } from './session/agrupador.js';
import { ArchivoSessionStore, type Session } from './session/store.js';

const ZONA_HORARIA = 'America/Bogota';
const MAX_IMAGEN = 5 * 1024 * 1024; // límite de la API de Claude por imagen
/** Mensajes de texto que llegan con menos de esto entre uno y otro se interpretan juntos. */
const ESPERA_AGRUPAR_MS = 1500;

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
const bitacora = new Bitacora(join(carpetaDatos, 'logs', 'interacciones'), ZONA_HORARIA);
const claude = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
/** Único chat donde se manejan los respaldos: tienen datos personales de todos los arrendatarios. */
const chatRespaldo = config.RESPALDO_CHAT_ID ?? config.USUARIOS_AUTORIZADOS[0];
const chatAvisos = config.AVISOS_CHAT_ID ?? chatRespaldo;
const salud = new Salud(async (texto) => {
  if (chatAvisos) await bot.api.sendMessage(chatAvisos, texto);
});
const extractor = extractorConBitacora(new ExtractorDatos(claude, config.ANTHROPIC_MODEL), bitacora);
const asistente = new Asistente(catalogo, hoy, { extraer: vigilarIA(extractor.extraer.bind(extractor), salud) });
const lectorRegistrado = lectorConBitacora(new LectorDocumento(claude, config.ANTHROPIC_MODEL), bitacora);
const lector = { leer: vigilarIA(lectorRegistrado.leer.bind(lectorRegistrado), salud) };
const inventario = new Inventario(catalogo, hoy);
// Un reinicio (actualización, recarga de `npm run dev`, corte de luz) no pierde el contrato en curso.
const sesiones = await ArchivoSessionStore.abrir(join(carpetaDatos, 'sesiones.json'));
// Todo lo que el bot envía a Telegram queda en la bitácora (texto, botones, message_id).
bot.api.config.use(bitacora.transformador());

/** Error capturado: va a la consola y a la bitácora (con la actualización en curso, si la hay). */
function registrarError(donde: string, err: unknown) {
  console.error(`[${donde}]`, err);
  void bitacora.registrar({ tipo: 'error', mensaje: `${donde}: ${(err as Error)?.message ?? err}`, pila: (err as Error)?.stack });
}

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

/** En una renovación: párrafos fijos del contrato anterior que ya no coinciden con la plantilla de hoy. */
async function textoFijoDelAnterior(anterior: DatosContrato, id: string): Promise<string[]> {
  try {
    const archivo = await archivos.leer(id);
    return archivo ? renderer.textoFijoCambiado(anterior, archivo.docx) : [];
  } catch (err) {
    registrarError(`verificación: no se pudo comparar con el contrato ${id}`, err);
    return [];
  }
}

async function generar(ctx: Context, session: Session, datos: DatosContrato) {
  try {
    await ctx.replyWithChatAction('upload_document');
    // Verificación antes de enviar: datos completos y válidos, y el Word dice exactamente lo que debe.
    const problemasDatos = verificarDatos(datos);
    const contrato = problemasDatos.length ? undefined : await renderer.generar(datos);
    const verificacion = contrato ? renderer.verificar(datos, contrato.docx) : { ok: false, problemas: problemasDatos };
    const base = session.estado.base;
    const textoFijo = verificacion.ok && base?.id ? await textoFijoDelAnterior(base.datos, base.id) : [];
    void bitacora.registrar({
      tipo: 'verificacion',
      ok: verificacion.ok,
      problemas: verificacion.problemas,
      cambios: base && compararConAnterior(base.datos, datos),
      avisos: textoFijo,
    });
    if (!contrato || !verificacion.ok) {
      console.warn(`[chat ${session.chatId}] Contrato no enviado: no pasó la verificación.`, verificacion.problemas);
      salud.contratoRechazado(
        `${datos.arrendatario_nombre ?? '(sin nombre)'} · ${datos.inmueble_direccion ?? '(sin inmueble)'}\n` +
          verificacion.problemas.map((p) => `• ${p.tipo}${p.campo ? ` (${p.campo})` : ''}`).join('\n'),
      );
      await editarTarjeta(ctx, session, asistente.problemaAlGenerar(session.estado, verificacion.problemas).tarjeta);
      return;
    }

    if (contrato.pdf) await ctx.replyWithDocument(new InputFile(contrato.pdf, `${contrato.nombreBase}.pdf`));
    await ctx.replyWithDocument(new InputFile(contrato.docx, `${contrato.nombreBase}.docx`));
    const id = await catalogo.registrarContrato(datos);
    await archivos.guardar(id, contrato).catch((err) => registrarError(`contratos: no se pudo guardar ${id}`, err));
    const avisos = textoFijo.length
      ? ['📝 El texto fijo cambió desde el contrato anterior (plantilla o datos del arrendador). Revísalo antes de firmar.']
      : [];
    await editarTarjeta(ctx, session, asistente.generado(session.estado, avisos));
    console.log(`[chat ${session.chatId}] Contrato generado: ${contrato.nombreBase}`);
  } catch (err) {
    registrarError(`chat ${session.chatId}: generando el contrato`, err);
    salud.error('generando un contrato', err);
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
      registrarError(`respaldo: no se pudo enviar a ${chat}`, err);
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
    registrarError('respaldo', err);
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

// Bitácora: cada actualización se registra tal como llega y, al terminar, el estado en que quedó la
// conversación. Va primero para registrar también los intentos de usuarios no autorizados.
async function estadoDe(chatId: number) {
  const s = await sesiones.get(chatId);
  return { paso: s.estado.paso, datos: s.estado.datos, inventario: s.inventario, tarjetaId: s.tarjetaId };
}

bot.use(
  bitacora.middleware(async (ctx) => {
    if (!ctx.chat || !ctx.from || !config.USUARIOS_AUTORIZADOS.includes(ctx.from.id)) return null;
    return estadoDe(ctx.chat.id);
  }),
);

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

/**
 * Mensajes de texto seguidos se interpretan juntos (ver src/session/agrupador.ts). El texto completo se procesa
 * con el contexto de bitácora del último mensaje, y al terminar se registra el estado en que quedó.
 */
const agrupador = new AgrupadorMensajes<Context>(ESPERA_AGRUPAR_MS, async (chatId, texto, ctx) => {
  await bitacora.conContexto({ update_id: ctx.update.update_id, chat: chatId, usuario: ctx.from?.id }, async () => {
    const inicio = Date.now();
    try {
      const session = await sesiones.get(chatId);
      await mostrar(ctx, session, await asistente.recibirTexto(session.estado, texto));
    } catch (err) {
      registrarError(`chat ${chatId}: procesando mensaje`, err);
      await ctx.reply('⚠️ Tuve un problema con ese mensaje. Intenta de nuevo.').catch(() => undefined);
    } finally {
      void bitacora.registrar({ tipo: 'estado', ...(await estadoDe(chatId)), ms: Date.now() - inicio });
    }
  });
});

// Antes de cualquier otra cosa (botón, foto, comando), se procesa el texto que estuviera esperando: así se
// respeta el orden en que llegaron y nunca se tocan dos cosas a la vez sobre la misma sesión.
bot.use(async (ctx, next) => {
  const texto = ctx.message?.text;
  if (ctx.chat && !(texto && !texto.startsWith('/'))) await agrupador.vaciar(ctx.chat.id);
  return next();
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

/** Comprueba en vivo que la API de Claude responda (y le cuenta el resultado a la salud). */
async function probarClaude(): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  const inicio = Date.now();
  try {
    await claude.models.retrieve(config.ANTHROPIC_MODEL);
    salud.exitoIA();
    return { ok: true, ms: Date.now() - inicio };
  } catch (err) {
    salud.falloIA(err);
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

const diaDe = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date(ms));
const fechaHora = (ms: number) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: ZONA_HORARIA, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms),
  );
function hace(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.floor(min / 60)} h`;
  return `hace ${Math.floor(min / 1440)} días`;
}

/** Cómo está el bot: si la IA responde (prueba en vivo), desde cuándo corre, contratos y respaldo. */
bot.command('estado', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  const ia = await probarClaude();
  const generadosHoy = catalogo.contratosRecientes(200).filter((c) => diaDe(c.generado) === hoy()).length;
  const ultimoRespaldo = await respaldo.ultimo();
  const lineas = [
    '🩺 Estado del bot',
    '',
    ia.ok ? `🤖 IA: ✅ responde (${ia.ms} ms)` : `🤖 IA: ❌ no responde: ${ia.error.slice(0, 150)}`,
    `⏱️ Encendido desde el ${fechaHora(salud.arranque)} (${hace(salud.arranque)})`,
    `📄 Contratos generados hoy: ${generadosHoy}`,
    `🚫 Rechazados por la verificación desde que encendió: ${salud.rechazados}`,
    `💾 Último respaldo: ${ultimoRespaldo ? `${fechaHora(ultimoRespaldo)} (${hace(ultimoRespaldo)})` : 'nunca'}`,
  ];
  if (ia.ok && salud.ultimoErrorIA) lineas.push(`ℹ️ La IA falló por última vez ${hace(salud.ultimoErrorIA.cuando)}.`);
  await ctx.reply(lineas.join('\n'));
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
    registrarError(`chat ${session.chatId}: leyendo el documento`, err);
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
  const sinContrato = session.estado.paso === 'inicio' || session.estado.paso === 'listo';
  if (sinContrato && !agrupador.hayPendiente(ctx.chat.id) && !/\d/.test(texto)) {
    if (PIDE_LIBRES.test(texto)) return void (await responder(ctx, inventario.libres()));
    if (PIDE_INFORME.test(texto)) return void (await responder(ctx, inventario.resumen()));
  }

  await ctx.replyWithChatAction('typing').catch(() => undefined);
  agrupador.agregar(ctx.chat.id, texto, ctx);
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
  { command: 'estado', description: 'Ver si el bot y la IA están funcionando' },
]);

if (!config.USUARIOS_AUTORIZADOS.length) {
  console.warn('⚠️  USUARIOS_AUTORIZADOS está vacío: nadie puede usar el bot. Escríbele para conocer tu ID.');
}

const detener = () => void bitacora.vaciar().finally(() => bot.stop());
process.once('SIGINT', detener);
process.once('SIGTERM', detener);

/**
 * Al arrancar se prueba la llave de Anthropic: si no sirve, el bot no lee fotos ni mensajes largos y nadie lo
 * nota hasta que algo sale mal. Se avisa en consola, en la bitácora y a los usuarios.
 */
async function revisarClaude() {
  const ia = await probarClaude();
  if (!ia.ok) {
    registrarError('arranque: la API de Claude no responde', ia.error);
    const aviso =
      '⚠️ El bot arrancó, pero no puede usar Claude (revisa ANTHROPIC_API_KEY y ANTHROPIC_MODEL en el .env).\n\n' +
      'Mientras tanto no lee fotos de cédulas: escribe el nombre y el número, y un dato por mensaje.';
    for (const id of config.USUARIOS_AUTORIZADOS) await bot.api.sendMessage(id, aviso).catch(() => undefined);
  }
}

void revisarClaude();
setTimeout(revisarRespaldo, 60_000);
setInterval(revisarRespaldo, 6 * 60 * 60 * 1000);

void bitacora.registrar({ tipo: 'arranque', modelo: config.ANTHROPIC_MODEL, usuarios: config.USUARIOS_AUTORIZADOS.length });
console.log('Bot iniciado (long polling)…');
await bot.start();
