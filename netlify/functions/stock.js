/**
 * Учёт проданного — чтобы на карточках было живое «Осталось N шт».
 *
 *   GET  /api/stock  → { ok, sold: { <id>: { sold, stockAt } } }
 *   POST /api/stock  → { items: [ { id, qty, stockAt } ] } — прибавляет проданное
 *
 * Google Apps Script этот код НЕ трогает. Сайт дёргает /api/stock отдельным
 * запросом, параллельно с обычной отправкой заказа. Если запрос не дойдёт —
 * заказ всё равно уйдёт продавцу как раньше, просто счётчик не сдвинется.
 *
 * Как считается остаток (арифметика на стороне сайта):
 *   остаток = stock из catalog.json − sold
 * Поле stockAt — это значение stock на момент последнего сброса счётчика.
 * Если в панели поменять цифру, stockAt перестанет совпадать, и счётчик
 * обнулится: то есть «вписала новое число» = «пополнила склад».
 * Правило простое: вписывай то, что физически лежит на полке.
 *
 * Хранилище — Netlify Blobs, настраивается само, ничего задавать не нужно.
 */
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'noquelle-stock';
const KEY = 'sold';
const MAX_QTY = 99;      // разумный предел на одну позицию
const MAX_ITEMS = 60;    // и на количество позиций в заказе
const MAX_SOLD = 1000000;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

async function readSold(store) {
  try {
    const data = await store.get(KEY, { type: 'json' });
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {}; // ключа ещё нет — значит ничего не продано
  }
}

exports.handler = async (event) => {
  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (e) {
    return json(500, { error: 'Хранилище остатков недоступно', detail: String(e.message || e) });
  }

  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, sold: await readSold(store) });
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Нужен GET или POST' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Тело запроса не похоже на JSON' });
  }

  const raw = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
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
