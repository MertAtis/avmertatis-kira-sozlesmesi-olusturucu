// Test fixture üreticisi — harici bağımlılık yok, yalnızca Node core + pdf-lib.
//
// Üretilen dosyalar .gitignore ile depoya girmez; `npm test` öncesi
// `npm run fixtures` ile yeniden üretilebilir. Üretim idempotenttir.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';

const OUT = join(dirname(fileURLToPath(import.meta.url)));

const A4 = [595.28, 841.89];
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
// Üretim
// ---------------------------------------------------------------------------

async function build() {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    const made = [];

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
