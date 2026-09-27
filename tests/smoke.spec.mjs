// Canlıya çıkmadan önce uçtan uca duman testi: 6 sekme, sıfır ağ isteği,
// sıfır konsol hatası, gerçek indirme zinciri.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');
const fixture = (n) => join(REPO, 'tests', 'fixtures', n);

test.describe('duman testi (canlı öncesi)', () => {
    test('6 sekme, PDF araçları uçtan uca, sıfır ağ isteği ve konsol hatası', async ({ page, context }) => {
        const consoleErrors = [];
        const requests = [];
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
        page.on('request', (r) => {
            if (!r.url().startsWith('file://') && !r.url().startsWith('data:')
                && !r.url().startsWith('blob:')) requests.push(r.url());
        });

        await page.goto(PAGE);

        // 1) Altı sekme görünmeli.
        const tabs = await page.locator('.tab-btn').allTextContents();
        expect(tabs.length).toBe(6);
        expect(tabs.join(' ')).toContain('PDF Araçları');

        // 2) Her sekme açılabilmeli ve konsol hatası üretmemeli.
        for (const id of ['tab-kira', 'tab-tahliye', 'tab-anahtar', 'tab-makbuz-avukat',
            'tab-makbuz-emlak', 'tab-pdf-araclari']) {
            await page.click(`#${id}`);
            await page.waitForTimeout(200);
        }
        await expect(page.locator('#pdf-araclari-form-block')).toBeVisible();
        await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded)).toBe(true);

        // 3) Kira sözleşmesi sekmesi gerçekten belge üretmeli. Çıktı tarayıcının
        // yazdırma akışı üzerinden alınır; burada canlı önizlemenin dolduğu ve
        // yazdırma düğmesinin bağlı olduğu doğrulanır (yazdırma dialog'u
        // başsız tarayıcıda açılamaz).
        await page.click('#tab-kira');
        await page.fill('#kira-landlord-name', 'AHMET YILMAZ');
        await page.fill('#kira-tenant-name', 'MEHMET KAYA');
        await expect(page.locator('#printable-area')).toContainText('AHMET YILMAZ');
        await expect(page.locator('#printable-area')).toContainText('MEHMET KAYA');
        await expect(page.locator('#kira-form-block').locator('button:has-text("Yazdır")').first()).toBeVisible();

        // 4) PDF araçları: iki dosya, küçük resimler, sil, döndür, sıkıştır, indir.
        await page.click('#tab-pdf-araclari');
        await page.setInputFiles('#pdf-file-input', [fixture('a.pdf'), fixture('b.pdf')]);
        await expect.poll(() => page.evaluate(() => window.pdfState.busy)).toBe(false);
        await expect.poll(() => page.locator('.pdf-page-card').count()).toBe(7);
        await expect.poll(
            () => page.locator('.pdf-page-card .pdf-page-thumb-placeholder').count(),
            { timeout: 60000 }
        ).toBe(0);

        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await expect(page.locator('.pdf-page-badge').first()).toBeVisible();
        await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        await expect.poll(() => page.locator('.pdf-page-card').count()).toBe(6);
        await page.click('#pdf-undo-btn');
        await expect.poll(() => page.locator('.pdf-page-card').count()).toBe(7);

        // Kullanıcı gibi: "Gelişmiş ayarlar"ı aç.
        await page.locator('#pdf-advanced > summary').click();
        await page.locator('#pdf-opt-compress').setChecked(true);
        // Varsayılan kayıpsızdır; duman testi iki yöntemi de dener.
        const downloadPromise = page.waitForEvent('download');
        await page.click('#pdf-build-btn');
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));
        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(7);
        expect(bytes.length).toBeGreaterThan(1000);
        expect(readFileSync).toBeTruthy();

        // 5) Kayıp mod (kalite yöntemi): tek onay, tek indirme.
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        let downloads = 0;
        page.on('download', () => { downloads++; });
        const lossyPromise = page.waitForEvent('download');
        await page.click('#pdf-build-btn');
        await expect(page.locator('#pdf-lossy-modal')).toBeVisible();
        await page.click('#pdf-lossy-confirm');
        const lossy = await lossyPromise;
        await page.waitForTimeout(2500);
        expect(downloads).toBe(1);
        const lossyStream = await lossy.createReadStream();
        const lossyChunks = [];
        for await (const chunk of lossyStream) lossyChunks.push(chunk);
        expect((await PDFDocument.load(new Uint8Array(Buffer.concat(lossyChunks)))).getPageCount()).toBe(7);

        // 6) Gizlilik ve temizlik.
        expect(requests).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
});
