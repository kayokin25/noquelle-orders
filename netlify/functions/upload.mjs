/**
 * Приём фото из админ-панели.
 *
 *   POST /api/upload  { password, full, thumb }   — обе картинки строкой data:
 *   → { ok, url: '/api/img/<хеш>.webp' }
 *
 * Зачем отдельная ручка: раньше фото из файлового выбора уезжало в каталог
 * строкой base64. Пять таких фото раздули каталог до 2,4 МБ, и его целиком
 * качал каждый посетитель до отрисовки первого товара — на медленной мобильной
 * связи загрузка срывалась. Теперь в каталоге лежит только ссылка.
 *
 * Имя файла — хеш содержимого, поэтому одно и то же фото не хранится дважды,
 * а по готовой ссылке картинка уже никогда не поменяется (см. img.mjs).
 *
 * ponytail: удалённые из каталога фото остаются в хранилище навсегда. Место в
 * Blobs дешёвое, а сборщик мусора пришлось бы сверять с каталогом и с archive,
 * и он умеет стереть то, что ещё используется. Понадобится — обход по каталогу
 * раз в месяц отдельной ручкой.
 */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'noquelle-img';
const MAX_BYTES = 2 * 1024 * 1024;
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** Сравнение без утечки времени: разная длина — сразу мимо. */
function passwordMatches(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/** data:image/webp;base64,… → { bytes, ext } либо строка с ошибкой. */
export function decodeDataUrl(value) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(value || ''));
  if (!m) return 'это не картинка строкой data:';
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) return `формат ${m[1]} не поддерживается`;
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return 'пустая картинка';
  if (bytes.length > MAX_BYTES) return `картинка тяжелее ${MAX_BYTES / 1048576} МБ`;
  return { bytes, ext };
}

/** Кладёт полный размер и превью, возвращает адрес полного. Хранилище — аргументом, чтобы это можно было прогнать без Netlify. */
export async function storeImage(store, full, thumb) {
  const big = decodeDataUrl(full);
  if (typeof big === 'string') throw new Error(big);
  const name = crypto.createHash('sha256').update(big.bytes).digest('hex').slice(0, 16) + '.' + big.ext;

  // Повторная заливка того же фото ничего не меняет — содержимое то же самое.
  await store.set(name, big.bytes);

  // Превью необязательно: без него карточка просто покажет полный размер.
  if (thumb) {
    const small = decodeDataUrl(thumb);
    if (typeof small !== 'string') await store.set(name.replace(/(\.\w+)$/, '@480$1'), small.bytes);
  }
  return '/api/img/' + name;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Нужен POST' });

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return json(500, { error: 'На сервере не задан ADMIN_PASSWORD' });

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json(400, { error: 'Тело запроса не похоже на JSON' });
  }
  if (!passwordMatches((payload && payload.password) || '', expected)) {
    return json(401, { error: 'Неверный пароль' });
  }

  try {
    const store = getStore({ name: STORE_NAME });
    const url = await storeImage(store, payload.full, payload.thumb);
    return json(200, { ok: true, url });
  } catch (e) {
    return json(400, { error: String(e.message || e) });
  }
};
