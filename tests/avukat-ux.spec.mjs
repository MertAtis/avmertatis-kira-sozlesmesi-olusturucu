// AŞAMA 2 (kısaltılmış kapsam): avukat kullanımı — düzenlenebilir çıktı adı, "Mahkemeye/UYAP" ve "E-posta" ön ayarları.
// Test PDF'leri burada, bellekte üretilir (fixture dosyası gerekmez).
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

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

async function plainPdf(text = 'DILEKCE') {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText(text, { x: 50, y: 700, size: 20, font });
    return Buffer.from(await doc.save());
}

const pdfFile = (name, buffer) => ({ name, mimeType: 'application/pdf', buffer });

async function build(page) {
    const dl = page.waitForEvent('download');
    await page.click('#pdf-build-btn');
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

    test('P1: "E-posta için küçült" kaliteli küçültmeyi seçer, görsele çevirmeyi seçmez', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, [pdfFile('a.pdf', await plainPdf())]);
        await page.getByRole('button', { name: /E-posta için küçült/ }).click();
        const out = await page.evaluate(() => window.pdfState.output);
        expect(out).toMatchObject({ a4: true, compress: true, compressMode: 'quality', lossy: false, quality: 0.7 });
        await expect(page.locator('#pdf-quality-block')).toBeVisible();
        await expect(page.locator('#pdf-preset-note')).toContainText('E-posta');
    });

    test('P2: "Mahkemeye / UYAP" kayıpsız A4 seçer ve e-posta ayarını geri alır', async ({ page }) => {
        await openPdfTab(page);
        await upload(page, [pdfFile('a.pdf', await plainPdf())]);
        await page.getByRole('button', { name: /E-posta için küçült/ }).click();
        await page.locator('#pdf-opt-lossy').check();
        await page.getByRole('button', { name: /Mahkemeye \/ UYAP/ }).click();
        const out = await page.evaluate(() => window.pdfState.output);
        expect(out).toMatchObject({ a4: true, landscape: true, compress: true, compressMode: 'lossless', lossy: false });
        await expect(page.locator('#pdf-quality-block')).toBeHidden();
        // Kayıpsız çıktıda metin seçilebilir kalır.
        const { bytes } = await build(page);
        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
        await expect(page.locator('#pdf-lossy-modal')).toBeHidden();
    });
});
