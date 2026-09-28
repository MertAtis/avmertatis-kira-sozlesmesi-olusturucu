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

test.describe('EK-1 / EK-2 damgası', () => {
    test('E1: her sayfada iki düğme var, biri diğerini kapatır, tekrar basınca kalkar', async ({ page }) => {
        await openWith(page, [A]);
        const card = page.locator('.pdf-page-card').first();
        await card.locator('[data-action="ek1"]').click();
        await expect(page.locator('.pdf-page-card').first().locator('[data-action="ek1"]')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('.pdf-page-card').first().locator('[data-action="ek2"]').click();
        const first = page.locator('.pdf-page-card').first();
        await expect(first.locator('[data-action="ek1"]')).toHaveAttribute('aria-pressed', 'false');
        await expect(first.locator('[data-action="ek2"]')).toHaveAttribute('aria-pressed', 'true');
        await first.locator('[data-action="ek2"]').click();
        await expect(page.locator('.pdf-page-card').first().locator('[data-action="ek2"]')).toHaveAttribute('aria-pressed', 'false');
    });

    test('E2: damga yalnız seçili sayfada, sağ üstte; sayfanın geri kalanı piksel piksel aynı', async ({ page }) => {
        await openWith(page, [A]);
        const before = await analyse(page, await build(page));
        await page.locator('.pdf-page-card').nth(1).locator('[data-action="ek1"]').click();
        await page.locator('.pdf-page-card').nth(2).locator('[data-action="ek2"]').click();
        const bytes = await build(page);
        const after = await analyse(page, bytes);
        expect(after.length).toBe(before.length);
        for (let i = 0; i < after.length; i++) {
            expect(after[i].outsideSum, `sayfa ${i + 1} değişmemeli`).toBe(before[i].outsideSum);
            if (i === 1 || i === 2) expect(after[i].inside).toBeGreaterThan(before[i].inside + 40);
            else expect(after[i].inside).toBe(before[i].inside);
        }
    });

    for (const mode of ['A4', 'Küçült']) {
        test(`E3: döndürülmüş sayfada da görünen sağ üst köşede (${mode})`, async ({ page }) => {
            await openWith(page, [A]);
            await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
            await page.locator('.pdf-page-card').first().locator('[data-action="ek1"]').click();
            const bytes = await build(page, mode === 'A4' ? '#pdf-build-btn' : '#pdf-build-small-btn');
            const [p1] = await analyse(page, bytes);
            expect(p1.inside).toBeGreaterThan(40);
            expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
        });
    }

    for (const turns of [1, 2, 3]) {
        test(`E5: A4 kapalıyken /Rotate'li sayfada (${turns * 90}°) damga sağ üstte`, async ({ page }) => {
            await openWith(page, [A]);
            await page.locator('#pdf-advanced').evaluate((el) => { el.open = true; });
            await page.locator('#pdf-opt-a4').uncheck();
            for (let i = 0; i < turns; i++) await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
            await page.locator('.pdf-page-card').first().locator('[data-action="ek2"]').click();
            const bytes = await build(page);
            const doc = await PDFDocument.load(bytes);
            expect(doc.getPage(0).getRotation().angle % 360).not.toBe(0);
            const [p1] = await analyse(page, bytes);
            expect(p1.inside).toBeGreaterThan(40);
        });
    }

    test('E4: Sıfırla EK etiketlerini de kaldırır, Geri Al geri getirir', async ({ page }) => {
        await openWith(page, [A]);
        await page.locator('.pdf-page-card').first().locator('[data-action="ek1"]').click();
        await page.click('#pdf-reset-edits-btn');
        await expect(page.locator('.pdf-page-card').first().locator('[data-action="ek1"]')).toHaveAttribute('aria-pressed', 'false');
        await page.click('#pdf-undo-btn');
        await expect(page.locator('.pdf-page-card').first().locator('[data-action="ek1"]')).toHaveAttribute('aria-pressed', 'true');
    });
});
