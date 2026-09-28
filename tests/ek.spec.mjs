// EK-1 / EK-2 damgası: seçilen sayfanın görünen sağ üst köşesine yazılır,
// sayfanın geri kalanı HİÇ değişmez; damgasız sayfalara dokunulmaz.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');
const A = join(REPO, 'tests', 'fixtures', 'a.pdf');

async function openWith(page, files) {
    await page.goto(PAGE);
    await page.click('#tab-pdf-araclari');
    await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded), { timeout: 30000 }).toBe(true);
    await page.setInputFiles('#pdf-file-input', files);
    await expect.poll(() => page.evaluate(() => window.pdfState.busy), { timeout: 60000 }).toBe(false);
}

async function build(page, button = '#pdf-build-btn') {
    const dl = page.waitForEvent('download');
    await page.click(button);
    return readFileSync(await (await dl).path());
}

/** Her sayfayı çizer; sağ üst 130x60 bölgedeki koyu piksel sayısı + bölge DIŞI piksel özeti. */
async function analyse(page, bytes) {
    return page.evaluate(async (b64) => {
        await pdfEnsureWorker();
        const doc = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
        const out = [];
        for (let n = 1; n <= doc.numPages; n++) {
            const p = await doc.getPage(n);
            const vp = p.getViewport({ scale: 1 });
            const c = document.createElement('canvas');
            c.width = Math.round(vp.width); c.height = Math.round(vp.height);
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
            await p.render({ canvasContext: ctx, viewport: vp }).promise;
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let inside = 0, outsideSum = 0;
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
                const i = (y * c.width + x) * 4;
                const dark = d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100;
                if (x > c.width - 130 && y < 60) { if (dark) inside++; }
                else outsideSum = (outsideSum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 1000000007;
            }
            out.push({ inside, outsideSum });
        }
        return out;
    }, Buffer.from(bytes).toString('base64'));
}

/** Ana listedeki n. kartı (0 tabanlı) seçip EK bölmesine taşır. */
async function moveToEk(page, mainIndices, ek) {
    for (const i of mainIndices) await page.locator('#pdf-page-grid .pdf-page-card').nth(i).locator('[data-action="sel"]').check();
    const existing = page.locator(`#pdf-sel-actions [data-ek-target="${ek}"]`);
    await (await existing.count() ? existing : page.locator('#pdf-sel-actions [data-ek-target="new"]')).click();
}

test.describe('EK-1 / EK-2 bölmeleri', () => {
    test('E1: seçim çubuğu, bölmeler ve geri dönüş', async ({ page }) => {
        await openWith(page, [A]);
        await expect(page.locator('#pdf-sel-bar')).toBeHidden();
        await expect(page.locator('#pdf-ek-box-1')).toBeHidden();
        const total = await page.locator('.pdf-page-card').count();
        await moveToEk(page, [1, 2], 1);
        await expect(page.locator('#pdf-ek-box-1 .pdf-page-card')).toHaveCount(2);
        await expect(page.locator('#pdf-page-grid .pdf-page-card')).toHaveCount(total - 2);
        await expect(page.locator('#pdf-ek-box-2')).toBeHidden();
        await moveToEk(page, [0], 2);
        await expect(page.locator('#pdf-ek-box-2 .pdf-page-card')).toHaveCount(1);
        // Bölmeden ana listeye geri al
        await page.locator('#pdf-ek-box-1 .pdf-page-card').first().locator('[data-action="sel"]').check();
        await page.click('#pdf-to-main');
        await expect(page.locator('#pdf-ek-box-1 .pdf-page-card')).toHaveCount(1);
        // Geri Al son taşımayı geri getirir
        await page.click('#pdf-undo-btn');
        await expect(page.locator('#pdf-ek-box-1 .pdf-page-card')).toHaveCount(2);
    });

    test('E2: damga yalnız her bölmenin İLK sayfasında, sağ üstte; diğer her şey aynı; sıra: ana, EK-1, EK-2', async ({ page }) => {
        await openWith(page, [A]);
        const before = await analyse(page, await build(page));
        // Ana listeden: sayfa 1,2 -> EK-1 ; sayfa 3 -> EK-2 (a.pdf 4 sayfa)
        await moveToEk(page, [1, 2], 1);
        await moveToEk(page, [1], 2);   // 2 taşındıktan sonra ana listede [0,3]; index 1 = orijinal sayfa 4
        const after = await analyse(page, await build(page));
        expect(after.length).toBe(before.length);
                const marked = after.map((r, i) => r.inside > 40 ? i : -1).filter((i) => i >= 0);
        // Ana 1 sayfa, EK-1 (2 sayfa: yalnız ilki damgalı), EK-2 (1 sayfa, damgalı)
        expect(marked).toEqual([1, 3]);
    });

    for (const mode of ['A4', 'Küçült']) {
        test(`E3: döndürülmüş EK sayfasında da görünen sağ üst köşede (${mode})`, async ({ page }) => {
            await openWith(page, [A]);
            await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
            await moveToEk(page, [0], 1);
            const bytes = await build(page, mode === 'A4' ? '#pdf-build-btn' : '#pdf-build-small-btn');
            const rows = await analyse(page, bytes);
            expect(rows[rows.length - 1].inside).toBeGreaterThan(40);
        });
    }

    for (const turns of [1, 2, 3]) {
        test(`E5: A4 kapalıyken /Rotate'li sayfada (${turns * 90}°) damga sağ üstte`, async ({ page }) => {
            await openWith(page, [A]);
            await page.locator('#pdf-advanced').evaluate((el) => { el.open = true; });
            await page.locator('#pdf-opt-a4').uncheck();
            for (let i = 0; i < turns; i++) await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
            await moveToEk(page, [0], 2);
            const bytes = await build(page);
            const doc = await PDFDocument.load(bytes);
            expect(doc.getPage(doc.getPageCount() - 1).getRotation().angle % 360).not.toBe(0);
            const rows = await analyse(page, bytes);
            expect(rows[rows.length - 1].inside).toBeGreaterThan(40);
        });
    }

    test('E4: EK bölmesi yokken çıktı eski sistemle aynı (damga yok)', async ({ page }) => {
        await openWith(page, [A]);
        const rows = await analyse(page, await build(page));
        const base = rows.map((r) => r.inside);
        await moveToEk(page, [0], 1);
        await page.click('#pdf-undo-btn');
        const again = (await analyse(page, await build(page))).map((r) => r.inside);
        expect(again).toEqual(base);
    });

    test('E6: EK-5\'e kadar: her seçim "EK-n YAP" ile bir sonraki numarayı alır, hepsi damgalı', async ({ page }) => {
        await openWith(page, [A, A]);   // 8 sayfa
        for (let n = 1; n <= 5; n++) {
            await page.locator('#pdf-page-grid .pdf-page-card').first().locator('[data-action="sel"]').check();
            await expect(page.locator('#pdf-sel-actions [data-ek-target="new"]')).toContainText(`EK-${n}`);
            await page.click('#pdf-sel-actions [data-ek-target="new"]');
            await expect(page.locator(`#pdf-ek-box-${n} .pdf-page-card`)).toHaveCount(1);
        }
        const rows = await analyse(page, await build(page));
        expect(rows.length).toBe(8);
        expect(rows.map((r, i) => (r.inside > 40 ? i : -1)).filter((i) => i >= 0)).toEqual([3, 4, 5, 6, 7]);
    });

    test('E7: bölme boşalınca numaralar kayar (EK-1,EK-2 -> biri boşalırsa EK-1 kalır)', async ({ page }) => {
        await openWith(page, [A]);
        await moveToEk(page, [0], 1);
        await moveToEk(page, [0], 2);
        await expect(page.locator('#pdf-ek-box-2')).toBeVisible();
        await page.locator('#pdf-ek-box-1 .pdf-page-card').first().locator('[data-action="sel"]').check();
        await page.click('#pdf-to-main');
        await expect(page.locator('#pdf-ek-box-1 .pdf-page-card')).toHaveCount(1);
        await expect(page.locator('#pdf-ek-box-2')).toHaveCount(0);
    });
});
