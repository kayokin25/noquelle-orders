// Эксперимент: та же задача, но в формате Netlify Functions v2.
// Проверяем, прокидывается ли в v2 контекст Netlify Blobs — тогда никаких
// дополнительных токенов настраивать не нужно. Файл временный.
import { getStore } from '@netlify/blobs';

export default async (req) => {
  const body = {
    format: 'functions-v2',
    node: process.version,
    hasBlobsContext: !!process.env.NETLIFY_BLOBS_CONTEXT,
  };
  try {
    const store = getStore('noquelle-stock');
    await store.set('__diag2', 'ok');
    body.blobs = (await store.get('__diag2')) === 'ok' ? 'РАБОТАЕТ' : 'странный ответ';
  } catch (e) {
    body.blobs = 'ошибка: ' + String(e.message || e).slice(0, 140);
  }
  return new Response(JSON.stringify(body, null, 1), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};
