#!/usr/bin/env python3
"""TIFF test dosyalarını GERÇEK libtiff (Pillow + tiffcp) ile üretir.

Her TIFF için her sayfanın beklenen görünümü Pillow/libtiff ile çözülüp
`<ad>.p<N>.png` olarak yazılır: uygulamanın TIFF okuyucusu BAĞIMSIZ bir
kaynağa karşı doğrulanır. Dosyalar depoya girer (CI'da Python yoktur);
yeniden üretmek için:  python3 tests/fixtures/tiff/build-tiff-fixtures.py
"""
import os, struct, subprocess, random
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(OUT, '_tmp')
os.makedirs(TMP, exist_ok=True)
A4_200 = (1654, 2339)


def page_bw(seed, size=A4_200):
    """Resmî evrak benzeri siyah-beyaz sayfa: başlık, satırlar, çerçeve, mühür."""
    im = Image.new('1', size, 1)
    d = ImageDraw.Draw(im)
    w, h = size
    d.rectangle([60, 60, w - 60, h - 60], outline=0, width=4)
    d.text((w // 3, 120), f'T.C. ANKARA {seed}. ASLIYE HUKUK MAHKEMESI', fill=0)
    rnd = random.Random(seed)
    y = 260
    while y < h - 300:
        d.line([(120, y), (120 + rnd.randint(w // 4, w - 300), y)], fill=0, width=2)
        y += 38
    d.ellipse([w - 520, h - 520, w - 180, h - 180], outline=0, width=6)   # mühür
    d.rectangle([140, 140, 220, 220], fill=0)                             # sol üst işaret
    return im


def page_color(seed, size=(600, 800), mode='RGB'):
    im = Image.new('RGB', size, (250, 248, 240))
    d = ImageDraw.Draw(im)
    rnd = random.Random(seed)
    for i in range(0, size[1], 8):
        d.line([(0, i), (size[0], i)], fill=(240 - i // 8, 230, 200 + (i // 16) % 50))
    d.rectangle([20, 20, 120, 120], fill=(200, 20, 20))                   # sol üst kırmızı işaret
    d.ellipse([size[0] - 220, size[1] - 220, size[0] - 40, size[1] - 40], outline=(20, 40, 160), width=8)
    for k in range(30):
        d.text((40, 160 + k * 20), f'Satir {k} {rnd.random():.5f}', fill=(10, 10, 10))
    return im.convert(mode)


def expected(tif, name):
    im = Image.open(tif)
    n = 0
    while True:
        try:
            im.seek(n)
        except EOFError:
            break
        frame = im.convert('RGB') if im.mode not in ('1', 'L') else im.convert('L')
        frame.save(os.path.join(OUT, f'{name}.p{n + 1}.png'))
        n += 1


def tiffcp(args, src, dst):
    subprocess.run(['tiffcp', *args, src, dst], check=True)


def set_tag_short(path, tag, value):
    """İlk IFD'de SHORT bir etiketin değerini yerinde değiştirir (II/MM)."""
    b = bytearray(open(path, 'rb').read())
    e = '<' if b[:2] == b'II' else '>'
    off = struct.unpack(e + 'I', b[4:8])[0]
    while off:
        n = struct.unpack(e + 'H', b[off:off + 2])[0]
        for i in range(n):
            p = off + 2 + i * 12
            t, typ = struct.unpack(e + 'HH', b[p:p + 4])
            if t == tag:
                b[p + 8:p + 10] = struct.pack(e + 'H', value)
        off = struct.unpack(e + 'I', b[off + 2 + n * 12: off + 6 + n * 12])[0]
    open(path, 'wb').write(bytes(b))


def build():
    made = []
    def done(name, path):
        expected(path, name)
        made.append(name)

    # 1) G4, 2 sayfa, çok şeritli (Pillow varsayılanı), min-is-black
    p = os.path.join(OUT, 'g4-2sayfa.tif')
    page_bw(1).save(p, compression='group4', dpi=(200, 200), save_all=True, append_images=[page_bw(2)])
    done('g4-2sayfa', p)

    # 2) G4, TEK şerit (bayt bayt aktarım yolu), min-is-white (faks standardı)
    src = os.path.join(TMP, 'bw.tif'); page_bw(3).save(src, compression='group4', dpi=(200, 200))
    p = os.path.join(OUT, 'g4-tekserit-miniswhite.tif')
    tiffcp(['-c', 'g4', '-r', '100000'], src, p)
    set_tag_short(p, 262, 0)
    done('g4-tekserit-miniswhite', p)

    # 3) G4, tek şerit, FillOrder 2 (LSB önce)
    p = os.path.join(OUT, 'g4-fillorder2.tif')
    tiffcp(['-c', 'g4', '-r', '100000', '-f', 'lsb2msb'], src, p)
    done('g4-fillorder2', p)

    # 4) G3 1D ve 2D (faks)
    for name, comp in [('g3-1d', 'g3'), ('g3-2d', 'g3:2d')]:
        p = os.path.join(OUT, f'{name}.tif')
        tiffcp(['-c', comp], src, p)
        done(name, p)

    # 5) Renkli LZW + yatay tahmin (predictor 2), çok şerit
    src = os.path.join(TMP, 'rgb.tif'); page_color(4).save(src, dpi=(150, 150))
    p = os.path.join(OUT, 'lzw-rgb.tif'); tiffcp(['-c', 'lzw:2'], src, p); done('lzw-rgb', p)

    # 6) Gri Deflate + predictor 2, santimetre çözünürlük birimi
    src = os.path.join(TMP, 'gray.tif')
    # Çözünürlük birimi SANTİMETRE: 118,11 piksel/cm = 300 DPI
    page_color(5, mode="L").save(src, resolution=118.11, resolution_unit='cm')
    p = os.path.join(OUT, 'zip-gri-cm.tif'); tiffcp(['-c', 'zip:2'], src, p)
    done('zip-gri-cm', p)

    # 7) Siyah-beyaz PackBits
    src = os.path.join(TMP, 'bw-small.tif'); page_bw(6, (800, 1100)).save(src, dpi=(100, 100))
    p = os.path.join(OUT, 'packbits-sb.tif'); tiffcp(['-c', 'packbits'], src, p); done('packbits-sb', p)

    # 8) Paletli, sıkıştırmasız
    p = os.path.join(OUT, 'palet.tif')
    page_color(7).convert('P', palette=Image.ADAPTIVE, colors=64).save(p, dpi=(150, 150))
    done('palet', p)

    # 9) JPEG (YCbCr): çok şerit ve tek şerit
    src = os.path.join(TMP, 'rgb2.tif'); page_color(8, (640, 880)).save(src, dpi=(150, 150))
    p = os.path.join(OUT, 'jpeg-cokserit.tif'); tiffcp(['-c', 'jpeg:90', '-r', '64'], src, p); done('jpeg-cokserit', p)
    p = os.path.join(OUT, 'jpeg-tekserit.tif'); tiffcp(['-c', 'jpeg:90', '-r', '100000'], src, p); done('jpeg-tekserit', p)

    # 10) CMYK LZW
    p = os.path.join(OUT, 'cmyk-lzw.tif')
    cmyk = page_color(9).convert('CMYK')
    cmyk.save(p, compression='tiff_lzw', dpi=(150, 150))
    # CMYK'yi RGB'ye çevirmenin tek doğru yolu yok (pdf.js ile Pillow farklı
    # çevirir); beklenti HAM CMYK örnekleridir (zlib ile sıkıştırılmış).
    import zlib
    open(os.path.join(OUT, 'cmyk-lzw.p1.cmyk.z'), 'wb').write(zlib.compress(cmyk.tobytes(), 9))
    made.append('cmyk-lzw')

    # 11) Yön etiketi 6 (90° saat yönünde göster)
    p = os.path.join(OUT, 'yon6.tif')
    page_color(10, (800, 600)).save(p, compression='tiff_lzw', dpi=(150, 150), tiffinfo={274: 6})
    made.append('yon6')     # Pillow yönü uygulamaz; beklenti testte ayrıca kurulur

    # 12) Faks çözünürlüğü: kare olmayan piksel (204 x 98 DPI)
    p = os.path.join(OUT, 'faks-204x98.tif')
    page_bw(11, (1728, 1100)).save(p, compression='group4', dpi=(204, 98))
    made.append('faks-204x98')

    # 13) Desteklenmeyen: döşemeli (tiled) ve şeffaf (alfa kanallı)
    p = os.path.join(OUT, 'desteklenmez-doseme.tif')
    tiffcp(['-c', 'lzw', '-t'], os.path.join(TMP, 'rgb.tif'), p)
    p = os.path.join(OUT, 'desteklenmez-alfa.tif')
    page_color(12).convert('RGBA').save(p, compression='tiff_lzw', dpi=(150, 150))

    for f in os.listdir(TMP):
        os.remove(os.path.join(TMP, f))
    os.rmdir(TMP)
    print('üretildi:', ', '.join(made))


if __name__ == '__main__':
    build()
