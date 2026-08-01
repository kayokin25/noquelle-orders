/**
 * Публикация каталога из админ-панели.
 *
 * Панель шлёт POST /api/publish  { password, catalog }.
 * Функция проверяет пароль (он лежит только в переменных окружения Netlify,
 * в браузер не попадает) и коммитит catalog.json в GitHub. Netlify видит
 * новый коммит и пересобирает сайт сам.
 *
 * Переменные окружения (Netlify → Site configuration → Environment variables):
 *   ADMIN_PASSWORD — пароль публикации
 *   GITHUB_TOKEN   — fine-grained токен с правом Contents: Read and write на этот репозиторий
 *   GITHUB_REPO    — необязательно, по умолчанию kayokin25/noquelle-orders
 *   GITHUB_BRANCH  — необязательно, по умолчанию main
 */
const crypto = require('crypto');

const REPO = process.env.GITHUB_REPO || 'kayokin25/noquelle-orders';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE = 'catalog.json';
const MAX_BYTES = 8 * 1024 * 1024; // GitHub Contents API не любит очень большие файлы

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

/** Сравнение без утечки времени: разная длина — сразу мимо. */
function passwordMatches(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Нужен POST' });

  const expected = process.env.ADMIN_PASSWORD;
  const token = process.env.GITHUB_TOKEN;
  if (!expected || !token) {
    return json(500, { error: 'На сервере не заданы ADMIN_PASSWORD и/или GITHUB_TOKEN' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Тело запроса не похоже на JSON' });
  }

  if (!passwordMatches(payload.password || '', expected)) {
    return json(401, { error: 'Неверный пароль публикации' });
  }

  // Не даём случайно затереть каталог пустышкой.
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

  const content = JSON.stringify(catalog, null, 2) + '\n';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) {
    return json(413, {
      error: `Каталог слишком большой (${(bytes / 1048576).toFixed(1)} МБ). ` +
        'Скорее всего в нём фото, вставленные файлом — их лучше положить в папку img/.',
    });
  }

  const api = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
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

  try {
    // Текущий sha нужен, чтобы GitHub понял, что мы перезаписываем, а не создаём.
    let sha;
    const cur = await gh(`${api}?ref=${encodeURIComponent(BRANCH)}`);
    if (cur.status === 200) {
      sha = (await cur.json()).sha;
    } else if (cur.status !== 404) {
      const detail = (await cur.text()).slice(0, 300);
      return json(502, { error: `GitHub ответил ${cur.status} при чтении ${FILE}`, detail });
    }

    const res = await gh(api, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Каталог из админ-панели: ${catalog.products.length} товаров`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      return json(502, { error: `GitHub не принял запись (${res.status})`, detail });
    }

    const out = await res.json();
    return json(200, {
      ok: true,
      products: catalog.products.length,
      bytes,
      commit: out.commit && out.commit.sha ? out.commit.sha.slice(0, 7) : null,
    });
  } catch (e) {
    return json(502, { error: 'Не получилось связаться с GitHub', detail: String(e.message || e) });
  }
};
