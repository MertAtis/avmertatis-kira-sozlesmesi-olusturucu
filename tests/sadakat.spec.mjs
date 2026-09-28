// Belge sadakati: kullanıcının yüklediği belgeye çıktıda HİÇBİR şey
// eklenmemeli ve HİÇBİR şey çıkarılmamalı. Görünümü değiştirmeyi kullanıcı
// açıkça seçmediği sürece (kayıplı "kaliteyi düşür" / "görsele çevir"),
// çıktı sayfası kaynak sayfayla aynı görünmelidir.
//
// Ölçüm tarayıcıda, pdf.js ile yapılır: kaynak ve çıktı sayfaları not/damga
// görünümleri DAHİL (AnnotationMode.ENABLE) canvas'a çizilir ve pikseller
// karşılaştırılır. A4'e sığdırmada çıktı sayfası kaynağın ölçeklenmiş
// hâlidir; kaynak aynı ölçekte çizilip çıktıdaki yerleşim bölgesiyle
// karşılaştırılır.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

// Yardımcılar pdf-araclari.spec.mjs'ten İÇE AKTARILMAZ: içe aktarma o
// dosyanın tüm testlerini de bu dosyanın altında yeniden kaydeder.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = (name) => join(REPO, 'tests', 'fixtures', name);

async function openPdfTab(page) {
    await page.goto('file://' + join(REPO, 'index.html'));
    await page.click('#tab-pdf-araclari');
    await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded), { timeout: 30000 }).toBe(true);
    // Ayrıntılı seçenekler kapalı "Gelişmiş ayarlar" altındadır; testler onlara erişebilsin.
    await page.evaluate(() => { const d = document.getElementById('pdf-advanced'); if (d) d.open = true; });
}

async function uploadFixtures(page, names) {
    await page.setInputFiles('#pdf-file-input', names.map(fixturePath));
    await expect.poll(() => page.evaluate(() => window.pdfState.busy), { timeout: 120000 }).toBe(false);
}

async function buildOutput(page, { a4, compress }) {
    await page.locator('#pdf-opt-a4').setChecked(a4);
    await page.locator('#pdf-opt-compress').setChecked(compress);
    if (compress) await page.locator('input[name="pdf-compress-mode"][value="lossless"]').check();
    const downloadPromise = page.waitForEvent('download');
    await page.click('#pdf-build-btn');
    const download = await downloadPromise;
    return readFileSync(await download.path());
}

// Ölçüm için gerekli olmayan ya da reddedilen dosyalar dışarıda bırakılır.
const FIXTURES = [
    'a.pdf', 'text-only.pdf', 'Ahmet & Ayse-test.pdf', 'fatura-a.pdf',
    'stamped.pdf', 'form-field.pdf', 'form-field-a4.pdf', 'no-contents-annot.pdf',
    'content-seam.pdf', 'cropbox.pdf', 'inherited-rotate.pdf', 'source-rotated.pdf',
    'mixed-sizes.pdf', 'landscape-a4.pdf', 'shared-resources.pdf',
    'duplicate-images.pdf', 'same-bytes-diff-decode.pdf', 'nested-image.pdf',
    'pattern.pdf', 'pure-bw.pdf', 'pure-bw-decode.pdf', 'scanned.pdf',
    'indexed.pdf', 'iccbased.pdf', 'smask.pdf', 'cmyk.pdf', 'jpeg-only.pdf'
];

const MODES = [
    { name: 'olduğu gibi', opts: { a4: false, compress: false } },
    { name: 'kayıpsız küçült', opts: { a4: false, compress: true } },
    { name: "A4'e sığdır", opts: { a4: true, compress: false } },
    { name: "A4'e sığdır + kayıpsız", opts: { a4: true, compress: true } }
];

// 1 pt = 2 piksel. Metin kenarlarındaki yumuşatma farkı ölçeklemede
// kaçınılmazdır; 64'ten büyük renk farkı "gerçek fark" sayılır.
const PX_PER_PT = 2;
const STRONG_DIFF = 64;

/**
 * Kaynak ve çıktıyı sayfa sayfa çizer ve karşılaştırır.
 * Dönüş: her sayfa için {srcW, srcH, outW, outH, diffRatio, diffBox}.
 */
async function comparePages(page, srcBytes, outBytes, fitA4) {
    return page.evaluate(async ({ src, out, fitA4, pxPerPt, strong }) => {
        await pdfEnsureWorker();
        const lib = window.pdfjsLib;
        // Baytlar base64 ile taşınır: sayı dizisi büyük taramada belleği taşırır.
        const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const open = (b64) => lib.getDocument({ data: fromB64(b64) }).promise;
        const [srcDoc, outDoc] = await Promise.all([open(src), open(out)]);

        const render = async (pdfPage, scale) => {
            const vp = pdfPage.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await pdfPage.render({
                canvasContext: ctx, viewport: vp,
                annotationMode: lib.AnnotationMode.ENABLE
            }).promise;
            return { w: canvas.width, h: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
        };

        const results = [];
        results.pageCounts = [srcDoc.numPages, outDoc.numPages];
        const n = Math.min(srcDoc.numPages, outDoc.numPages);
        for (let i = 1; i <= n; i++) {
            const sp = await srcDoc.getPage(i);
            const op = await outDoc.getPage(i);
            const sv = sp.getViewport({ scale: 1 });
            const ov = op.getViewport({ scale: 1 });

            // A4 modunda kaynak, çıktıdaki yerleşim ölçeğiyle çizilir ve
            // ortalanmış bölgeyle karşılaştırılır.
            const fit = fitA4 ? Math.min(ov.width / sv.width, ov.height / sv.height) : 1;
            const s = await render(sp, pxPerPt * fit);
            const o = await render(op, pxPerPt);
            const offX = fitA4 ? Math.round((o.w - s.w) / 2) : 0;
            const offY = fitA4 ? Math.round((o.h - s.h) / 2) : 0;

            let diff = 0, total = 0;
            let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
            for (let y = 0; y < s.h; y++) {
                const oy = y + offY;
                if (oy < 0 || oy >= o.h) continue;
                for (let x = 0; x < s.w; x++) {
                    const ox = x + offX;
                    if (ox < 0 || ox >= o.w) continue;
                    const a = (y * s.w + x) * 4;
                    const b = (oy * o.w + ox) * 4;
                    const d = Math.max(
                        Math.abs(s.data[a] - o.data[b]),
                        Math.abs(s.data[a + 1] - o.data[b + 1]),
                        Math.abs(s.data[a + 2] - o.data[b + 2])
                    );
                    total++;
                    if (d > strong) {
                        diff++;
                        if (x < minX) minX = x; if (y < minY) minY = y;
                        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
                    }
                }
            }
            results.push({
                page: i,
                src: [Math.round(sv.width), Math.round(sv.height)],
                out: [Math.round(ov.width), Math.round(ov.height)],
                diffRatio: total ? diff / total : 1,
                diffBox: diff ? [minX, minY, maxX, maxY] : null
            });
        }
        return { pageCounts: results.pageCounts, pages: [...results] };
    }, { src: Buffer.from(srcBytes).toString('base64'), out: Buffer.from(outBytes).toString('base64'), fitA4, pxPerPt: PX_PER_PT, strong: STRONG_DIFF });
}

for (const mode of MODES) {
    test.describe(`sadakat — ${mode.name}`, () => {
        for (const name of FIXTURES) {
            test(`${name}: ekleme/çıkarma yok`, async ({ page }) => {
                test.setTimeout(120000);
                await openPdfTab(page);
                await uploadFixtures(page, [name]);
                const bytes = await buildOutput(page, mode.opts);
                const r = await comparePages(page, readFileSync(fixturePath(name)), bytes, mode.opts.a4);

                expect(r.pageCounts[1], 'sayfa sayısı').toBe(r.pageCounts[0]);
                for (const p of r.pages) {
                    if (!mode.opts.a4) expect(p.out, `s.${p.page} boyut`).toEqual(p.src);
                    // Olduğu gibi modunda birebir; A4'te ölçekleme yumuşatması payı.
                    const limit = mode.opts.a4 ? 0.002 : 0;
                    expect(p.diffRatio, `s.${p.page} farklı piksel oranı, bölge ${JSON.stringify(p.diffBox)}`)
                        .toBeLessThanOrEqual(limit);
                }
            });
        }
    });
}
