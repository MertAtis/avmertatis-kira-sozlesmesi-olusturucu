// Avukat kullanımı — düzenlenebilir çıktı adı ve iki düğme: "Birleştir" / "Birleştir ve Küçült".
// Test PDF'leri burada, bellekte üretilir (fixture dosyası gerekmez).
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');

async function openPdfTab(page) {
    await page.goto(PAGE);
    await page.click('#tab-pdf-araclari');
    await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded), { timeout: 30000 }).toBe(true);
    // Ayrıntılı seçenekler kapalı "Gelişmiş ayarlar" altındadır; testler onlara erişebilsin.
    await page.evaluate(() => { const d = document.getElementById('pdf-advanced'); if (d) d.open = true; });
}

async function upload(page, files) {
    await page.setInputFiles('#pdf-file-input', files);
    await expect.poll(() => page.evaluate(() => window.pdfState.busy), { timeout: 60000 }).toBe(false);
}

async function plainPdf(text = 'DILEKCE') {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText(text, { x: 50, y: 700, size: 20, font });
    return Buffer.from(await doc.save());
}

/** Belgedeki tüm görsel akışlarının /Filter adları. */
function imageFilters(doc) {
    const out = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj?.dict && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
            out.push(String(obj.dict.get(PDFName.of('Filter'))));
        }
    }
    return out.join(' ');
}

/** İlk JPEG görselin baytları ve sözlükteki ölçüleri. */
function firstJpeg(doc) {
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj?.dict && String(obj.dict.get(PDFName.of('Filter'))) === '/DCTDecode') {
            return {
                bytes: obj.contents,
                w: Number(obj.dict.get(PDFName.of('Width'))),
                h: Number(obj.dict.get(PDFName.of('Height')))
            };
        }
    }
    throw new Error('JPEG görsel yok');
}

/** İki JPEG'i tarayıcıda aynı boyuta çizip ortalama mutlak farkı (0-255) döndürür. */
async function jpegMae(page, a, b) {
    return page.evaluate(async ({ a, b }) => {
        const bmp = async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }));
        const [x, y] = await Promise.all([bmp(a), bmp(b)]);
        const w = Math.min(x.width, y.width), h = Math.min(x.height, y.height);
        const px = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
        const p = px(x), q = px(y);
        let sum = 0;
        for (let i = 0; i < p.length; i += 4) sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
        return sum / (w * h * 3);
    }, { a: Buffer.from(a.bytes).toString('base64'), b: Buffer.from(b.bytes).toString('base64') });
}

/**
 * Tarayıcıda fotoğrafa benzer (yumuşak geçiş + doku) yüksek kaliteli bir JPEG
 * üretip A4 sayfaya yerleştirir. `orientation` > 0 ise JPEG'e EXIF yön
 * etiketi (APP1) eklenir.
 */
async function photoPdf(page, w, h, orientation) {
    const b64 = await page.evaluate(async ({ w, h }) => {
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#f4efe4'); grad.addColorStop(1, '#c9d6e3');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        g.fillStyle = '#222';
        g.font = `${Math.round(h / 60)}px serif`;
        for (let y = h / 20; y < h; y += h / 40) g.fillText('Sayın Mahkeme, davacı vekili olarak ...', w / 12, y);
        const img = g.getImageData(0, 0, w, h);
        let s = 7;
        for (let i = 0; i < img.data.length; i += 4) { s = (s * 1103515245 + 12345) >>> 0; const n = (s >>> 24) % 9 - 4; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
        g.putImageData(img, 0, 0);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = ''; for (const x of bytes) bin += String.fromCharCode(x);
        return btoa(bin);
    }, { w, h });
    let jpeg = Buffer.from(b64, 'base64');
    if (orientation) {
        // Minimal EXIF: TIFF başlığı (II), tek IFD girdisi: 0x0112 Orientation.
        const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00]);
        const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
        const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
        jpeg = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
    }
    const doc = await PDFDocument.create();
    const image = await doc.embedJpg(jpeg);
    doc.addPage([595.28, 841.89]).drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
    return Buffer.from(await doc.save());
}

const pdfFile = (name, buffer) => ({ name, mimeType: 'application/pdf', buffer });

async function build(page, button = '#pdf-build-btn') {
    const dl = page.waitForEvent('download');
    await page.click(button);
    const download = await dl;
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    return { name: download.suggestedFilename(), bytes: new Uint8Array(Buffer.concat(chunks)) };
}

test.describe('AŞAMA 2: avukat kullanımı', () => {
    test('N1: dosya adı boşsa varsayılan ad yer tutucu olarak görünür ve kullanılır', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, [pdfFile('dilekce.pdf', await plainPdf())]);
        await expect(page.locator('#pdf-output-name')).toHaveAttribute('placeholder', 'dilekce.pdf');
        await upload(page, [pdfFile('ek.pdf', await plainPdf('EK'))]);
        await expect(page.locator('#pdf-output-name')).toHaveAttribute('placeholder', 'birlesmis-belge.pdf');
        expect((await build(page)).name).toBe('birlesmis-belge.pdf');
    });

    test('N2: yazılan ad kullanılır, .pdf eklenir, yasak karakter temizlenir, başlık aynı', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, [pdfFile('a.pdf', await plainPdf()), pdfFile('b.pdf', await plainPdf('B'))]);
        await page.fill('#pdf-output-name', 'Dava 2026/123 Ekleri');
        const { name, bytes } = await build(page);
        // Esas no gibi '/' içeren adlar kırpılmaz; ayırıcı '-' olur.
        expect(name).toBe('Dava 2026-123 Ekleri.pdf');
        expect(name).toMatch(/\.pdf$/);
        expect(name).not.toMatch(/[\\/:*?"<>|]/);
        const doc = await PDFDocument.load(bytes);
        expect(doc.getTitle()).toBe(name.replace(/\.pdf$/, ''));

        await page.fill('#pdf-output-name', 'Bilirkisi Raporu.PDF');
        expect((await build(page)).name).toBe('Bilirkisi Raporu.PDF');
    });

    test('B1: iki düğme — çok dosyada "Birleştir", tek dosyada "Kaydet"', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, [pdfFile('a.pdf', await plainPdf())]);
        await expect(page.locator('#pdf-build-btn')).toHaveText('Kaydet');
        await expect(page.locator('#pdf-build-small-btn')).toHaveText('Küçültüp Kaydet');
        await upload(page, [pdfFile('b.pdf', await plainPdf('B'))]);
        await expect(page.locator('#pdf-build-btn')).toHaveText('Birleştir');
        await expect(page.locator('#pdf-build-small-btn')).toHaveText('Birleştir ve Küçült');
        // Küçült düğmesinin altında resmî sunum uyarısı.
        await expect(page.locator('#pdf-small-note')).toContainText('E-posta');
        await expect(page.locator('#pdf-small-note')).toContainText(/mahkeme/i);
    });

    test('B2: eski hızlı ayarlar yok; ayrıntılar kapalı "Gelişmiş ayarlar" altında', async ({ page }) => {
        await page.goto(PAGE);
        await page.click('#tab-pdf-araclari');
        await expect(page.locator('#pdf-preset-court')).toHaveCount(0);
        await expect(page.locator('#pdf-preset-email')).toHaveCount(0);
        const advanced = page.locator('#pdf-advanced');
        await expect(advanced).toHaveJSProperty('open', false);
        await expect(advanced.locator('#pdf-opt-a4')).toBeHidden();
        await expect(page.locator('#pdf-output-name')).toBeVisible();
    });

    test('B3: "Küçült" görselleri kaliteli küçültür; ardından "Birleştir" görünümü birebir korur', async ({ page }) => {
        await openPdfTab(page);
        const scan = readFileSync(join(REPO, 'tests', 'fixtures', 'scanned.pdf'));
        await upload(page, [pdfFile('tarama.pdf', scan)]);

        const small = await build(page, '#pdf-build-small-btn');
        expect(imageFilters(await PDFDocument.load(small.bytes))).toContain('DCTDecode');
        expect(small.bytes.length).toBeLessThan(scan.length);
        await expect(page.locator('#pdf-lossy-modal')).toBeHidden();

        // Küçült ayarı "Birleştir"e SIZMAMALI.
        const plain = await build(page, '#pdf-build-btn');
        expect(imageFilters(await PDFDocument.load(plain.bytes))).not.toContain('DCTDecode');
    });

    test('K1: "Küçült" JPEG taramayı da küçültür, görünüm yakın kalır', async ({ page }) => {
        await openPdfTab(page);
        const src = readFileSync(join(REPO, 'tests', 'fixtures', 'jpeg-only.pdf'));
        await upload(page, [pdfFile('jpeg.pdf', src)]);
        const { bytes } = await build(page, '#pdf-build-small-btn');
        expect(bytes.length).toBeLessThan(src.length * 0.8);
        const text = await page.locator('#pdf-result').textContent();
        expect(text).not.toContain('zaten JPEG');
        // Görünüm: kaynak ve çıktı JPEG'leri ortalama piksel farkı küçük.
        const mae = await jpegMae(page, firstJpeg(await PDFDocument.load(src)), firstJpeg(await PDFDocument.load(bytes)));
        expect(mae).toBeLessThan(12);
    });

    test('K2: yüksek çözünürlüklü telefon fotoğrafı A4 için yeterli çözünürlüğe iner', async ({ page }) => {
        await openPdfTab(page);
        const src = await photoPdf(page, 4000, 5600, 0);
        await upload(page, [pdfFile('telefon.pdf', src)]);
        const { bytes } = await build(page, '#pdf-build-small-btn');
        const img = firstJpeg(await PDFDocument.load(bytes));
        // Orta kalite: 200 DPI A4 -> uzun kenar en fazla 2339 piksel, oran korunur.
        expect(Math.max(img.w, img.h)).toBeLessThanOrEqual(2339);
        expect(img.h / img.w).toBeCloseTo(5600 / 4000, 1);
        expect(bytes.length).toBeLessThan(src.length * 0.4);
    });

    test('K3: EXIF yön etiketi yeniden kodlamada görüntüyü DÖNDÜRMEZ', async ({ page }) => {
        // PDF görüntüleyiciler JPEG içindeki EXIF yönünü YOK SAYAR. Yeniden
        // kodlarken tarayıcı etiketi uygularsa görsel yan döner.
        await openPdfTab(page);
        const src = await photoPdf(page, 3000, 2000, 6);
        await upload(page, [pdfFile('exif.pdf', src)]);
        const { bytes } = await build(page, '#pdf-build-small-btn');
        const img = firstJpeg(await PDFDocument.load(bytes));
        expect(img.w).toBeGreaterThan(img.h);
    });

    test('K4: "Birleştir" JPEG baytlarına DOKUNMAZ', async ({ page }) => {
        await openPdfTab(page);
        const src = readFileSync(join(REPO, 'tests', 'fixtures', 'jpeg-only.pdf'));
        await upload(page, [pdfFile('jpeg.pdf', src)]);
        const { bytes } = await build(page, '#pdf-build-btn');
        const a = firstJpeg(await PDFDocument.load(src)).bytes;
        const b = firstJpeg(await PDFDocument.load(bytes)).bytes;
        expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    });
});
