// Test fixture üreticisi — harici bağımlılık yok, yalnızca Node core + pdf-lib.
//
// Üretilen dosyalar .gitignore ile depoya girmez; `npm test` öncesi
// `npm run fixtures` ile yeniden üretilebilir. Üretim idempotenttir.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';

const OUT = join(dirname(fileURLToPath(import.meta.url)));

const A4 = [595.28, 841.89];
const A4_LANDSCAPE = [841.89, 595.28];
const A5 = [419.53, 595.28];
const LETTER = [612, 792];

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function write(name, bytes) {
    const target = join(OUT, name);
    writeFileSync(target, bytes);
    return { name, size: statSync(target).size };
}

// FlateDecode ham RGB bitmap'i gerçek bir Image XObject olarak sayfaya yerleştirir.
// Sıkıştırma modu 1'in (görsel yeniden kodlama) hedeflediği tam biçim budur.
async function drawRawImagePage(doc, width, height, pixels) {
    const page = doc.addPage([width, height]);
    const dict = doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode'
    });
    const stream = PDFRawStream.of(dict, deflateSync(pixels));
    const ref = doc.context.register(stream);
    const key = page.node.newXObject('Im0', ref);
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(width, 0, 0, height, 0, 0),
        drawObject(key),
        popGraphicsState()
    );
    return page;
}

// Taranmış belge taklidi: yumuşak gradyan + hafif gürültü.
// Saf rastgelelik JPEG ile iyi sıkıştırılmaz; gerçek tarayıcı görüntüsüne
// benzemesi için düşük frekanslı gradyan üzerine ölçülü gürültü eklenir.
function scanPixels(width, height, seed) {
    const px = Buffer.alloc(width * height * 3);
    let s = seed >>> 0;
    const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            const grad = ((x / width) * 0.45 + (y / height) * 0.35) * 255;
            const n = (rand() - 0.5) * 26;
            px[i] = Math.max(0, Math.min(255, Math.round(210 + grad * 0.25 + n)));
            px[i + 1] = Math.max(0, Math.min(255, Math.round(205 + grad * 0.22 + n)));
            px[i + 2] = Math.max(0, Math.min(255, Math.round(198 + grad * 0.18 + n)));
        }
    }
    return px;
}

async function textPdf(pages) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const p of pages) {
        const h = p.size[1];
        const page = doc.addPage(p.size);
        page.drawText(p.title, { x: 40, y: h - 70, size: 20, font, color: rgb(0, 0, 0) });
        page.drawText(p.body, { x: 40, y: h - 110, size: 11, font, color: rgb(0, 0, 0) });
    }
    return write(pages[0].name, await doc.save());
}

// ---------------------------------------------------------------------------
// RC4 — PDF Standart Güvenlik İşleyicisi (R=2, 40-bit)
// Node'un crypto modülü OpenSSL 3'te RC4'ü kaldırdığı için saf JS gerekir.
// ---------------------------------------------------------------------------

function rc4(key, data) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) & 0xff;
        [s[i], s[j]] = [s[j], s[i]];
    }
    let i = 0; j = 0;
    const out = Buffer.alloc(data.length);
    for (let n = 0; n < data.length; n++) {
        i = (i + 1) & 0xff;
        j = (j + s[i]) & 0xff;
        [s[i], s[j]] = [s[j], s[i]];
        out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
    }
    return out;
}

const PAD = Buffer.from([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56,
    0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

const padPassword = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

function computeO(ownerPw) {
    let key = createHash('md5').update(padPassword(ownerPw)).digest().subarray(0, 5);
    let out = rc4(key, PAD);
    for (let i = 1; i <= 19; i++) {
        const k = Buffer.alloc(5);
        for (let b = 0; b < 5; b++) k[b] = key[b] ^ i;
        out = rc4(k, out);
    }
    return out;
}

function computeFileKey(userPw, o, p) {
    const pBuf = Buffer.alloc(4);
    pBuf.writeInt32LE(p, 0);
    return createHash('md5')
        .update(Buffer.concat([padPassword(userPw), o, pBuf]))
        .digest()
        .subarray(0, 5);
}

// Şifreli tek sayfalık PDF, elle yazılır (pdf-lib şifreli PDF üretemez).
function buildEncryptedPdf(userPw = 'gizli', ownerPw = 'sahip') {
    const P = -1;
    const o = computeO(ownerPw);
    const key = computeFileKey(userPw, o, P);
    const u = rc4(key, PAD);
    const idHex = '0123456789ABCDEF0123456789ABCDEF';

    const plain = Buffer.from('BT /F1 18 Tf 40 700 Td (Sifreli Belge) Tj ET', 'latin1');
    const encContent = rc4(key, plain);

    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${encContent.length} >>\nstream\n${encContent.toString('latin1')}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex').toUpperCase()}> /U <${u.toString('hex').toUpperCase()}> /P ${P} >>`
    ];

    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
        out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

// Yarım kalmış indirme: geçerli bir PDF'in ilk yarısı. Sonu "bozuk dosya".
// pdf-lib bozuk xref'i onarabildiği için, nesne ağacının kesildiği bu varyant
// seçildi — rastgele baytlarla bozmak pdf-lib tarafından sessizce onarılıyor.
function buildCorruptPdf() {
    const src = readFileSync(join(OUT, 'text-only.pdf'));
    return src.subarray(0, Math.floor(src.length / 2));
}

// PDF uzantısı taşıyan ancak PDF olmayan dosya — kullanıcı yanlışlıkla
// Word/Excel dosyası sürüklediğinde karşılaşılan gerçek durum.
function buildNotAPdf() {
    const buf = Buffer.alloc(3072);
    let s = 0xC0FFEE;
    for (let i = 0; i < buf.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = (s >>> 16) & 0xff;
    }
    return buf;
}

// 0 sayfalık PDF. pdf-lib boş belgeyi kaydedemediği için elle yazılır.
function buildEmptyPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [] /Count 0 >>'
    ];
    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
        out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

// 60 MB'lık geçerli PDF: %%EOF sonrasına yorum satırları eklenir.
// Okuyucular %%EOF sonrasını yok sayar, dosya ayrıştırılabilir kalır ve
// uygulamanın boyut sınırını aşmak zorunda kalır.
function buildHugePdf(targetMb = 60) {
    const src = readFileSync(join(OUT, 'text-only.pdf'));
    const filler = Buffer.from(`%\n` + 'x'.repeat(998) + '\n', 'latin1');
    const parts = [src];
    const need = Math.ceil((targetMb * 1024 * 1024 - src.length) / filler.length);
    for (let i = 0; i < need; i++) parts.push(filler);
    return Buffer.concat(parts);
}


// ---------------------------------------------------------------------------
// Renk uzayı fixture'ları: ICCBased, Indexed, DeviceCMYK, SMask, ters Decode
// ---------------------------------------------------------------------------

/**
 * PDFArray içine karışık girdi koyar: metin -> /Name, sayı -> PDFNumber,
 * Uint8Array -> PDFHexString, PDFRef doğrudan.
 * (PDFArray.push yalnızca PDFObject kabul eder; ham sayı geçirilemez.)
 */
function mixedArray(doc, entries) {
    const array = PDFArray.withContext(doc.context);
    for (const entry of entries) {
        if (typeof entry === 'string') {
            // PDFName.of() '/' ÖNEKİNİ KENDİSİ ekler; '/ICCBased' verilirse ad
            // '/#2FICCBased' olur ve görüntüleyici için geçersizdir.
            array.push(PDFName.of(entry.replace(/^\//, '')));
        } else if (typeof entry === 'number') {
            array.push(doc.context.obj(entry));
        } else {
            array.push(entry);
        }
    }
    return array;
}

/** Bir sayfaya tek bir ham görsel yerleştirir. */
async function pageWithRawImage(doc, spec) {
    const page = doc.addPage(spec.size || A4);
    const dict = doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: spec.width,
        Height: spec.height,
        BitsPerComponent: spec.bits ?? 8
    });

    if (spec.colorSpace) dict.set(PDFName.of('ColorSpace'), spec.colorSpace(doc));
    // Varsayılan: FlateDecode. `filter: false` ham (sıkıştırılmamış) akış demektir.
    if (spec.filter !== false) dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    if (spec.decode) dict.set(PDFName.of('Decode'), doc.context.obj(spec.decode));
    if (spec.decodeParms) dict.set(PDFName.of('DecodeParms'), doc.context.obj(spec.decodeParms));
    if (spec.smask) dict.set(PDFName.of('SMask'), spec.smask);

    const payload = spec.filter === false ? spec.pixels : deflateSync(spec.pixels);
    const ref = doc.context.register(PDFRawStream.of(dict, payload));
    const key = page.node.newXObject('Im0', ref);
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(spec.width, 0, 0, spec.height, 0, 0),
        drawObject(key),
        popGraphicsState()
    );
    return page;
}

/**
 * Sıkıştırılamaz gürültü. LCG çok yapısal çıktı verir ve deflate onu küçültür;
 * bu yüzden xorshift32 kullanılır. Amaç: JPEG yeniden kodlaması gerçekten
 * kazanç göstersin ve fixture 20 KB eşiğinin belirgin üstünde olsun.
 */
function rgbPixels(width, height, seed) {
    const px = Buffer.alloc(width * height * 3);
    let s = (seed >>> 0) || 1;
    for (let i = 0; i < px.length; i++) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        px[i] = s & 0xff;
    }
    return px;
}

async function buildColorSpaceFixtures() {
    const W = 700, H = 900;

    // 1) ICCBased renk uzayı (tarayıcı/görüntü yazılımlarından gelen PDF'lerde yaygın)
    {
        const doc = await PDFDocument.create();
        // Geçerli görünen ama sahte bir ICC akışı (3 kanal).
        const icc = doc.context.register(PDFRawStream.of(
            doc.context.obj({ N: 3 }),
            Buffer.alloc(128, 0)
        ));
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: (d) => mixedArray(d, ['/ICCBased', icc]),
            pixels: rgbPixels(W, H, 11)
        });
        made.push(write('iccbased.pdf', await doc.save()));
    }

    // 2) Indexed (paletli) renk uzayı
    {
        const doc = await PDFDocument.create();
        // Palet PDF spec'ine göre bir AKIŞ olmalıdır. (Önceden
        // `context.obj(Uint8Array)` deniyordu; bu pdf-lib sürümünde
        // Uint8Array -> PDFDict'e çevriliyor ve palet bozuk bir sözlük
        // olarak yazılıyordu. `asBytes` olmadığı için Indexed yolu hiç
        // çalışmıyordu.)
        const paletteRef = doc.context.register(
            PDFRawStream.of(
                doc.context.obj({}),
                Uint8Array.from(Array.from({ length: 768 }, (_, i) => (i * 7) % 256))
            )
        );
        const indices = Buffer.alloc(W * H);
        let is = 0x2545F491;
        for (let i = 0; i < indices.length; i++) {
            is ^= is << 13; is >>>= 0; is ^= is >>> 17; is ^= is << 5; is >>>= 0;
            indices[i] = is & 0xff;
        }
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: (d) => mixedArray(d, ['/Indexed', '/DeviceRGB', 255, paletteRef]),
            pixels: indices
        });
        made.push(write('indexed.pdf', await doc.save()));
    }

    // 3) DeviceCMYK (4 kanal)
    {
        const doc = await PDFDocument.create();
        const cmyk = Buffer.alloc(W * H * 4);
        let cs = 0x9e3779b9;
        for (let i = 0; i < cmyk.length; i++) {
            cs ^= cs << 13; cs >>>= 0; cs ^= cs >>> 17; cs ^= cs << 5; cs >>>= 0;
            cmyk[i] = cs & 0xff;
        }
        const px = cmyk;
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: (d) => PDFName.of('DeviceCMYK'),
            pixels: px
        });
        made.push(write('cmyk.pdf', await doc.save()));
    }

    // 4) Şeffaflık maskesi (SMask) olan RGB görsel
    {
        const doc = await PDFDocument.create();
        const mask = doc.context.register(PDFRawStream.of(
            doc.context.obj({
                Type: 'XObject', Subtype: 'Image',
                Width: W, Height: H, BitsPerComponent: 8,
                ColorSpace: 'DeviceGray', Filter: 'FlateDecode'
            }),
            deflateSync(Buffer.alloc(W * H, 128))
        ));
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: () => PDFName.of('DeviceRGB'),
            pixels: rgbPixels(W, H, 22),
            smask: mask
        });
        made.push(write('smask.pdf', await doc.save()));
    }

    // 5) Ters gri tonlu (/Decode [1 0]) — yeniden kodlama sonrası TERS ÇEVRİLMEMELİ
    {
        const doc = await PDFDocument.create();
        // Gradyan + gurultu: /Decode [1 0] ile ters cevrildiginde
        // ciktida da ayni gorunmeli (piksel dogrulugu testi bunu olcer).
        const px = Buffer.alloc(W * H);
        let gs = 0x1234567;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                gs ^= gs << 13; gs >>>= 0; gs ^= gs >>> 17; gs ^= gs << 5; gs >>>= 0;
                px[y * W + x] = Math.min(255, Math.max(0,
                    Math.round((x / W) * 200) + ((gs & 0x1f) - 16)));
            }
        }
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: () => PDFName.of('DeviceGray'),
            pixels: px,
            decode: [1, 0]
        });
        made.push(write('inverted-gray.pdf', await doc.save()));
    }

    // 6) ICCBased ama 4 kanallı (CMYK profili) — bu araç CMYK'i desteklemez,
    //    bu yüzden görsel ATLANMALI, yanlış renkle yeniden kodlanmamalı.
    {
        const doc = await PDFDocument.create();
        const icc = doc.context.register(PDFRawStream.of(
            doc.context.obj({ N: 4 }),
            Buffer.alloc(128, 0)
        ));
        const px = Buffer.alloc(W * H * 4);
        let s4 = 0x6d2b79f5;
        for (let i = 0; i < px.length; i++) {
            s4 ^= s4 << 13; s4 >>>= 0; s4 ^= s4 >>> 17; s4 ^= s4 << 5; s4 >>>= 0;
            px[i] = s4 & 0xff;
        }
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: (d) => mixedArray(d, ['/ICCBased', icc]),
            pixels: px
        });
        made.push(write('iccbased-cmyk.pdf', await doc.save()));
    }

    // 7) PNG predictor ile kodlanmış Flate görsel — satırlar fark alınarak
    //    (delta) saklanmıştır. Kod çözülmeden inflate edilirse pikseller
    //    gürültü olur. Araç bunu çözemediği için görseli ATLAMALIDIR.
    {
        const doc = await PDFDocument.create();
        const rgb = rgbPixels(W, H, 33);
        // Her satır: filtre tipi 0 + sol satırdan fark (Up/Sub tahmini değil,
        // sade Sub) — gerçek üreticilerin sık ürettiği biçim.
        const stride = 1 + W * 3;
        const predicted = Buffer.alloc(H * stride);
        for (let y = 0; y < H; y++) {
            const rowStart = y * stride;
            predicted[rowStart] = 0;
            for (let x = 0; x < W * 3; x++) {
                const left = x >= 3 ? rgb[y * W * 3 + x - 3] : 0;
                predicted[rowStart + 1 + x] = (rgb[y * W * 3 + x] - left) & 0xff;
            }
        }
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: () => PDFName.of('DeviceRGB'),
            pixels: predicted,
            decodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: W }
        });
        made.push(write('predictor.pdf', await doc.save()));
    }
}

// ---------------------------------------------------------------------------
// Yapısal fixture'lar: Annots/AP (damga) ve tiling Pattern
// ---------------------------------------------------------------------------

// --- Kayıpsız sıkıştırma fixture'ları --------------------------------------

/**
 * Kayıpsız optimizasyonun SINIRINI ölçen fixture'lar:
 *  - duplicate-images: aynı görsel 3 sayfada 3 ayrı nesne olarak gömülü
 *    (tekilleştirme kazancı)
 *  - pure-bw: yalnız 0 ve 255 tonlarından oluşan görsel (1-bit'e ÇEVİLEBİLİR,
 *    çünkü birebir kayıpsızdır)
 *  - photo: gri tonlu sürekli geçişli fotoğraf (1-bit'e çevrilMEMELİ)
 */
async function buildLosslessFixtures() {
    const W = 620, H = 820;

    // 1) Aynı görsel üç kez gömülü
    {
        const doc = await PDFDocument.create();
        const imgDict = doc.context.obj({
            Type: 'XObject', Subtype: 'Image',
            Width: W, Height: H, BitsPerComponent: 8,
            ColorSpace: 'DeviceRGB', Filter: 'FlateDecode'
        });
        for (let i = 0; i < 3; i++) {
            const page = doc.addPage(A4);
            // Her sayfaya AYRI bir nesne: içerik aynı, referans farklı.
            const imgRef = doc.context.register(
                PDFRawStream.of(imgDict, deflateSync(rgbPixels(W, H, 44))));
            const content = `q ${W} 0 0 ${H} 0 0 cm /Im Do Q`;
            page.pushOperators(
                pushGraphicsState(),
                concatTransformationMatrix(W, 0, 0, H, 0, 0),
                drawObject('Im'),
                popGraphicsState()
            );
            page.node.setXObject(PDFName.of('Im'), imgRef);
        }
        made.push(write('duplicate-images.pdf', await doc.save()));
    }

    // 2) Saf siyah-beyaz (yalnız 0 ve 255). 200 DPI A4 boyutunda ki, boyut
    //    farkları anlamlı ölçülsün.
    {
        const doc = await PDFDocument.create();
        const BW = 1240, BH = 1640;
        // Gerçek bir b/w TARANMIŞ SAYFA: çoğu beyaz, satırlar hâlinde siyah
        // yazı ve kalın bir kenarlık. Ara ton YOK (birebir 1-bit'e uygundur)
        // ve 1-bit + Flate ile çok iyi sıkışır.
        const px = Buffer.alloc(BW * BH, 255);
        let s = 0x1f2e3d4c;
        for (let y = 60; y < BH - 60; y += 3) {
            const lineLen = 300 + ((s >>> 8) & 220);
            const left = 55 + ((s >>> 16) & 40);
            s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
            for (let y2 = y; y2 < y + 2 && y2 < BH; y2++) {
                for (let x = left; x < left + lineLen && x < BW; x++) px[y2 * W + x] = 0;
            }
        }
        for (let y = 0; y < BH; y++) {                      // sol kenar çizgisi
            for (let x = 40; x < 88; x++) px[y * BW + x] = 0;
        }
        await pageWithRawImage(doc, {
            width: BW, height: BH,
            colorSpace: () => PDFName.of('DeviceGray'),
            pixels: px
        });
        made.push(write('pure-bw.pdf', await doc.save()));
    }

    // 2b) JPEG-only: sayfa görselleri DOĞRUDAN JPEG olarak gömülü (tipik
    // telefon/tarayıcı çıktısı). Kayıpsız modda bunlara dokunulmamalı.
    {
        const doc = await PDFDocument.create();
        const W2 = 620, H2 = 820;
        for (let i = 0; i < 2; i++) {
            const page = doc.addPage(A4);
            const jpeg = readFileSync(join(OUT, 'assets', 'page-photo.jpg'));
            const jpegRef = doc.context.register(
                PDFRawStream.of(doc.context.obj({
                    Type: 'XObject', Subtype: 'Image',
                    Width: W2, Height: H2, BitsPerComponent: 8,
                    ColorSpace: 'DeviceRGB', Filter: 'DCTDecode'
                }), jpeg));
            page.node.setXObject(PDFName.of('Im'), jpegRef);
            page.pushOperators(
                pushGraphicsState(),
                concatTransformationMatrix(W2, 0, 0, H2, 0, 0),
                drawObject('Im'),
                popGraphicsState()
            );
        }
        made.push(write('jpeg-only.pdf', await doc.save()));
    }

    // 3) Gri tonlu fotoğraf (ara tonlar var -> 1-bit'e çevrilmemeli)
    {
        const doc = await PDFDocument.create();
        const px = Buffer.alloc(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const v = 40 + Math.round(180 * (0.5 + 0.5 * Math.sin(x / 23) * Math.cos(y / 31)));
                px[y * W + x] = Math.max(0, Math.min(255, v));
            }
        }
        await pageWithRawImage(doc, {
            width: W, height: H,
            colorSpace: () => PDFName.of('DeviceGray'),
            pixels: px
        });
        made.push(write('photo-gray.pdf', await doc.save()));
    }
}

async function buildStructureFixtures() {
    const W = 620, H = 820;

    // 1) Widget annotation içinde onay damgası görseli
    {
        const doc = await PDFDocument.create();
        const page = doc.addPage(A4);

        const imgDict = doc.context.obj({
            Type: 'XObject', Subtype: 'Image',
            Width: W, Height: H, BitsPerComponent: 8,
            ColorSpace: 'DeviceRGB', Filter: 'FlateDecode'
        });
        const imgRef = doc.context.register(
            PDFRawStream.of(imgDict, deflateSync(rgbPixels(W, H, 33))));

        // Damga görselini gösteren normal görünüm akışı
        const normal = doc.context.flateStream(
            `q ${W} 0 0 ${H} 0 0 cm /Stamp Do Q`.replace('/Stamp', ''),
            { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H],
              Resources: { XObject: { Stamp: imgRef } } }
        );
        // Operatörleri elle koy
        const content = `q ${W} 0 0 ${H} 40 500 cm /Stamp Do Q`;
        const normalRef = doc.context.register(doc.context.flateStream(
            content,
            { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H],
              Resources: { XObject: { Stamp: imgRef } } }
        ));

        const annotDict = doc.context.obj({
            Type: 'Annot', Subtype: 'Widget', Rect: [40, 500, 40 + W, 500 + H],
            F: 4, AP: { N: normalRef }
        });
        const annotRef = doc.context.register(annotDict);
        page.node.set(PDFName.of('Annots'), mixedArray(doc, [annotRef]));
        made.push(write('stamped.pdf', await doc.save()));
    }

    // 2) Tiling pattern içinde görsel.
    //    pdf-lib bu yapıyı (Pattern -> akış painter -> /Resources) kaybettiği
    //    için PDF elle, ham bayt olarak yazılıyor.
    made.push(write('pattern.pdf', buildPatternPdf(W, H)));
}

/** Tiling pattern içinde tek görsel bulunan elle yazılmış PDF. */
function buildPatternPdf(W, H) {
    // Ham RGB piksel (gürültü → sıkıştırılamaz)
    const px = Buffer.alloc(W * H * 3);
    let st = 0x7F4A7C15;
    for (let i = 0; i < px.length; i++) {
        st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0;
        px[i] = st & 0xff;
    }
    const imageStream = deflateSync(px);

    const patternContent = Buffer.from(`q ${W} 0 0 ${H} 0 0 cm /PatIm Do Q`, 'latin1');

    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        // /Resources içinde /Pattern -> 6 0 R
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ' +
            '/Resources << /Pattern << /Pat 6 0 R >> >> /Contents 5 0 R >>',
        '<< /Length 0 >>', // 4 0 R: kullanılmıyor (numaralandırma aralığı için)
        null, // 5 0 R: içerik akışı aşağıda doldurulacak
        null, // 6 0 R: pattern, aşağıda doldurulacak
        null, // 7 0 R: görsel
        null  // 8 0 R: painter akışı
    ];

    const content = Buffer.from('q 200 0 0 200 100 300 cm /Pat scn Q', 'latin1');
    objects[4] = `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`;
    objects[5] = '<< /Type /Pattern /PatternType /1 /PaintType /1 /TilingType /1 ' +
        `/BBox [0 0 ${W} ${H}] /XStep ${W} /YStep ${H} /Resources << /XObject << /PatIm 7 0 R >> >> >>`;
    objects[6] = `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ` +
        '/BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode ' +
        `/Length ${imageStream.length} >>\nstream\n`;
    objects[7] = `<< /Type /XObject /Subtype /Form /BBox [0 0 ${W} ${H}] ` +
        `/Resources << /XObject << /PatIm 6 0 R >> >> /Length ${patternContent.length} >>\nstream\n` +
        `${patternContent.toString('latin1')}\nendstream`;

    // 6 0 R görselin gövdesi, 7 0 R painter gövdesi olarak birleştiriliyor
    // Basit ve doğru sıralama:
    //  1 catalog, 2 pages, 3 page, 4 content, 5 pattern, 6 image, 7 painter
    const parts = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ' +
            '/Resources << /Pattern << /Pat 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`,
        '<< /Type /Pattern /PatternType /1 /PaintType /1 /TilingType /1 ' +
            `/BBox [0 0 ${W} ${H}] /XStep ${W} /YStep ${H} /Resources << /XObject << /PatIm 6 0 R >> >> >>`,
        `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ` +
            '/BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode ' +
            `/Length ${imageStream.length} >>\nstream\n${imageStream.toString('binary')}\nendstream`,
        `<< /Type /XObject /Subtype /Form /BBox [0 0 ${W} ${H}] ` +
            `/Resources << /XObject << /PatIm 7 0 R >> >> /Length ${patternContent.length} >>\nstream\n` +
            `${patternContent.toString('latin1')}\nendstream`
    ];

    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < parts.length; i++) {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${parts[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= parts.length; i++) {
        out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    out += `trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'binary');
}

// ---------------------------------------------------------------------------
// R1 fixture'ı: /Contents dizisinde AYRAÇSIZ birleşme (pdfBakeAnnotationsForA4)
// ---------------------------------------------------------------------------

// R1: pdfBakeAnnotationsForA4 orijinal içeriği annotation çizimleriyle
// birleştirirken parçalar arasına ayraç KOYMAZSA komşu tokenlar birleşip
// geçersiz operatöre dönüşür (ör. "ET" + "BT" -> "ETBT"). Bu sayfa A5'tir
// (A4 modunda yeniden ölçeklenir, embedPage yolu tetiklenir) ve /Contents'i
// TAM "ET" ile biten bir akış + "BT" ile başlayan ikinci bir akıştan oluşan
// bir DİZİDİR (aralarında baştan/sondan boşluk YOK). Bir annotation (AP'li)
// eklenir ki baking gerçekten çalışsın.
async function buildContentSeamFixture() {
    const doc = await PDFDocument.create();
    const page = doc.addPage(A5);

    // Gömme gerekmeyen standart Type1 fontu (Helvetica).
    const fontRef = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica'
    }));
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: fontRef } }));

    const part1 = 'BT /F1 14 Tf 30 500 Td (PARCA BIR) Tj ET';
    const part2 = 'BT /F1 14 Tf 30 450 Td (PARCA IKI) Tj ET';
    const ref1 = doc.context.register(
        PDFRawStream.of(doc.context.obj({}), Buffer.from(part1, 'latin1')));
    const ref2 = doc.context.register(
        PDFRawStream.of(doc.context.obj({}), Buffer.from(part2, 'latin1')));
    page.node.set(PDFName.of('Contents'), mixedArray(doc, [ref1, ref2]));

    // Baking'i TETİKLEMEK için AP'li bir annotation (asıl konu bu değil,
    // yalnızca embedPage öncesi gömme yolunun çalışmasını sağlar).
    const apRef = doc.context.register(doc.context.flateStream(
        '0 0 1 rg 0 0 20 20 re f',
        { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }
    ));
    const annotRef = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', Rect: [10, 10, 30, 30], F: 4, AP: { N: apRef }
    }));
    page.node.set(PDFName.of('Annots'), mixedArray(doc, [annotRef]));

    made.push(write('content-seam.pdf', await doc.save()));
}

// ---------------------------------------------------------------------------
// R3 fixture'ı: /Contents OLMAYAN sayfada annotation (bkz. pdfPlaceOnA4)
// ---------------------------------------------------------------------------

// R3: /Contents'i hiç olmayan (tamamen boş) bir sayfada annotation varsa,
// bake erken çıkıp pdfPlaceOnA4 de boş A4 döndürüyordu — annotation SESSİZCE
// kayboluyordu. Bu fixture'da sayfanın /Contents'i YOK ama bir annotation'ın
// AP'si "DAMGA" metnini çiziyor; A4 çıktısında bu metin çıkarılabilir olmalı.
async function buildNoContentsAnnotFixture() {
    const doc = await PDFDocument.create();
    const page = doc.addPage(A5);
    // pdf-lib addPage() varsayılan olarak boş bir /Contents akışı ekler;
    // gerçek "Contents yok" durumunu ölçmek için o anahtar SİLİNİR.
    page.node.delete(PDFName.of('Contents'));

    const fontRef = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica'
    }));
    const apRef = doc.context.register(doc.context.flateStream(
        'BT /F1 28 Tf 20 30 Td (DAMGA) Tj ET',
        { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 60],
          Resources: { Font: { F1: fontRef } } }
    ));
    const annotRef = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', Rect: [40, 40, 160, 100], F: 4,
        AP: { N: apRef }
    }));
    page.node.set(PDFName.of('Annots'), mixedArray(doc, [annotRef]));

    made.push(write('no-contents-annot.pdf', await doc.save()));
}

// Yazdırılmaz (Print bayrağı kapalı) annotation: A4 çıktısı "baskıya uygun"
// bir kopyadır; orijinal yazdırıldığında kâğıda ÇIKMAYAN bir inceleme notu
// A4 çıktısına gömülürse belgeye içerik EKLENMİŞ olur. Sayfada gerçek metin
// + yazdırılır damga (F 4) + yazdırılmaz not (F 0) vardır.
async function buildNoPrintAnnotFixture() {
    const doc = await PDFDocument.create();
    const page = doc.addPage(A5);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('ASIL METIN', { x: 40, y: 500, size: 18, font });

    const fontRef = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica'
    }));
    const apFor = (text) => doc.context.register(doc.context.flateStream(
        `BT /F1 18 Tf 5 20 Td (${text}) Tj ET`,
        { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 50],
          Resources: { Font: { F1: fontRef } } }
    ));
    const printable = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Stamp', Rect: [40, 300, 240, 350], F: 4,
        AP: { N: apFor('DAMGA') }
    }));
    const noPrint = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'FreeText', Rect: [40, 150, 240, 200], F: 0,
        AP: { N: apFor('TASLAK NOTU') }
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([printable, noPrint]));

    made.push(write('noprint-annot.pdf', await doc.save()));
}

// ---------------------------------------------------------------------------
// 1.5 fixture'ı: aynı bayt, farklı /Decode taşıyan iki görsel
// ---------------------------------------------------------------------------

// 1.5: eski tekilleştirme yalnızca BAYTLARI karşılaştırıyordu; aynı bayt +
// farklı /Decode taşıyan iki görsel yanlışlıkla BİRLEŞTİRİLİYORDU (biri
// bozuluyordu). Bu iki sayfa AYNI ham piksel baytlarını kullanır, ama
// yalnızca ikincisinde /Decode [1 0] vardır.
async function buildSameBytesDiffDecodeFixture() {
    const W = 300, H = 300;
    const doc = await PDFDocument.create();
    const px = Buffer.alloc(W * H);
    for (let i = 0; i < px.length; i++) px[i] = (i * 37) % 256;

    await pageWithRawImage(doc, {
        width: W, height: H, colorSpace: () => PDFName.of('DeviceGray'), pixels: px
    });
    await pageWithRawImage(doc, {
        width: W, height: H, colorSpace: () => PDFName.of('DeviceGray'), pixels: px, decode: [1, 0]
    });
    made.push(write('same-bytes-diff-decode.pdf', await doc.save()));
}

// ---------------------------------------------------------------------------
// 1.6 fixture'ı: saf siyah-beyaz görsel + /Decode (beyaz liste dışı anahtar)
// ---------------------------------------------------------------------------

// 1.6: 1-bit dönüşümü sözlük özelliklerini (özellikle /Decode) yok sayıyordu.
// Bu görselin RAW baytları saf 0/255'tir (dönüşüm "temiz" sanır) ama
// /Decode [1 0] taşır: dönüşüm bunu yok sayıp yeni 1-bit görselde /Decode'u
// KAYBEDERSE görünüm TERS ÇEVRİLMİŞ olur — bu yüzden ATLANMALIDIR.
async function buildPureBwDecodeFixture() {
    const W = 300, H = 300;
    const px = Buffer.alloc(W * H, 255);
    for (let y = 100; y < 200; y++) {
        for (let x = 50; x < 250; x++) px[y * W + x] = 0;
    }
    const doc = await PDFDocument.create();
    await pageWithRawImage(doc, {
        width: W, height: H, colorSpace: () => PDFName.of('DeviceGray'), pixels: px, decode: [1, 0]
    });
    made.push(write('pure-bw-decode.pdf', await doc.save()));
}

// ---------------------------------------------------------------------------
// 1.7 fixture'ı: tam YATAY A4 sayfa (döndürülmemiş) — doğrudan eklenmeli
// ---------------------------------------------------------------------------

async function buildLandscapeA4Fixture() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage(A4_LANDSCAPE);
    page.drawText('TAM YATAY A4', { x: 40, y: 500, size: 22, font });
    made.push(write('landscape-a4.pdf', await doc.save()));
}

// ---------------------------------------------------------------------------
// A1.2 fixture'ları: form alanı (Widget) görünümü, gizli annotation, AP'siz widget
// ---------------------------------------------------------------------------

async function buildFormFieldFixtures() {
    // Yeniden ölçeklenen (A5) sürüm: A4 modunda embedPage devreye girer.
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage(A5);
        page.drawText('FORM ALANI TESTI', { x: 30, y: 560, size: 14, font });

        const form = doc.getForm();
        const textField = form.createTextField('avukat.ad');
        textField.setText('AVUKAT TEST');
        textField.addToPage(page, { x: 30, y: 480, width: 220, height: 26, font });
        form.updateFieldAppearances(font);

        // Gizli (Hidden, /F bit 2) annotation: GÖRÜNÜMÜ olsa bile A4
        // çıktısında ÇİZİLMEMELİ.
        const hiddenAP = doc.context.register(doc.context.flateStream(
            '1 0 0 RG 0 0 40 20 re S',
            { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 20] }
        ));
        const hiddenAnnot = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Widget', Rect: [30, 440, 70, 460],
            F: 2, AP: { N: hiddenAP }
        }));

        // Görünümü (AP) OLMAYAN widget: sessizce atlanır ama sonuç mesajına
        // uyarı düşmeli.
        const noApWidget = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Widget', Rect: [30, 400, 150, 420], F: 4
        }));

        const annots = page.node.Annots();
        annots.push(hiddenAnnot);
        annots.push(noApWidget);

        made.push(write('form-field.pdf', await doc.save()));
    }

    // Tam A4 sürüm: yeniden ölçeklenmemeli, /Annots olduğu gibi kalmalı.
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage(A4);
        page.drawText('FORM ALANI TESTI A4', { x: 30, y: 800, size: 14, font });

        const form = doc.getForm();
        const textField = form.createTextField('avukat.ad');
        textField.setText('AVUKAT TEST');
        textField.addToPage(page, { x: 30, y: 700, width: 220, height: 26, font });
        form.updateFieldAppearances(font);

        made.push(write('form-field-a4.pdf', await doc.save()));
    }
}

// ---------------------------------------------------------------------------
// Üretim
// ---------------------------------------------------------------------------

const made = [];

async function build() {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

    made.push(await textPdf([
        { name: 'text-only.pdf', size: A4, title: 'KIRA SOZLESMESI', body: 'Bu belge yalnizca metin icerir. Hicbir gomulu gorsel bulunmaz.' },
        { name: 'text-only.pdf', size: A4, title: 'TAHLIYE TAAHHUDI', body: 'Tahliye tarihi ve teslim tutanagi metni.' },
        { name: 'text-only.pdf', size: A4, title: 'ANAHTAR TESLIM', body: 'Anahtar teslim tutanagi ve imza satiri.' }
    ]));

    // Taranmış belge: 5 sayfa × ~4 MB ham RGB
    {
        const doc = await PDFDocument.create();
        const W = 1000, H = 1400;
        for (let i = 0; i < 5; i++) {
            await drawRawImagePage(doc, W, H, scanPixels(W, H, 1000 + i * 7919));
        }
        made.push(write('scanned.pdf', await doc.save()));
    }

    // Farklı MediaBox ölçüleri
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (const [w, h] of [A4, A5, LETTER]) {
            const page = doc.addPage([w, h]);
            page.drawText('KIRPMA TESTI METNI', { x: 20, y: h - 60, size: 16, font });
            page.drawText('Bu satir sayfa altinda kalir ve kirpilmamalidir.', { x: 20, y: 30, size: 9, font });
        }
        made.push(write('mixed-sizes.pdf', await doc.save()));
    }

    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= 3; i++) {
            const page = doc.addPage(A4);
            page.drawText(`ROTATE ${i}`, { x: 40, y: 700, size: 24, font });
        }
        made.push(write('rotate-me.pdf', await doc.save()));
    }

    // Birleştirme: ayırt edici metinlerle 4 + 3 + 4 sayfa
    for (const [name, count, tag] of [['a.pdf', 4, 'ALFA'], ['b.pdf', 3, 'BETA'], ['c.pdf', 4, 'GAMA']]) {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= count; i++) {
            const page = doc.addPage(A4);
            page.drawText(`${tag} SAYFA ${i}`, { x: 40, y: 700, size: 26, font });
        }
        made.push(write(name, await doc.save()));
    }

    // Aynı dosya adı, farklı içerik
    for (const [name, tag] of [['fatura-a.pdf', 'FATURA ALFA'], ['fatura-b.pdf', 'FATURA BETA']]) {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage(A4);
        page.drawText(tag, { x: 40, y: 700, size: 26, font });
        made.push(write(name, await doc.save()));
    }

    // Türkçe karakter + & işareti içeren dosya adı
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage(A4);
        page.drawText('AD TESTI', { x: 40, y: 700, size: 26, font });
        made.push(write('Ahmet & Ayse-test.pdf', await doc.save()));
    }

    // 60 sayfalık belge (büyük ızgara testi)
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= 60; i++) {
            const page = doc.addPage(A4);
            page.drawText(`SAYFA ${i}`, { x: 40, y: 700, size: 20, font });
        }
        made.push(write('sixty-pages.pdf', await doc.save()));
    }

    // Görselin Form XObject içine gömülü olduğu sayfa.
    // pdf-lib'in formXObject(operators[], dict) API'si ile kurulur; sıkıştırma
    // modu 1 bu görseli bulamamalı (yalnızca doğrudan /XObject girdilerine bakar).
    {
        const doc = await PDFDocument.create();
        const W = 400, H = 560;
        const dict = doc.context.obj({
            Type: 'XObject', Subtype: 'Image', Width: W, Height: H,
            ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode'
        });
        const imgRef = doc.context.register(PDFRawStream.of(dict, deflateSync(scanPixels(W, H, 4242))));

        const form = doc.context.formXObject(
            [
                pushGraphicsState(),
                concatTransformationMatrix(W, 0, 0, H, 0, 0),
                drawObject('NestedIm'),
                popGraphicsState()
            ],
            { BBox: [0, 0, W, H], Resources: { XObject: { NestedIm: imgRef } } }
        );

        const page = doc.addPage(A4);
        page.node.setXObject(PDFName.of('Fm0'), doc.context.register(form));
        page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(W, 0, 0, H, 100, 200),
            drawObject('Fm0'),
            popGraphicsState()
        );
        made.push(write('nested-image.pdf', await doc.save()));
    }

    // Kaynak belge KENDİ /Rotate 90 taşıyor. Küçük resimde pdf.js bunu
    // uygular; çıktıda da uygulanmalı. Yoksa sayfa yanlış yönde basılır.
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= 2; i++) {
            const page = doc.addPage(A4);
            page.setRotation(degrees(90));
            page.drawText('KAYNAK DONDURULMUS ' + i, { x: 40, y: 700, size: 22, font });
        }
        made.push(write('source-rotated.pdf', await doc.save()));
    }

    // CropBox MediaBox'tan küçük: A4'e alırken içerik kaymamalı/kırpılmamalı
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage(A4);
        page.setCropBox(100, 150, 500, 700);
        page.drawText('KIRPMA TESTI', { x: 130, y: 620, size: 18, font });
        page.drawText('BU SATIR ALT KOSEDE', { x: 130, y: 190, size: 10, font });
        // A1.4: CropBox DIŞINDA (y=100 < CropBox alt sınırı 150) bir metin.
        // Görünür kutu hesabı CropBox'ı yok sayarsa bu satır çıktıda
        // görünür şekilde konumlanır (kırpılmış olması gerekirken).
        page.drawText('GIZLI KENAR', { x: 130, y: 100, size: 10, font });
        made.push(write('cropbox.pdf', await doc.save()));
    }

    // A1.1: Aynı büyük görsel 10 sayfada PAYLAŞILAN TEK nesne (ortak referans)
    // olarak kullanılıyor — gerçek belgede tekrar eden başlık logosu gibi.
    // Sayfa başına ayrı copyPages() çağrısı bu paylaşımı kaybedip görseli
    // her sayfada yeniden kopyalar (ölçülen 10× şişme); dosya başına TEK
    // toplu copyPages() çağrısı görseli bir kez kopyalamalı.
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const W = 600, H = 800;
        const imgDict = doc.context.obj({
            Type: 'XObject', Subtype: 'Image',
            Width: W, Height: H, BitsPerComponent: 8,
            ColorSpace: 'DeviceRGB', Filter: 'FlateDecode'
        });
        // TEK nesne, TEK ref: 10 sayfa bu AYNI ref'i paylaşır.
        const imgRef = doc.context.register(PDFRawStream.of(imgDict, deflateSync(scanPixels(W, H, 909))));
        for (let i = 1; i <= 10; i++) {
            const page = doc.addPage(A4);
            page.drawText(`SHARED SAYFA ${i}`, { x: 40, y: 780, size: 20, font });
            page.node.setXObject(PDFName.of('Logo'), imgRef);
            page.pushOperators(
                pushGraphicsState(),
                concatTransformationMatrix(220, 0, 0, 293, 40, 420),
                drawObject('Logo'),
                popGraphicsState()
            );
        }
        made.push(write('shared-resources.pdf', await doc.save()));
    }

    // A1.3: /Rotate yalnızca KÖK /Pages düğümünde (miras); sayfanın kendi
    // sözlüğünde YOK. Doğrudan node.get('Rotate') okuyan kod bu değeri kaçırır.
    {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage(A4);
        page.drawText('KAYNAK DONDURULMUS MIRAS', { x: 40, y: 700, size: 22, font });
        // Sayfada /Rotate YOK; kök /Pages düğümüne elle yazılıyor.
        const pagesDict = doc.context.lookup(doc.catalog.get(PDFName.of('Pages')));
        pagesDict.set(PDFName.of('Rotate'), doc.context.obj(90));
        made.push(write('inherited-rotate.pdf', await doc.save()));
    }

    // A1.2: A4 modunda annotation/form alanı kayboluyor. embedPage yalnızca
    // içerik akışını Form XObject yapar; /Annots (form alanı görünümü, damga)
    // düşer. Aşağıdaki A5 sayfa yeniden ölçeklenir (A4 modunda embedPage'e
    // girer); tam A4 sürüm ise yeniden ölçeklenmemeli, /Annots olduğu gibi
    // kalmalı.
    await buildFormFieldFixtures();

    // PART A inceleme düzeltmeleri: içerik akışı ayracı (R1) ve /Contents
    // olmayan sayfada annotation (R3).
    await buildContentSeamFixture();
    await buildNoContentsAnnotFixture();
    await buildNoPrintAnnotFixture();

    // 1.7: tam yatay A4 sayfa (döndürülmemiş) doğrudan eklenmelidir.
    await buildLandscapeA4Fixture();

    // --- Sıkıştırma kör noktalarını kapatan fixture'lar -----------------
    // Bunlar pdf-lib ile doğrudan YAPILAMAZ; sözlük girdileri elle kurulur.
    await buildColorSpaceFixtures();
    await buildStructureFixtures();
    await buildLosslessFixtures();
    await buildSameBytesDiffDecodeFixture();
    await buildPureBwDecodeFixture();

    made.push(write('encrypted.pdf', buildEncryptedPdf()));
    made.push(write('corrupt.pdf', buildCorruptPdf()));
    made.push(write('not-a-pdf.pdf', buildNotAPdf()));
    made.push(write('huge.pdf', buildHugePdf(60)));
    made.push(write('empty.pdf', buildEmptyPdf()));

    for (const m of made) {
        console.log(`${m.name.padEnd(24)} ${(m.size / 1024).toFixed(1).padStart(10)} KB`);
    }
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
