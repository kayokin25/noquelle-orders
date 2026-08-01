/**
 * Проверка пароля админ-панели.
 *
 * Панель шлёт POST /api/unlock  { password } и получает 200 либо 401.
 * Сам пароль лежит только в переменной окружения ADMIN_PASSWORD на Netlify —
 * ни в исходнике сайта, ни в catalog.json его нет, подсмотреть нечего.
 *
 * Это тот же пароль, которым потом публикуется каталог: ввела один раз при
 * входе — публикация уже не спросит.
 */
const crypto = require('crypto');

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
  if (!expected) return json(500, { error: 'На сервере не задан ADMIN_PASSWORD' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Тело запроса не похоже на JSON' });
  }

  // Небольшая задержка, чтобы перебор паролей был совсем невыгодным.
  await new Promise((r) => setTimeout(r, 250));

  if (!passwordMatches(body.password || '', expected)) {
    return json(401, { error: 'Неверный пароль' });
  }
  return json(200, { ok: true });
};
