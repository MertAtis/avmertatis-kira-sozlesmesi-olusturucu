// Fotoğraf / JPG / PNG'den PDF. Kural: görsel BOZULMAZ — JPEG baytları
// olduğu gibi gömülür, PNG kayıpsız gömülür. Telefonun EXIF yön etiketi
// piksellere dokunmadan sayfa döndürmesine (/Rotate) çevrilir.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');

async function openPdfTab(page) {
    await page.goto(PAGE);
    await page.click('#tab-pdf-araclari');
    await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded), { timeout: 30000 }).toBe(true);
}

async function upload(page, files) {
    await page.setInputFiles('#pdf-file-input', files);
    await expect.poll(() => page.evaluate(() => window.pdfState.busy), { timeout: 60000 }).toBe(false);
}

async function build(page, button = '#pdf-build-btn') {
    const dl = page.waitForEvent('download');
    await page.click(button);
    const download = await dl;
    return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

/** Tarayıcıda w x h boyutunda JPEG ya da PNG üretir. Sol üst köşe kırmızı işaretlidir. */
async function makeImage(page, w, h, type) {
    const b64 = await page.evaluate(async ({ w, h, type }) => {
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#000'; g.font = `${Math.round(h / 20)}px serif`;
        g.fillText('TAPU SURETI', w / 10, h / 2);
        g.fillStyle = '#f00'; g.fillRect(0, 0, w / 5, h / 5);
        const blob = await c.convertToBlob({ type, quality: 0.9 });
        let bin = ''; for (const x of new Uint8Array(await blob.arrayBuffer())) bin += String.fromCharCode(x);
        return btoa(bin);
    }, { w, h, type });
    return Buffer.from(b64, 'base64');
}

/** JPEG'e EXIF yön etiketi (APP1) ekler. */
function withExifOrientation(jpeg, orientation) {
    const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

const file = (name, mimeType, buffer) => ({ name, mimeType, buffer });

/** Görsel akışları: {filter, bytes, w, h}. */
function images(doc) {
    const out = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj?.dict && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
            out.push({
                filter: String(obj.dict.get(PDFName.of('Filter'))),
                bytes: obj.contents,
                w: Number(obj.dict.get(PDFName.of('Width'))),
                h: Number(obj.dict.get(PDFName.of('Height')))
            });
        }
    }
    return out;
}

/** pdf.js ile sayfanın EKRANDA görünen ölçüsü ve kırmızı işaretin konumu. */
async function renderInfo(page, bytes) {
    return page.evaluate(async (b64) => {
        await pdfEnsureWorker();
        const doc = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
        const p = await doc.getPage(1);
        const vp = p.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d');
        await p.render({ canvasContext: ctx, viewport: vp }).promise;
        // Kırmızı işaretin merkezi (sayfa genişliği/yüksekliğine oranla).
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sx = 0, sy = 0, n = 0;
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const i = (y * canvas.width + x) * 4;
                if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] < 80) { sx += x; sy += y; n++; }
            }
        }
        const red = n ? [sx / n / canvas.width, sy / n / canvas.height] : null;
        return { width: vp.width, height: vp.height, red };
    }, Buffer.from(bytes).toString('base64'));
}

test.describe('fotoğraftan PDF', () => {
    test('F0: dosya seçici fotoğraf kabul eder, sürükleme alanı bunu söyler', async ({ page }) => {
        await openPdfTab(page);
        const accept = await page.locator('#pdf-file-input').getAttribute('accept');
        expect(accept).toContain('image/jpeg');
        expect(accept).toContain('image/png');
        await expect(page.locator('#pdf-dropzone')).toContainText(/JPG/);
    });

    test('F1: JPG tek sayfa PDF olur, JPEG baytları BİREBİR aynı, ad .pdf', async ({ page }) => {
        await openPdfTab(page);
        const jpeg = await makeImage(page, 1200, 1700, 'image/jpeg');
        await upload(page, [file('tapu.jpg', 'image/jpeg', jpeg)]);
        await expect(page.locator('.pdf-page-card')).toHaveCount(1);
        await expect(page.locator('#pdf-file-list')).toContainText('tapu.jpg');

        const { name, bytes } = await build(page);
        expect(name).toBe('tapu.pdf');
        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(1);
        const [img] = images(doc);
        expect(img.filter).toBe('/DCTDecode');
        expect(Buffer.compare(Buffer.from(img.bytes), jpeg)).toBe(0);
    });

    test('F2: yan çekilmiş telefon fotoğrafı (EXIF 6) dik görünür, pikseller değişmez', async ({ page }) => {
        await openPdfTab(page);
        // Sensör verisi YATAY (2000x1500); EXIF 6 = 90° saat yönünde çevir.
        const raw = await makeImage(page, 2000, 1500, 'image/jpeg');
        const jpeg = withExifOrientation(raw, 6);
        await upload(page, [file('foto.jpg', 'image/jpeg', jpeg)]);
        const { bytes } = await build(page);
        const info = await renderInfo(page, bytes);
        expect(info.height).toBeGreaterThan(info.width);          // dik
        // Kırmızı işaret sensörün sol üstündeydi; 90° saat yönünde dönünce SAĞ ÜSTE gider.
        expect(info.red[0]).toBeGreaterThan(0.5);
        expect(info.red[1]).toBeLessThan(0.5);
        const [img] = images(await PDFDocument.load(bytes));
        expect(Buffer.compare(Buffer.from(img.bytes), jpeg)).toBe(0);
    });

    test('F3: PNG kayıpsız gömülür (JPEG\'e çevrilmez, ölçü aynı)', async ({ page }) => {
        await openPdfTab(page);
        const png = await makeImage(page, 800, 600, 'image/png');
        await upload(page, [file('ekran.png', 'image/png', png)]);
        const { bytes } = await build(page);
        const imgs = images(await PDFDocument.load(bytes));
        const main = imgs.find((i) => i.w === 800);
        expect(main).toBeTruthy();
        expect(main.h).toBe(600);
        expect(main.filter).toBe('/FlateDecode');
    });

    test('F4: fotoğraf ve PDF birlikte yüklenir, sıra korunur', async ({ page }) => {
        await openPdfTab(page);
        const jpeg = await makeImage(page, 1000, 1400, 'image/jpeg');
        await upload(page, [
            file('a.pdf', 'application/pdf', readFileSync(join(REPO, 'tests', 'fixtures', 'a.pdf'))),
            file('dekont.jpg', 'image/jpeg', jpeg)
        ]);
        await expect(page.locator('.pdf-page-card')).toHaveCount(5);
        const { bytes } = await build(page);
        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(5);
        await expect(page.locator('#pdf-build-btn')).toHaveText('Birleştir');
    });

    test('F5: iPhone HEIC dosyası anlaşılır bir mesajla reddedilir', async ({ page }) => {
        await openPdfTab(page);
        // HEIC imzası: ....ftypheic
        const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
        await upload(page, [file('IMG_0001.HEIC', 'image/heic', heic)]);
        const text = await page.locator('#pdf-file-list').textContent();
        expect(text).toContain('En Uyumlu');
        await expect(page.locator('.pdf-page-card')).toHaveCount(0);
    });
});
