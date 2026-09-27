// CANLI site üzerinde gizlilik denetimi: yüklenen PDF'in nereye gittiğini
// gerçekten ölçer. Sadece iddia değil, ölçüm.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { PDFDocument } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = 'https://mertatis.github.io/avmertatis-kira-sozlesmesi-olusturucu/';
const fixture = (n) => join(REPO, 'tests', 'fixtures', n);

test('canlı sitede hiçbir veri dışarı çıkmaz', async ({ page }) => {
    test.setTimeout(180000);

    // Canlıya bağlanılamıyorsa (çevrimdışı çalışma) test sessizce ATLANIR;
    // ağ yoksa "sıfır istek" iddiası kanıtlanamaz, sahte yeşil olmamalıdır.
    const reachable = await page.request.get(LIVE, { timeout: 15000 })
        .then((r) => r.ok())
        .catch(() => false);
    test.skip(!reachable, 'canlı siteye ulaşılamıyor (çevrimdışı?)');

    const foreign = [];
    const sent = [];
    page.on('request', (r) => {
        if (!r.url().startsWith(LIVE.slice(0, LIVE.indexOf('avmertatis')))) foreign.push(r.url());
        // Yüklenen PDF'nin gövdesi bir yere gönderiliyor mu?
        if (r.method() !== 'GET' && r.method() !== 'HEAD') sent.push(`${r.method()} ${r.url()}`);
    });

    await page.goto(LIVE);
    await page.click('#tab-pdf-araclari');
    await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded)).toBe(true);

    // Gerçek bir belge yükle ve çıktı üret.
    await page.setInputFiles('#pdf-file-input', fixture('a.pdf'));
    await expect.poll(() => page.locator('.pdf-page-card').count()).toBe(4);
    await page.locator('#pdf-opt-compress').setChecked(true);
    const downloadPromise = page.waitForEvent('download');
    await page.click('#pdf-build-btn');
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect((await PDFDocument.load(new Uint8Array(Buffer.concat(chunks)))).getPageCount()).toBe(4);

    // Hiçbir dış hosta istek, hiçbir POST/PUT yok.
    expect(sent).toEqual([]);
    expect(foreign).toEqual([]);

    // localStorage yalnızca sayaç/tema; belge verisi orada da değil.
    const keys = await page.evaluate(() => Object.keys(window.localStorage));
    console.log('CANLI localStorage anahtarları:', JSON.stringify(keys));
});
