/**
 * Учёт проданного — чтобы на карточках было живое «Осталось N шт».
 *
 *   GET  /api/stock  → { ok, sold: { <id>: { sold, stockAt } } }
 *   POST /api/stock  → { items: [ { id, qty, stockAt } ] } — прибавляет проданное
 *
 * Формат Netlify Functions v2 (export default). Это важно: только в v2 Netlify
 * прокидывает в функцию контекст Blobs. В классическом формате (exports.handler)
 * хранилище недоступно и требует ручной настройки токена — проверено на живом сайте.
 *
 * Google Apps Script этот код НЕ трогает. Сайт дёргает /api/stock отдельным
 * запросом, параллельно с обычной отправкой заказа. Если запрос не дойдёт —
 * заказ всё равно уйдёт продавцу как раньше, просто счётчик не сдвинется.
 *
 * Как считается остаток (арифметика на стороне сайта):
 *   остаток = stock из catalog.json − sold
 * Поле stockAt — значение stock на момент последнего сброса счётчика. Если в
 * панели поменять цифру, stockAt перестанет совпадать и счётчик обнулится:
 * то есть «вписала новое число» = «пополнила склад».
 * Правило для продавца одно: вписывай то, что физически лежит на полке.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'noquelle';   // общий store с каталогом
const KEY = 'sold';
const MAX_QTY = 99;        // разумный предел на одну позицию
const MAX_ITEMS = 60;      // и на количество позиций в заказе
const MAX_SOLD = 1000000;

const json = (status, body, cacheable) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Чтение остатков кешируем ненадолго, чтобы CDN отвечал сам и не тратил
      // вызовы функции на каждый заход. Покупатель после своего заказа видит
      // свежие цифры сразу — они приходят в ответе на POST.
      'Cache-Control': cacheable ? 'public, max-age=30' : 'no-store',
      ...(cacheable
        ? { 'Netlify-CDN-Cache-Control': 'public, max-age=60, stale-while-revalidate=120' }
        : {}),
    },
  });

async function readSold(store) {
  try {
    const data = await store.get(KEY, { type: 'json' });
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {}; // ключа ещё нет — значит ничего не продано
  }
}

export default async (req) => {
  let store;
  try {
    // consistency: 'strong' обязательно. По умолчанию Blobs читает из
    // регионального кеша (eventual), и тогда счётчик теряет инкременты:
    // read-modify-write может прочитать устаревшее значение. Проверено на
    // живом сайте — с настройками по умолчанию запись «пропадала».
    store = getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch (e) {
    return json(500, { error: 'Хранилище остатков недоступно', detail: String(e.message || e) });
  }

  if (req.method === 'GET') {
    return json(200, { ok: true, sold: await readSold(store) }, true);
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Нужен GET или POST' });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: 'Тело запроса не похоже на JSON' });
  }

  const raw = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const items = [];
  for (const it of raw) {
    if (!it || typeof it.id !== 'string' || !it.id.trim()) continue;
    const qty = Math.floor(Number(it.qty));
    const stockAt = Math.floor(Number(it.stockAt));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) continue;
    if (!Number.isFinite(stockAt) || stockAt < 0) continue;
    items.push({ id: it.id.trim().slice(0, 64), qty, stockAt });
  }
  if (!items.length) return json(400, { error: 'Ни одной корректной позиции' });

  // Читаем-меняем-пишем. Два одновременных заказа теоретически могут затереть
  // друг другу инкремент; при здешних объёмах это пренебрежимо, а лечится
  // просто — заново вписать в панели фактический остаток.
  const data = await readSold(store);
  for (const it of items) {
    let rec = data[it.id];
    if (!rec || typeof rec !== 'object' || Number(rec.stockAt) !== it.stockAt) {
      rec = { sold: 0, stockAt: it.stockAt };   // цифру в панели меняли → пополнение
    }
    rec.sold = Math.min(MAX_SOLD, (Number(rec.sold) || 0) + it.qty);
    data[it.id] = rec;
  }

  try {
    await store.setJSON(KEY, data);
  } catch (e) {
    return json(502, { error: 'Не удалось записать остатки', detail: String(e.message || e) });
  }

  return json(200, { ok: true, sold: data });
};
