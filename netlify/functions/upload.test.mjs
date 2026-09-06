/**
 * Проверка разбора и раскладки фото.  Запуск:  node netlify/functions/upload.test.mjs
 *
 * Хранилище подставное, Netlify не нужен: именно на таком прогоне ловятся
 * ошибки логики, ради которых иначе пришлось бы жечь сборки.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodeDataUrl, storeImage } from './upload.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const url = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;

// разбор
assert.equal(decodeDataUrl('привет'), 'это не картинка строкой data:');
assert.match(decodeDataUrl(url('image/tiff', png)), /не поддерживается/);
assert.match(decodeDataUrl(url('image/webp', Buffer.alloc(3 * 1024 * 1024))), /тяжелее/);
assert.deepEqual(decodeDataUrl(url('image/webp', png)), { bytes: png, ext: 'webp' });
assert.equal(decodeDataUrl(url('IMAGE/JPEG', png)).ext, 'jpg', 'регистр mime не должен мешать');

// раскладка: имя — хеш содержимого, превью ложится рядом
const fake = () => {
  const kept = new Map();
  return { kept, set: async (k, v) => void kept.set(k, v) };
};
const hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);

let s = fake();
let out = await storeImage(s, url('image/webp', png), url('image/webp', png));
assert.equal(out, `/api/img/${hash}.webp`);
assert.deepEqual([...s.kept.keys()].sort(), [`${hash}.webp`, `${hash}@480.webp`]);

// то же фото второй раз — тот же адрес, лишних ключей не появляется
s = fake();
await storeImage(s, url('image/webp', png), null);
await storeImage(s, url('image/webp', png), null);
assert.deepEqual([...s.kept.keys()], [`${hash}.webp`]);

// битое превью не роняет заливку полного размера
s = fake();
out = await storeImage(s, url('image/webp', png), 'мусор');
assert.equal(out, `/api/img/${hash}.webp`);
assert.deepEqual([...s.kept.keys()], [`${hash}.webp`]);

// битое основное фото — это ошибка, молча глотать нельзя
await assert.rejects(() => storeImage(fake(), 'мусор', null));

// адрес должен проходить проверку имени из img.mjs
assert.match(out.split('/').pop(), /^[0-9a-f]{16}(@480)?\.(webp|jpg|png)$/);

console.log('upload: все проверки прошли');
