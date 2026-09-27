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
});
