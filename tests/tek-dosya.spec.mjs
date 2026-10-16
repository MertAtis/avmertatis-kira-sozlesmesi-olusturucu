// Tek-dosya özelliği: "Bilgisayara İndir (İnternetsiz)" düğmesi, siteyi TEK
// html dosyası olarak kaydettirir; dosya file:// ile çift tıklandığında TÜM
// araçlar aynı davranışla çalışır. Burada iki şey sabitlenir:
//   T0 tazelik — depodaki tek-dosya.html betiğin bugün üreteceğiyle AYNI
//                (kayma yasak; kaynak değişirse `npm run tek-dosya` gerekir)
//   T1..T4     — üretilmiş dosya gerçek file:// oturumunda uçtan uca
//                (6 sekme, PDF araçları, veraset kayıpsızlığı, sıfır ağ/hata)
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { tekDosyaHtml } from '../scripts/tek-dosya-olustur.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED = join(REPO, 'tek-dosya.html');
const VERASET_PDF = join(REPO, 'belgeler', 'veraset-intikal-beyannamesi-bos.pdf');
const fixture = (n) => join(REPO, 'tests', 'fixtures', n);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test.describe('tek-dosya (Bilgisayara İndir)', () => {
    test.describe.configure({ retries: 2 });
    test.beforeEach(() => { test.slow(); });
    test('T0: depodaki tek-dosya.html betiğin bugünkü üretimiyle AYNI; dış kaynak yok', async () => {
        const fresh = tekDosyaHtml();
        const stored = readFileSync(COMPILED, 'utf8');
        if (fresh !== stored) {
            throw new Error(
                `tek-dosya.html GÜNCEL DEĞİL (fresh=${sha256(fresh).slice(0, 12)}, depo=${sha256(stored).slice(0, 12)}). `
                + 'index.html veya JS dosyaları değişti: `npm run tek-dosya` ile yeniden üret.',
            );
        }
        // Kendi kendine yeterli: dış script, dış CSS, belge dosyası, dış ağ yok.
        expect(stored.match(/<script src="/g)).toBeNull();
        expect(stored.match(/<link href="vendor\//g)).toBeNull();
        expect(stored.includes('belgeler/')).toBe(false);
        expect(stored.includes('src="http')).toBe(false);
        // Düğme canlı sitede yaşar; içine gömülü kopyada anlamsız olduğu için olmaz.
        const indexHtml = readFileSync(join(REPO, 'index.html'), 'utf8');
        expect(indexHtml.includes('id="btn-tek-dosya"')).toBe(true);
        expect(stored.includes('id="btn-tek-dosya"')).toBe(false);
    });

    test('T1: file:// açılır; 6 sekme; gömülü kütüphanelerle PDF araçları hazır; sıfır ağ, sıfır hata', async ({ page }) => {
        const consoleErrors = [];
        const requests = [];
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
        page.on('request', (r) => {
            if (!r.url().startsWith('file://') && !r.url().startsWith('data:')
                && !r.url().startsWith('blob:')) requests.push(r.url());
        });

        await page.goto('file://' + COMPILED);

        const tabs = await page.locator('.tab-btn').allTextContents();
        expect(tabs.length).toBe(6);

        await page.click('#tab-pdf-araclari');
        await expect(page.locator('#pdf-araclari-form-block')).toBeVisible();
        await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded)).toBe(true);

        // Kira sözleşmesi sekmesi de gerçekten önizleme üretmeli.
        await page.click('#tab-kira');
        await page.fill('#kira-landlord-name', 'AYŞE DEMİR');
        await expect(page.locator('#printable-area')).toContainText('AYŞE DEMİR');

        expect(requests).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });

    test('T2: PDF araçları uçtan uca: iki dosya → 7 sayfa, çalışır PDF iner', async ({ page }) => {
        await page.goto('file://' + COMPILED);

        await page.click('#tab-pdf-araclari');
        await page.setInputFiles('#pdf-file-input', [fixture('a.pdf'), fixture('b.pdf')]);
        await expect.poll(() => page.evaluate(() => window.pdfState.busy)).toBe(false);
        await expect.poll(() => page.locator('.pdf-page-card').count()).toBe(7);
        await expect.poll(
            () => page.locator('.pdf-page-card .pdf-page-thumb-placeholder').count(),
            { timeout: 60000 }
        ).toBe(0);

        // Build ~20ms'de bitabilir: dinleyici tıklamadan ÖNCE takılır
        // (smoke.spec.mjs düzeni; aksi halde olay kaçar ve test takılır).
        const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
        await page.click('#pdf-build-btn');
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const doc = await PDFDocument.load(new Uint8Array(Buffer.concat(chunks)));
        expect(doc.getPageCount()).toBe(7);
    });

    test('T3: Veraset İndir — gömülü blob, orijinal PDF ile BAYT bayt aynı', async ({ page }) => {
        await page.goto('file://' + COMPILED);

        const href = await page.getAttribute('#btn-veraset-indir', 'href');
        expect(href).toMatch(/^blob:/);

        // Bayt bayt denetim indirme olayı üzerinden: file:// altında Chromium
        // `download` olayını raporlar (V2, tests/veraset.spec.mjs'teki gibi).
        const dl = page.waitForEvent('download');
        await page.click('#btn-veraset-indir');
        const download = await Promise.race([dl, new Promise((r) => setTimeout(r, 3000))]);
        if (download) {
            const bytes = new Uint8Array(readFileSync(await download.path()));
            const source = new Uint8Array(readFileSync(VERASET_PDF));
            expect(bytes.length).toBe(source.length);
            expect(Buffer.from(bytes).equals(Buffer.from(source))).toBe(true);
        }
    });

    test('T4: Veraset Yazdır — iframe blob url yükler, konsol hatası yok', async ({ page }) => {
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('file://' + COMPILED);
        await page.click('#btn-veraset-yazdir');
        await expect(page.locator('iframe')).toHaveCount(1);
        const src = await page.getAttribute('iframe', 'src');
        expect(src).toMatch(/^blob:/);
        expect(errors).toEqual([]);
    });
});
