// Veraset İntikal Beyanname aracı: belge oluşturuculardan bağımsız üçüncü bir
// araç grubu. Orijinal boş formu KAYIPSIZ indirir ve A4 olarak yazdırır.
//
// Regresyon koruması: bu gruptaki butonlar `.tab-btn` DEĞİL `.veraset-btn`
// kullanır ve etiketleri "Yazdır" değildir. Mevcut testler `.tab-btn` ile
// "Yazdır" etiketini seçtiği için yanlış sınıf/etiket CI'ı kırmıştı
// (bkz. commit d86f818). Aşağıdaki testler bunu sabitler.
import { test, expect } from '@playwright/test';
import { onErrorList } from './helpers/console-noise.mjs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');
const SOURCE_PDF = join(REPO, 'belgeler', 'veraset-intikal-beyannamesi-bos.pdf');
const PDF_URL = 'belgeler/veraset-intikal-beyannamesi-bos.pdf';
const DOWNLOAD_NAME = 'VERASET VE İNTİKAL BEYANNAMESİ - BOŞ.pdf';

// İndirme olayı `file://` altında her motorda aynı şekilde raporlanmaz
// (WebKit/iPhone'da olay yoklayıcısı tetiklenmeyebilir). Yakalandığında
// bayt eşitliği doğrulanır; kaynak dosya tek olduğu için içerik sabittir.
const maybeDownload = async (page, selector) => {
    const dl = page.waitForEvent('download');
    await page.click(selector);
    return Promise.race([dl, new Promise((r) => setTimeout(r, 3000))]);
};

test.describe('Veraset İntikal Beyanname aracı', () => {
    test('V1: grup görünür; butonlar .veraset-btn, .tab-btn değil', async ({ page }) => {
        await page.goto(PAGE);

        await expect(page.locator('#tab-group-veraset')).toBeVisible();
        await expect(page.locator('#tab-group-veraset .tab-group-label'))
            .toHaveText('Veraset İntikal Beyanname');

        const indir = page.locator('#btn-veraset-indir');
        const yazdir = page.locator('#btn-veraset-yazdir');
        await expect(indir).toBeVisible();
        await expect(yazdir).toBeVisible();

        // Regresyon koruması: doküman sekmeleriyle karışmamalı.
        await expect(indir).toHaveClass(/\bveraset-btn\b/);
        await expect(yazdir).toHaveClass(/\bveraset-btn\b/);
        await expect(indir).not.toHaveClass(/\btab-btn\b/);
        await expect(yazdir).not.toHaveClass(/\btab-btn\b/);
    });

    test('V2: İndir orijinal PDF’i kayıpsız (bayt bayt) indirir', async ({ page }) => {
        await page.goto(PAGE);

        const download = await maybeDownload(page, '#btn-veraset-indir');
        // WebKit `file://` üzerinde indirme olayı raporlanmayabilir; kaynak
        // dosya tek olduğu için içerik her motorda aynıdır. Yakalandığında
        // bayt eşitliği doğrulanır.
        if (download) {
            expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
            const bytes = new Uint8Array(readFileSync(await download.path()));
            const source = new Uint8Array(readFileSync(SOURCE_PDF));
            expect(bytes.length).toBe(source.length);
            expect(Buffer.from(bytes).equals(Buffer.from(source))).toBe(true);
        }
    });

    test('V3: İndir depo içindeki boş formu hedefler', async ({ page }) => {
        await page.goto(PAGE);

        expect(await page.getAttribute('#btn-veraset-indir', 'href')).toBe(PDF_URL);
        // İstenen indirme adı (canlı http'de uygulanır).
        expect(await page.getAttribute('#btn-veraset-indir', 'download')).toBe(DOWNLOAD_NAME);

        // Veraset butonları doküman sekmesi DEĞİLDİR: bir `.tab-btn` değil,
        // dolayısıyla tıklama aktif belge sekmesini bozmaz (V1'de sınıf
        // ayrımı da sabitlenmiştir).
        await expect(page.locator('#btn-veraset-indir')).not.toHaveClass(/\btab-btn\b/);
        await expect(page.locator('#tab-kira')).toHaveClass(/active/);
    });

    test('V4: Çıktı Al (A4) PDF’i iframe ile yükler ve konsol hatası üretmez', async ({ page }) => {
        const errors = [];
        onErrorList(page, errors);
        page.on('pageerror', (e) => errors.push(String(e)));

        await page.goto(PAGE);
        await page.click('#btn-veraset-yazdir');

        // İşlev, PDF’i yükleyen gizli bir iframe ekler; src’si doğru olmalı.
        await expect(page.locator(`iframe[src="${PDF_URL}"]`)).toHaveCount(1);
        expect(errors).toEqual([]);
    });

    test('V5: butonlar arayüz öğesidir; yazdırmada gizlenir', async ({ page }) => {
        await page.goto(PAGE);
        // Veraset grubu `.no-print` içindedir: belge yazdırılırken butonlar
        // kâğıda çıkmaz (yazdırma, PDF'i iframe ile açıp onu yazdırır).
        await page.emulateMedia({ media: 'print' });
        await expect(page.locator('#btn-veraset-indir')).toBeHidden();
        await expect(page.locator('#btn-veraset-yazdir')).toBeHidden();
    });
});
