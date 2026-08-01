"""
Готовит фото товара для сайта: делает две сжатые WebP-картинки.

    py compress-images.py <файл> <имя-без-расширения>

Пример:
    py compress-images.py "C:\\фото\\пудинг.png" p_pud3-0

Появятся:
    img/p_pud3-0.webp        — до 1400px, для лайтбокса
    img/p_pud3-0@480.webp    — до 480px, превью для карточки

Потом в админ-панели впиши в галерею товара  img/p_pud3-0.webp
— превью подставится автоматически.

Нужен Pillow:  py -m pip install pillow
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Не установлен Pillow. Поставь его:  py -m pip install pillow")

FULL_MAX = 1400
THUMB_MAX = 480
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "img")


def has_alpha(im):
    return im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1

    src, slug = argv[1], argv[2].strip()
    if not os.path.isfile(src):
        return f"Не нашёл файл: {src}"
    if not slug or "/" in slug or "\\" in slug:
        return "Имя должно быть простым, без слэшей. Например: p_new-0"
    if slug.lower().endswith(".webp"):
        slug = slug[:-5]

    os.makedirs(OUT_DIR, exist_ok=True)
    Image.MAX_IMAGE_PIXELS = None

    im = Image.open(src)
    im.load()
    alpha = has_alpha(im)
    im = im.convert("RGBA" if alpha else "RGB")
    quality = 82 if src.lower().endswith((".jpg", ".jpeg")) else 88

    print(f'{os.path.basename(src)}  {im.size[0]}x{im.size[1]}'
          f'{"  (с прозрачностью)" if alpha else ""}')

    for suffix, cap in (("", FULL_MAX), ("@480", THUMB_MAX)):
        out = os.path.join(OUT_DIR, f"{slug}{suffix}.webp")
        img = im.copy()
        img.thumbnail((cap, cap), Image.LANCZOS)   # не растягивает мелкие картинки
        img.save(out, "WEBP", quality=quality, method=6)
        print(f'  img/{slug}{suffix}.webp  {img.size[0]}x{img.size[1]}  '
              f'{os.path.getsize(out) // 1024} КБ')

    print(f'\nГотово. В галерею товара впиши:  img/{slug}.webp')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
