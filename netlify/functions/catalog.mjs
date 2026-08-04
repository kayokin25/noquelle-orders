/**
 * Отдаёт живой каталог из Netlify Blobs.
 *
 *   GET /api/catalog → { ok, catalog, updatedAt }  либо  { ok, catalog: null }
 *
 * Зачем: раньше каталог лежал в git, и каждая публикация из панели вызывала
 * сборку сайта — то есть тратила кредиты Netlify. Теперь публикация пишет
 * прямо в Blobs, сборки не происходит вообще.
 *
 * Если в хранилище пусто (например, сразу после первого деплоя и до первой
 * публикации), возвращаем catalog: null — сайт тогда возьмёт статический
 * catalog.json из репозитория. Он же остаётся аварийным запасом на случай,
 * если функции недоступны.
 *
 * Экономия вызовов: ответ кешируется на CDN и помечен тегом `catalog`.
 * После публикации функция публикации сбрасывает этот тег, поэтому правки
 * видны сразу, а вызовов функции всё равно немного.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'noquelle';
const KEY = 'catalog';

export default async () => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    // Кеш держит CDN, а не браузер: так после сброса тега все видят свежее.
    'Netlify-CDN-Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    'Netlify-Cache-Tag': 'catalog',
  };

  try {
    // strong: сразу после публикации нужно отдать именно новую версию,
    // иначе региональный кеш Blobs может подсунуть предыдущую.
    const store = getStore({ name: STORE_NAME, consistency: 'strong' });
    const res = await store.getWithMetadata(KEY, { type: 'json' });
    if (!res || !res.data) {
      return new Response(JSON.stringify({ ok: true, catalog: null, source: 'empty' }), { headers });
    }
    return new Response(JSON.stringify({
      ok: true,
      catalog: res.data,
      updatedAt: (res.metadata && res.metadata.updatedAt) || null,
      source: 'blobs',
    }), { headers });
  } catch (e) {
    // Хранилище недоступно — пусть сайт падает на статический catalog.json.
    return new Response(JSON.stringify({
      ok: false,
      catalog: null,
      error: String(e.message || e),
    }), { status: 200, headers: { ...headers, 'Netlify-CDN-Cache-Control': 'no-store' } });
  }
};
