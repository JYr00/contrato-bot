import Anthropic from '@anthropic-ai/sdk';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';

import { ContratoAgent } from './agent/contrato-agent.js';
import { config } from './config.js';
import { ContractRenderer, type ContratoGenerado } from './contract/render.js';
import { VALORES_POR_DEFECTO } from './contract/schema.js';
import { InMemorySessionStore, type Session } from './session/store.js';

const renderer = await ContractRenderer.desdeArchivo(
  config.PLANTILLA_PATH,
  { correo: config.ARRENDADOR_CORREO, celular: config.ARRENDADOR_CELULAR },
  config.SOFFICE_PATH,
);
const agent = new ContratoAgent(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }), config.ANTHROPIC_MODEL, renderer);
const sesiones = new InMemorySessionStore(VALORES_POR_DEFECTO);
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

const TEXTO_DATOS =
  'Hola 👋 Soy el asistente para diligenciar tu contrato de arrendamiento del inmueble en ' +
  'Carrera 105 i 67 d 31 (Bogotá).\n\n' +
  'Para generarlo necesito algunos datos personales (nombre, documento, correo, celular y dirección). ' +
  'Se usarán solo para elaborar este contrato y se compartirán con el arrendador, conforme a la ' +
  'Ley 1581 de 2012 de protección de datos personales.\n\n¿Autorizas el tratamiento de tus datos?';

const tecladoConsentimiento = new InlineKeyboard().text('✅ Autorizo', 'acepto_datos').text('No autorizo', 'rechazo_datos');

async function pedirConsentimiento(ctx: Context) {
  await ctx.reply(TEXTO_DATOS, { reply_markup: tecladoConsentimiento });
}

async function conversar(ctx: Context, session: Session, texto: string) {
  await ctx.replyWithChatAction('typing');
  try {
    const { texto: respuesta, contrato } = await agent.responder(session, texto);
    if (respuesta) await ctx.reply(respuesta);
    if (contrato) await enviarContrato(ctx, contrato);
  } catch (err) {
    console.error(`[chat ${session.chatId}] Error del agente:`, err);
    await ctx.reply('Tuve un problema técnico. Intenta de nuevo en un momento, por favor.');
  } finally {
    await sesiones.save(session);
  }
}

async function enviarContrato(ctx: Context, contrato: ContratoGenerado) {
  const archivos = [new InputFile(contrato.docx, `${contrato.nombreBase}.docx`)];
  if (contrato.pdf) archivos.unshift(new InputFile(contrato.pdf, `${contrato.nombreBase}.pdf`));

  for (const archivo of archivos) await ctx.replyWithDocument(archivo);
  await ctx.reply('Si necesitas otro contrato, escribe /nuevo.');

  // Copia para el arrendador, si está configurado.
  if (config.ARRENDADOR_CHAT_ID && config.ARRENDADOR_CHAT_ID !== ctx.chat?.id) {
    const de = ctx.from ? `${ctx.from.first_name} ${ctx.from.last_name ?? ''} (@${ctx.from.username ?? 'sin usuario'})` : '';
    await bot.api.sendMessage(config.ARRENDADOR_CHAT_ID, `📄 Nuevo contrato generado por ${de.trim()}`);
    const copia = contrato.pdf ?? contrato.docx;
    const ext = contrato.pdf ? 'pdf' : 'docx';
    await bot.api.sendDocument(config.ARRENDADOR_CHAT_ID, new InputFile(copia, `${contrato.nombreBase}.${ext}`));
  }
}

bot.command(['start', 'nuevo'], async (ctx) => {
  const session = await sesiones.reset(ctx.chat.id);
  console.log(`[chat ${ctx.chat.id}] /${ctx.message?.text?.slice(1)} de ${ctx.from?.username ?? ctx.from?.id}`);
  if (!session.consentimiento) return pedirConsentimiento(ctx);
  await conversar(ctx, session, 'Quiero generar un nuevo contrato de arrendamiento.');
});

bot.command('cancelar', async (ctx) => {
  await sesiones.reset(ctx.chat.id);
  await ctx.reply('Listo, borré los datos de esta conversación. Escribe /nuevo cuando quieras empezar otra vez.');
});

bot.callbackQuery('acepto_datos', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup();
  const session = await sesiones.get(ctx.chat!.id);
  session.consentimiento = true;
  await conversar(ctx, session, 'Autorizo el tratamiento de mis datos. Quiero generar mi contrato de arrendamiento.');
});

bot.callbackQuery('rechazo_datos', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup();
  await ctx.reply('Entendido. Sin esa autorización no puedo generar el contrato. Si cambias de opinión, escribe /start.');
});

bot.on('message:text', async (ctx) => {
  const session = await sesiones.get(ctx.chat.id);
  if (!session.consentimiento) return pedirConsentimiento(ctx);
  await conversar(ctx, session, ctx.message.text);
});

bot.on('message', (ctx) => ctx.reply('Por ahora solo entiendo mensajes de texto 🙂'));

bot.catch((err) => console.error('Error no controlado:', err.error));

await bot.api.setMyCommands([
  { command: 'nuevo', description: 'Generar un contrato nuevo' },
  { command: 'cancelar', description: 'Borrar los datos de esta conversación' },
]);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

console.log('Bot iniciado (long polling)…');
await bot.start();
