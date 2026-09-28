// TIFF'ten PDF. Kural: resmî evrakın görünümü BİREBİR korunur.
//
// Test dosyaları GERÇEK libtiff ile üretilir (tests/fixtures/tiff/
// build-tiff-fixtures.py); beklenen görünüm de libtiff'in kendi çözümüdür
// (<ad>.p<N>.png). Uygulamanın okuyucusu bu BAĞIMSIZ kaynağa karşı ölçülür:
// PDF sayfası, TIFF pikseli = ekran pikseli olacak ölçekte pdf.js ile çizilir
// ve beklenen görüntüyle piksel piksel karşılaştırılır.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');
const TIFF_DIR = join(REPO, 'tests', 'fixtures', 'tiff');
const tiffPath = (name) => join(TIFF_DIR, name);

async function openPdfTab(page) {
    await page.goto(PAGE);
    await page.click('#tab-pdf-araclari');
    await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded), { timeout: 30000 }).toBe(true);
    await page.evaluate(() => { const d = document.getElementById('pdf-advanced'); if (d) d.open = true; });
}

async function upload(page, names) {
    await page.setInputFiles('#pdf-file-input', names.map(tiffPath));
    await expect.poll(() => page.evaluate(() => window.pdfState.busy), { timeout: 60000 }).toBe(false);
}

/** Orijinal sayfa boyutuyla (A4'e sığdırmadan) PDF üretir. */
async function buildOriginalSize(page) {
    await page.locator('#pdf-opt-a4').setChecked(false);
    const dl = page.waitForEvent('download');
    await page.click('#pdf-build-btn');
    const download = await dl;
    return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

/**
 * PDF'in `pageNo` sayfasını `pxPerPt` ölçeğinde çizer, beklenen PNG ile
 * karşılaştırır. Dönüş: {w, h, ew, eh, strong, mae}
 *  strong: 64'ten büyük renk farkı olan piksel sayısı
 *  mae: ortalama mutlak fark (0-255)
 */
async function compareWithPng(page, pdfBytes, pageNo, pngName, pxPerPt) {
    return page.evaluate(async ({ pdf, png, pageNo, pxPerPt }) => {
        await pdfEnsureWorker();
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const doc = await pdfjsLib.getDocument({ data: bytes(pdf) }).promise;
        const p = await doc.getPage(pageNo);
        const vp = p.getViewport({ scale: pxPerPt });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await p.render({ canvasContext: ctx, viewport: vp }).promise;
        const got = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        const bmp = await createImageBitmap(new Blob([bytes(png)], { type: 'image/png' }));
        const c2 = new OffscreenCanvas(bmp.width, bmp.height);
        const g2 = c2.getContext('2d');
        g2.drawImage(bmp, 0, 0);
        const exp = g2.getImageData(0, 0, bmp.width, bmp.height).data;

        const w = Math.min(canvas.width, bmp.width), h = Math.min(canvas.height, bmp.height);
        let strong = 0, sum = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const a = (y * canvas.width + x) * 4, b = (y * bmp.width + x) * 4;
                const d = Math.max(Math.abs(got[a] - exp[b]), Math.abs(got[a + 1] - exp[b + 1]), Math.abs(got[a + 2] - exp[b + 2]));
                if (d > 64) strong++;
                sum += d;
            }
        }
        return { w: canvas.width, h: canvas.height, ew: bmp.width, eh: bmp.height, strong, mae: sum / (w * h) };
    }, {
        pdf: Buffer.from(pdfBytes).toString('base64'),
        png: readFileSync(tiffPath(pngName)).toString('base64'),
        pageNo, pxPerPt
    });
}

/** Görsel akışları: {filter, bytes, w, h, colorSpace}. */
function images(doc) {
    const out = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj?.dict && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
            out.push({
                filter: String(obj.dict.get(PDFName.of('Filter'))),
                colorSpace: String(obj.dict.get(PDFName.of('ColorSpace'))),
                bytes: obj.contents,
                w: Number(obj.dict.get(PDFName.of('Width'))),
                h: Number(obj.dict.get(PDFName.of('Height')))
            });
        }
    }
    return out;
}

// [dosya, sayfa sayısı, DPI, kayıplı mı (JPEG)]
const CASES = [
    ['g4-2sayfa', 2, 200, false],
    ['g4-tekserit-miniswhite', 1, 200, false],
    ['g4-fillorder2', 1, 200, false],
    ['g3-1d', 1, 200, false],
    ['g3-2d', 1, 200, false],
    ['lzw-rgb', 1, 150, false],
    ['zip-gri-cm', 1, 300, false],
    ['packbits-sb', 1, 100, false],
    ['palet', 1, 150, false],
    ['jpeg-tekserit', 1, 150, true],
    ['jpeg-cokserit', 1, 150, true]
];

test.describe('TIFF → PDF: görünüm libtiff ile birebir', () => {
    for (const [name, pages, dpi, lossy] of CASES) {
        test(`${name}: ${pages} sayfa, ${dpi} DPI, piksel piksel aynı`, async ({ page }) => {
            await openPdfTab(page);
            await upload(page, [`${name}.tif`]);
            await expect(page.locator('.pdf-page-card')).toHaveCount(pages);
            const { name: outName, bytes } = await buildOriginalSize(page);
            expect(outName).toBe(`${name}.pdf`);
            expect((await PDFDocument.load(bytes)).getPageCount()).toBe(pages);

            for (let n = 1; n <= pages; n++) {
                const r = await compareWithPng(page, bytes, n, `${name}.p${n}.png`, dpi / 72);
                // Sayfa boyutu TIFF'in kendi çözünürlüğünden: 1 TIFF pikseli = 1 ekran pikseli.
                expect([r.w, r.h], `s.${n} ölçü`).toEqual([r.ew, r.eh]);
                if (lossy) {
                    // JPEG: pdf.js ile libjpeg'in çözücüsü bit bit aynı değildir
                    // (renk alt örneklemesinin açılışı farklı). Dönüşümün
                    // kayıpsızlığı aşağıdaki ayrı testlerde bayt düzeyinde ölçülür.
                    expect(r.mae, `s.${n} ortalama fark`).toBeLessThan(4);
                    expect(r.strong / (r.w * r.h), `s.${n} güçlü fark oranı`).toBeLessThan(0.002);
                } else {
                    expect(r.strong, `s.${n} farklı piksel`).toBe(0);
                }
            }
        });
    }

    test('tek şeritli G4 baytları OLDUĞU GİBİ aktarılır (yeniden kodlama yok)', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['g4-tekserit-miniswhite.tif']);
        const { bytes } = await buildOriginalSize(page);
        const [img] = images(await PDFDocument.load(bytes));
        expect(img.filter).toBe('/CCITTFaxDecode');
        // TIFF'teki tek şeridin baytları
        const tif = readFileSync(tiffPath('g4-tekserit-miniswhite.tif'));
        const strip = readStripBytes(tif);
        expect(Buffer.compare(Buffer.from(img.bytes), strip)).toBe(0);
    });

    test('tek şeritli JPEG baytları aynen aktarılır (tablolar + şerit)', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['jpeg-tekserit.tif']);
        const { bytes } = await buildOriginalSize(page);
        const [img] = images(await PDFDocument.load(bytes));
        expect(img.filter).toBe('/DCTDecode');
        const tif = readFileSync(tiffPath('jpeg-tekserit.tif'));
        const strip = readStripBytes(tif);
        // PDF'teki JPEG = TIFF'in JPEGTables'ı (EOI'siz) + şerit (SOI'siz).
        // Sıkıştırılmış görüntü verisi (şeridin gövdesi) birebir yer alır.
        const body = Buffer.from(img.bytes).subarray(Buffer.from(img.bytes).length - (strip.length - 2));
        expect(Buffer.compare(body, strip.subarray(2))).toBe(0);
    });

    test('çok şeritli JPEG, tek şeritli sürümüyle aynı görünür', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['jpeg-cokserit.tif']);
        const multi = (await buildOriginalSize(page)).bytes;
        await page.locator('.pdf-file-row [data-remove-file]').first().click();
        await upload(page, ['jpeg-tekserit.tif']);
        const single = (await buildOriginalSize(page)).bytes;
        const r = await page.evaluate(async ({ a, b }) => {
            await pdfEnsureWorker();
            const draw = async (b64) => {
                const doc = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
                const p = await doc.getPage(1);
                const vp = p.getViewport({ scale: 150 / 72 });
                const c = document.createElement('canvas');
                c.width = Math.round(vp.width); c.height = Math.round(vp.height);
                const ctx = c.getContext('2d', { willReadFrequently: true });
                await p.render({ canvasContext: ctx, viewport: vp }).promise;
                return ctx.getImageData(0, 0, c.width, c.height).data;
            };
            const [x, y] = [await draw(a), await draw(b)];
            let max = 0;
            for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - y[i]));
            return { max };
        }, { a: Buffer.from(multi).toString('base64'), b: Buffer.from(single).toString('base64') });
        // Aynı JPEG verisi, aynı çözücü: şerit sınırında bile fark yok denecek kadar az.
        expect(r.max).toBeLessThanOrEqual(8);
    });

    test('CMYK: ham CMYK örnekleri birebir aynı', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['cmyk-lzw.tif']);
        const { bytes } = await buildOriginalSize(page);
        const [img] = images(await PDFDocument.load(bytes));
        expect(img.colorSpace).toBe('/DeviceCMYK');
        expect(img.filter).toBe('/FlateDecode');
        const expected = inflateSync(readFileSync(tiffPath('cmyk-lzw.p1.cmyk.z')));
        expect(Buffer.compare(inflateSync(Buffer.from(img.bytes)), expected)).toBe(0);
    });

    test('yön etiketi 6: yatay kaydedilen sayfa dik görünür, pikseller dönmez', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['yon6.tif']);
        const { bytes } = await buildOriginalSize(page);
        const info = await page.evaluate(async (b64) => {
            await pdfEnsureWorker();
            const doc = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
            const p = await doc.getPage(1);
            const vp = p.getViewport({ scale: 1 });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
            const ctx = canvas.getContext('2d');
            await p.render({ canvasContext: ctx, viewport: vp }).promise;
            const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let sx = 0, sy = 0, n = 0;
            for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
                const i = (y * canvas.width + x) * 4;
                if (d[i] > 170 && d[i + 1] < 70 && d[i + 2] < 70) { sx += x; sy += y; n++; }
            }
            return { w: vp.width, h: vp.height, red: [sx / n / canvas.width, sy / n / canvas.height] };
        }, Buffer.from(bytes).toString('base64'));
        expect(info.h).toBeGreaterThan(info.w);
        // Kırmızı işaret kayıtlı görüntünün sol üstünde; 90° saat yönünde gösterilince sağ üstte.
        expect(info.red[0]).toBeGreaterThan(0.5);
        expect(info.red[1]).toBeLessThan(0.5);
        // Pikseller döndürülmez: görsel hâlâ 800x600 (yatay) saklanır.
        const [img] = images(await PDFDocument.load(bytes));
        expect([img.w, img.h]).toEqual([800, 600]);
    });

    test('faks çözünürlüğü (204x98 DPI): sayfa gerçek fiziksel boyutta', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['faks-204x98.tif']);
        const { bytes } = await buildOriginalSize(page);
        const p = (await PDFDocument.load(bytes)).getPage(0);
        const { width, height } = p.getSize();
        expect(width).toBeCloseTo(1728 * 72 / 204, 1);
        expect(height).toBeCloseTo(1100 * 72 / 98, 1);
    });

    test('A4 varsayılanı açıkken TIFF sayfası A4 olur', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['g4-2sayfa.tif']);
        const dl = page.waitForEvent('download');
        await page.click('#pdf-build-btn');
        const bytes = readFileSync(await (await dl).path());
        for (const p of (await PDFDocument.load(bytes)).getPages()) {
            const { width, height } = p.getSize();
            expect(width).toBeCloseTo(595.28, 0);
            expect(height).toBeCloseTo(841.89, 0);
        }
    });

    test('desteklenmeyen TIFF (döşemeli / şeffaf) anlaşılır mesajla reddedilir', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, ['desteklenmez-doseme.tif', 'desteklenmez-alfa.tif']);
        await expect(page.locator('.pdf-page-card')).toHaveCount(0);
        const text = await page.locator('#pdf-file-list').textContent();
        expect(text.match(/TIFF türü desteklenmiyor/g)?.length).toBe(2);
    });

    test('dosya seçici ve sürükleme alanı TIFF kabul eder', async ({ page }) => {
        await openPdfTab(page);
        const accept = await page.locator('#pdf-file-input').getAttribute('accept');
        expect(accept).toContain('image/tiff');
        expect(accept).toContain('.tif');
        await expect(page.locator('#pdf-dropzone')).toContainText('TIFF');
    });
});

/** Test yardımcısı: tek şeritli TIFF'in şerit baytlarını (Node'da, bağımsız) okur. */
function readStripBytes(buf) {
    const le = buf[0] === 0x49;
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = u32(4);
    let off = null, len = null;
    for (let i = 0; i < u16(ifd); i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2);
        const val = type === 3 ? u16(e + 8) : u32(e + 8);
        if (tag === 273) off = val;
        if (tag === 279) len = val;
    }
    return buf.subarray(off, off + len);
}

test('fixture dosyaları mevcut', () => {
    for (const [name, pages] of CASES) {
        for (let n = 1; n <= pages; n++) expect(existsSync(tiffPath(`${name}.p${n}.png`)), name).toBe(true);
    }
});
