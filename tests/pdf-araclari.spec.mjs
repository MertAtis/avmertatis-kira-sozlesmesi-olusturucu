import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');

export function fixturePath(name) {
    return join(REPO, 'tests', 'fixtures', name);
}

export function fixtureBytes(name) {
    return new Uint8Array(readFileSync(fixturePath(name)));
}

export async function openPdfTab(page) {
    await page.goto(PAGE);
    await page.click('#tab-pdf-araclari');
    await expect.poll(
        () => page.evaluate(() => !!window.pdfState?.libsLoaded),
        { timeout: 30000, message: 'kütüphaneler yüklenmedi' }
    ).toBe(true);
}

/** Fixture dosyalarını uygulamanın dosya seçicine yükler. */
export async function uploadFixtures(page, names) {
    await page.setInputFiles('#pdf-file-input', names.map(fixturePath));
    // Yükleme bitene kadar bekle.
    await expect.poll(
        () => page.evaluate(() => window.pdfState.busy),
        { timeout: 120000, message: 'yükleme bitmedi' }
    ).toBe(false);
}

export async function fileListRows(page) {
    return page.locator('#pdf-file-list .pdf-file-row').allTextContents();
}

test.describe('PDF Araçları sekmesi kabuğu', () => {
    test('T01: kütüphaneler sekme açılınca yüklenir, konsol hatası yok', async ({ page }) => {
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));

        await openPdfTab(page);

        expect(await page.evaluate(() => typeof window.PDFLib?.PDFDocument)).toBe('function');
        expect(await page.evaluate(() => typeof window.pdfjsLib?.getDocument)).toBe('function');
        expect(errors).toEqual([]);
    });

    test('T22: Content Security Policy ihlali yok', async ({ page }) => {
        const violations = [];
        page.on('console', (m) => {
            if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
        });
        await page.goto(PAGE);
        await page.click('#tab-pdf-araclari');
        await page.waitForTimeout(2000);
        expect(violations).toEqual([]);
    });

    test('T20: PDF Araçları sekmesi ve paneli yazdırmada gizlenir', async ({ page }) => {
        await page.goto(PAGE);
        // Panel varsayılan olarak gizlidir; sekmeye tıklanınca açılır.
        await expect(page.locator('#pdf-araclari-form-block')).toBeHidden();
        await page.click('#tab-pdf-araclari');
        await expect(page.locator('#pdf-araclari-form-block')).toBeVisible();
        // Panel, yazdırmada gizlenen .card-panel içinde durur.
        expect(await page.locator('#pdf-araclari-form-block').evaluate(
            (el) => el.closest('.card-panel').className
        )).toContain('no-print');
        expect(await page.locator('#tab-pdf-araclari').evaluate(
            (el) => el.closest('.tab-container').className
        )).toContain('no-print');
    });
});

test.describe('dosya yükleme ve hata yönetimi', () => {
    test('T02: tek dosya yüklenir, sayfa sayısı listelenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        const rows = await fileListRows(page);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain('4 sayfa');
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(4);
    });

    test('T03: üç dosya yüklenir, 11 sayfa toplanır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf', 'c.pdf']);
        expect(await fileListRows(page)).toHaveLength(3);
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(11);
        const counts = await page.evaluate(() => window.pdfState.files.map((f) => f.pageCount));
        expect(counts).toEqual([4, 3, 4]);
    });

    test('T17: aynı dosya iki kez eklenirse sayfaları iki kez gelir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'a.pdf']);
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(8);
        expect(await page.evaluate(
            () => new Set(window.pdfState.pages.map((p) => p.fileId)).size
        )).toBe(2);
    });

    test('T13: şifreli PDF reddedilir, net Türkçe mesaj gösterilir', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPdfTab(page);
        await uploadFixtures(page, ['encrypted.pdf']);
        const rows = await fileListRows(page);
        expect(rows[0]).toContain('Bu PDF şifreli.');
        expect(rows[0]).toContain('Yazdır → PDF olarak kaydet');
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(0);
        expect(errors).toEqual([]);
    });

    test('T14: bozuk dosya reddedilir, diğer dosyalar yüklenmeye devam eder', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['corrupt.pdf', 'a.pdf']);
        const rows = await fileListRows(page);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('bozuk');
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(4);
    });

    test('T14b: PDF olmayan dosya reddedilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['not-a-pdf.pdf']);
        const rows = await fileListRows(page);
        expect(rows[0]).toContain('geçerli bir PDF değil veya bozuk');
    });

    test('T15: 0 sayfalı PDF reddedilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['empty.pdf']);
        const rows = await fileListRows(page);
        expect(rows[0]).toContain('içinde sayfa bulunamadı');
    });

    test('T16: 50 MB üzeri dosya ayrıştırılmadan reddedilir', async ({ page }) => {
        await openPdfTab(page);
        const started = Date.now();
        await uploadFixtures(page, ['huge.pdf']);
        const rows = await fileListRows(page);
        expect(rows[0]).toContain('50 MB üzeri dosyalar işlenemez');
        // Hata satırı kullanıcıya gösterilir ama kullanılabilir dosya eklenmez.
        expect(await page.evaluate(() => window.pdfState.files.filter((f) => f.doc).length)).toBe(0);
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(0);
        // Ayrıştırılmadığı kanıtı: 60 MB dosyayı ayrıştırmak dakikalar sürer.
        expect(Date.now() - started).toBeLessThan(30000);
    });

    test('T26: pdfIsMemoryError bellek hatalarını tanır, diğerlerini tanımaz', async ({ page }) => {
        await openPdfTab(page);
        const result = await page.evaluate(() => [
            pdfIsMemoryError('JavaScript heap out of memory'),
            pdfIsMemoryError('Array buffer allocation failed'),
            pdfIsMemoryError('Array buffer too large'),
            pdfIsMemoryError('Cannot allocate memory'),
            pdfIsMemoryError('Bir şey ters gitti'),
            pdfIsMemoryError(''),
            pdfIsMemoryError(null),
            pdfIsMemoryError(undefined)
        ]);
        expect(result).toEqual([true, true, true, true, false, false, false, false]);
    });

    test('RF1: Türkçe karakter ve & içeren dosya adı işlenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['Ahmet & Ayse-test.pdf']);
        const rows = await fileListRows(page);
        expect(rows[0]).toContain('Ahmet & Ayse-test.pdf');
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(1);
    });

    test('RF2: aynı ada sahip iki farklı dosya ayrı kayıt olur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['fatura-a.pdf', 'fatura-b.pdf']);
        expect(await fileListRows(page)).toHaveLength(2);
        const ids = await page.evaluate(() => window.pdfState.files.map((f) => f.id));
        expect(new Set(ids).size).toBe(2);
        expect(await page.evaluate(() => window.pdfState.pages.length)).toBe(2);
    });
});

