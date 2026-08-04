/**
 * Публикация каталога из админ-панели.
 *
 *   POST /api/publish  { password, catalog, snapshot? }
 *
 * Что происходит:
 *   1. Проверяется пароль (только переменная окружения ADMIN_PASSWORD,
 *      в браузер и в файлы сайта он не попадает).
 *   2. Каталог пишется в Netlify Blobs. Предыдущая версия сохраняется рядом
 *      как catalog-prev — на один шаг назад.
 *   3. Сбрасывается CDN-кеш тега `catalog`, чтобы правки были видны сразу.
 *
 * Сборка сайта при этом НЕ запускается — именно за неё Netlify берёт кредиты.
 *
 * Если передать snapshot: true, каталог дополнительно коммитится в GitHub.
 * Это уже вызовет сборку, поэтому по умолчанию выключено — нужно только
 * когда хочется зафиксировать состояние в репозитории.
 *
 * Переменные окружения:
 *   ADMIN_PASSWORD — обязательна
 *   GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH — нужны только для snapshot
 */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { purgeCache } from '@netlify/functions';

const STORE_NAME = 'noquelle';
const KEY = 'catalog';
const PREV_KEY = 'catalog-prev';
const FILE = 'catalog.json';
const MAX_BYTES = 8 * 1024 * 1024;

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

/** Необязательный снимок в git. Вызывает сборку, поэтому только по просьбе. */
async function commitToGithub(content, productCount) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'kayokin25/noquelle-orders';
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token) return { ok: false, error: 'GITHUB_TOKEN не задан' };

  const api = `https://api.github.com/repos/${repo}/contents/${FILE}`;
  const gh = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'noquelle-admin',
        ...(init.headers || {}),
      },
    });

  let sha;
  const cur = await gh(`${api}?ref=${encodeURIComponent(branch)}`);
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status !== 404) return { ok: false, error: `GitHub ответил ${cur.status} при чтении` };

  const res = await gh(api, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Снимок каталога из панели: ${productCount} товаров`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) return { ok: false, error: `GitHub не принял запись (${res.status})` };
  const out = await res.json();
  return { ok: true, commit: out.commit && out.commit.sha ? out.commit.sha.slice(0, 7) : null };
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
    return json(401, { error: 'Неверный пароль публикации' });
  }

  // Не даём затереть каталог пустышкой.
  const catalog = payload.catalog;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return json(400, { error: 'Каталог не передан' });
  }
  if (!catalog.shop || typeof catalog.shop !== 'object') {
    return json(400, { error: 'В каталоге нет блока shop — публикация отменена' });
  }
  if (!Array.isArray(catalog.products) || catalog.products.length === 0) {
    return json(400, { error: 'В каталоге нет товаров — публикация отменена' });
  }
  if (catalog.products.some((p) => !p || !p.id)) {
    return json(400, { error: 'У какого-то товара нет id — публикация отменена' });
  }

  // Пароль проверяется на сервере, в каталоге ему не место.
  if ('adminPass' in catalog.shop) delete catalog.shop.adminPass;

  const content = JSON.stringify(catalog, null, 2) + '\n';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) {
    return json(413, {
      error: `Каталог слишком большой (${(bytes / 1048576).toFixed(1)} МБ). ` +
        'Скорее всего в нём фото, вставленные файлом — их лучше положить в папку img/.',
    });
  }

  let store;
  try {
    store = getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch (e) {
    return json(500, { error: 'Хранилище недоступно', detail: String(e.message || e) });
  }

  // Один шаг назад: перед перезаписью откладываем текущую версию.
  try {
    const prev = await store.get(KEY);
    if (prev) await store.set(PREV_KEY, prev);
  } catch (e) { /* нет предыдущей версии — не страшно */ }

  const updatedAt = new Date().toISOString();
  try {
    await store.setJSON(KEY, catalog, { metadata: { updatedAt, products: catalog.products.length } });
  } catch (e) {
    return json(502, { error: 'Не удалось записать каталог', detail: String(e.message || e) });
  }

  // Чтобы правки увидели сразу, а не через пять минут.
  let purged = true;
  try {
    await purgeCache({ tags: ['catalog'] });
  } catch (e) {
    purged = false;   // не критично: кеш всё равно истечёт сам
  }

  const result = { ok: true, products: catalog.products.length, bytes, updatedAt, purged, build: false };

  if (payload.snapshot === true) {
    const snap = await commitToGithub(content, catalog.products.length);
    result.snapshot = snap;
    result.build = snap.ok;   // коммит запустит сборку
  }

  return json(200, result);
};
