import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Bot, InlineKeyboard, InputFile, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { Bitacora, extractorConBitacora, lectorConBitacora, limpiar } from './bitacora.js';

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: 'Bot',
  username: 'contratos_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe; // solo lo que usa el bot en la prueba
const USUARIO = { id: 42, is_bot: false, first_name: 'Ana' };
const CHAT = { id: 42, type: 'private' as const, first_name: 'Ana' };

/** Telegram simulado: responde sin red y asigna message_id consecutivos. */
function telegramFalso(): Transformer {
  let id = 100;
  return async (_prev, metodo) => {
    if (metodo === 'sendMessage' || metodo === 'sendDocument') {
      return { ok: true, result: { message_id: ++id, date: 0, chat: CHAT } } as never;
    }
    return { ok: true, result: true } as never;
  };
}

const leerEventos = async (dir: string) => {
  const [archivo] = await readdir(dir);
  const lineas = (await readFile(join(dir, archivo!), 'utf8')).trim().split('\n');
  return { archivo, eventos: lineas.map((l) => JSON.parse(l) as Record<string, any>) };
};

test('registra actualización, IA, salidas, estado y errores con su contexto', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitacora-'));
  try {
    // 4 oct 2026 a las 03:00 UTC = 3 oct 2026 en Bogotá: el archivo lleva la fecha local.
    const bitacora = new Bitacora(dir, 'America/Bogota', () => new Date('2026-10-04T03:00:00Z'));
    const lector = lectorConBitacora({ leer: async () => ({ nombre: 'ANA RUIZ', numero: '52123456', tipo: 'CC' as const }) }, bitacora);
    const extractor = extractorConBitacora({ extraer: async () => ({ precio_mensual: 750_000 }) }, bitacora);

    const bot = new Bot('123:abc', { botInfo: BOT_INFO });
    bot.api.config.use(telegramFalso());
    bot.api.config.use(bitacora.transformador()); // el último instalado envuelve a los anteriores
    let paso = 'inicio';
    bot.use(bitacora.middleware(async () => ({ paso, datos: { precio_mensual: 750_000 }, inventario: {} })));

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text === 'falla') throw new Error('se cayó');
      await ctx.replyWithChatAction('typing'); // no aporta: no se registra
      const leido = await lector.leer(Buffer.alloc(10), 'image/jpeg');
      await extractor.extraer(ctx.message.text, { hoy: '2026-10-03', edificios: [] });
      await ctx.reply(`Hola ${leido.nombre}`, { reply_markup: new InlineKeyboard().text('✅ Sí', 'resumen:generar') });
      await ctx.replyWithDocument(new InputFile(Buffer.from('pdf'), 'Contrato.pdf'));
      paso = 'resumen';
    });

    const mensaje = (update_id: number, text: string): Update => ({
      update_id,
      message: { message_id: 1, date: 0, chat: CHAT, from: USUARIO, text },
    });
    await bot.handleUpdate(mensaje(7, '750 mil'));
    await assert.rejects(bot.handleUpdate(mensaje(8, 'falla')));
    await bitacora.vaciar();

    const { archivo, eventos } = await leerEventos(dir);
    assert.equal(archivo, '2026-10-03.jsonl');
    assert.deepEqual(
      eventos.map((e) => `${e.update_id}:${e.tipo}${e.servicio ? `:${e.servicio}` : ''}${e.metodo ? `:${e.metodo}` : ''}`),
      [
        '7:actualizacion',
        '7:ia:lector',
        '7:ia:extractor',
        '7:salida:sendMessage',
        '7:salida:sendDocument',
        '7:estado',
        '8:actualizacion',
        '8:error',
        '8:estado',
      ],
    );

    const [actualizacion, lectura, extraccion, texto, documento, estado] = eventos;
    for (const e of eventos) {
      assert.equal(e.v, 1);
      assert.equal(e.ts, '2026-10-04T03:00:00.000Z');
      assert.equal(e.chat, 42);
      assert.equal(e.usuario, 42);
    }
    assert.equal(actualizacion!.update.message.text, '750 mil', 'la actualización completa, tal como llegó');
    assert.deepEqual(lectura!.entrada, { tipo: 'image/jpeg', bytes: 10 }, 'de la foto solo el tamaño, no la imagen');
    assert.deepEqual(lectura!.resultado, { nombre: 'ANA RUIZ', numero: '52123456', tipo: 'CC' });
    assert.equal(extraccion!.entrada.texto, '750 mil');
    assert.deepEqual(extraccion!.resultado, { precio_mensual: 750_000 });
    assert.equal(texto!.payload.text, 'Hola ANA RUIZ');
    assert.deepEqual(texto!.payload.reply_markup.inline_keyboard, [[{ text: '✅ Sí', callback_data: 'resumen:generar' }]]);
    assert.deepEqual(texto!.resultado, { message_id: 101 }, 'el message_id enlaza ediciones y botones posteriores');
    assert.deepEqual(documento!.payload.document, { archivo: 'Contrato.pdf' }, 'el archivo solo por nombre');
    assert.equal(estado!.paso, 'resumen');
    assert.deepEqual(estado!.datos, { precio_mensual: 750_000 });
    assert.equal(eventos[7]!.mensaje, 'se cayó');
    assert.match(eventos[7]!.pila, /Error: se cayó/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registrar no falla aunque no se pueda escribir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitacora-'));
  try {
    // La "carpeta" de logs es en realidad un archivo: escribir falla, pero registrar no lanza error.
    const noEsCarpeta = join(dir, 'no-soy-carpeta');
    await writeFile(noEsCarpeta, 'x');
    await assert.doesNotReject(new Bitacora(noEsCarpeta).registrar({ tipo: 'arranque', modelo: 'm', usuarios: 1 }));
    assert.equal(await readFile(noEsCarpeta, 'utf8'), 'x', 'no se tocó');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('limpiar: archivos y buffers solo por nombre o tamaño', () => {
  assert.deepEqual(
    limpiar({ chat_id: 1, document: new InputFile(Buffer.from('x'), 'a.docx'), extra: [Buffer.alloc(3), { ok: true }] }),
    { chat_id: 1, document: { archivo: 'a.docx' }, extra: [{ bytes: 3 }, { ok: true }] },
  );
});
