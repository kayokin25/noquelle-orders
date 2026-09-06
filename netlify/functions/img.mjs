/**
 * Отдаёт фото, залитые через панель.
 *
 *   GET /api/img/<хеш>.webp        — полный размер (до 1400px)
 *   GET /api/img/<хеш>@480.webp    — превью для карточки
 *
 * Имя — хеш содержимого, значит по этому адресу картинка никогда не изменится.
 * Поэтому кешируем её на год и на CDN, и на устройстве: функция дёргается один
 * раз на регион, дальше отдаёт край сети.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'noquelle-img';
const TYPES = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
const NAME = /^[0-9a-f]{16}(@480)?\.(webp|jpg|png)$/;

export default async (req) => {
  const name = decodeURIComponent(new URL(req.url).pathname.split('/').pop() || '');
  if (!NAME.test(name)) return new Response('Не то имя файла', { status: 400 });

  let bytes;
  try {
    // strong: карточка показывает фото сразу после заливки, обычной
    // консистентности на это не хватает — картинка успевает мигнуть 404.
    const store = getStore({ name: STORE_NAME, consistency: 'strong' });
    bytes = await store.get(name, { type: 'arrayBuffer' });
  } catch (e) {
    return new Response('Хранилище недоступно', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  // Промах не кешируем: иначе опечатка или гонка застрянут на год.
  if (!bytes) return new Response('Нет такого фото', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  return new Response(bytes, {
    headers: {
      'Content-Type': TYPES[name.split('.').pop()],
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Netlify-CDN-Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
