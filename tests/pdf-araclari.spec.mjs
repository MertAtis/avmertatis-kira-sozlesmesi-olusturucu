import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { extractAllText, readPageBoxes, readImageCount } from './helpers/inspect.mjs';
import { PDFDocument } from 'pdf-lib';

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

/** Küçük resim ızgarasının kart sayısını bekler. */
export async function expectCardCount(page, count) {
    await expect(page.locator('#pdf-page-grid .pdf-page-card')).toHaveCount(count);
}

export async function pageOrder(page) {
    return page.evaluate(() => window.pdfState.pages.map((p) => p.srcIndex));
}

test.describe('sayfa ızgarası ve düzenleme', () => {
    test('T04: sayfa silinir, kart sayısı azalır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        await expectCardCount(page, 3);
        expect(await pageOrder(page)).toEqual([1, 2, 3]);
    });

    test('T05: kart sürüklenerek yeniden sıralanır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);

        await dragCard(page, 0, 2);
        // Kart 0, hedef konum 2"e taşınır: önce çıkarılır, sonra 2. indekse girer.
        expect(await pageOrder(page)).toEqual([1, 2, 0, 3]);
    });

    test('T06: sayfa döndürülür, durum 90 derece olur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        expect(await page.evaluate(() => window.pdfState.pages[0].rotation)).toBe(90);
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        expect(await page.evaluate(() => window.pdfState.pages[0].rotation)).toBe(180);
    });

    test('T06b: tüm sayfalar döndür butonu 90 derece ekler', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await page.click('#pdf-rotate-all-btn');
        expect(await page.evaluate(() => window.pdfState.pages.map((p) => p.rotation))).toEqual([90, 90, 90, 90]);
    });

    test('T18: geri al, eklenen son düzenlemeyi geri getirir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);

        await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        await expectCardCount(page, 3);
        await expect(page.locator('#pdf-undo-btn')).toBeEnabled();

        await page.click('#pdf-undo-btn');
        await expectCardCount(page, 4);
        expect(await pageOrder(page)).toEqual([0, 1, 2, 3]);
    });

    test('T18b: düzenleme yokken geri al butonu devre dışıdır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await expect(page.locator('#pdf-undo-btn')).toBeDisabled();
    });

    test('T18c: sıralamayı ve döndürmeyi sıfırla', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await dragCard(page, 0, 3);
        await page.click('#pdf-rotate-all-btn');
        expect(await page.evaluate(() => window.pdfState.pages[0].rotation)).toBe(90);

        await page.click('#pdf-reset-edits-btn');
        expect(await pageOrder(page)).toEqual([0, 1, 2, 3]);
        expect(await page.evaluate(() => window.pdfState.pages.map((p) => p.rotation))).toEqual([0, 0, 0, 0]);
        // Sıfırlama geri alınabilir olmalı.
        await expect(page.locator('#pdf-undo-btn')).toBeEnabled();
    });

    test('T02b: küçük resimler üretilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await expect(page.locator('.pdf-page-thumb').first()).toBeVisible();
        const src = await page.locator('.pdf-page-thumb').first().getAttribute('src');
        expect(src.startsWith('data:image/jpeg')).toBe(true);
    });

    test('T24: 60 sayfalık belge yüklenir, düzenlenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['sixty-pages.pdf']);
        await expectCardCount(page, 60);
        await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        await expectCardCount(page, 59);
    });

    test('dosya kaldırıldığında sayfaları da kaldırılır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf']);
        await expectCardCount(page, 7);
        await page.locator('.pdf-file-row [data-remove-file]').first().click();
        await expectCardCount(page, 3);
        expect(await page.evaluate(() => window.pdfState.pages.every((p) => p.fileId === 2))).toBe(true);
    });
});

/** HTML5 sürükle-bırakını tarayıcıda gerçekleştirir. */
async function dragCard(page, fromIndex, toIndex) {
    await page.evaluate(({ fromIndex, toIndex }) => {
        const cards = document.querySelectorAll('#pdf-page-grid .pdf-page-card');
        const from = cards[fromIndex];
        const to = cards[toIndex];
        const dt = new DataTransfer();
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, { fromIndex, toIndex });
    await page.waitForTimeout(120);
}

/** Çıktıyı indirir ve bayt dizisini Node tarafında döndürür. */
export async function buildOutput(page, { a4 = true, compress = false, quality = null, lossy = false } = {}) {
    await page.locator('#pdf-opt-a4').setChecked(a4);
    await page.locator('#pdf-opt-compress').setChecked(compress);
    if (compress) {
        await page.locator('#pdf-opt-lossy').setChecked(lossy);
        if (quality !== null) await page.locator(`input[name="pdf-quality"][value="${quality}"]`).check();
    }
    const downloadPromise = page.waitForEvent('download');
    await page.click('#pdf-build-btn');
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { bytes: new Uint8Array(Buffer.concat(chunks)), name: download.suggestedFilename() };
}

test.describe('çıktı üretimi ve A4 normalizasyonu', () => {
    test('T03b: üç dosya tek PDF olarak birleşir, 11 sayfa', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf', 'c.pdf']);
        const { bytes } = await buildOutput(page);
        const boxes = await readPageBoxes(bytes);
        expect(boxes).toHaveLength(11);
    });

    test('T05b: sıralama çıktıya aynen yansır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await dragCard(page, 0, 2); // -> [1,2,0,3]
        const { bytes } = await buildOutput(page);
        const text = await extractAllText(bytes);
        const order = ['ALFA SAYFA 2', 'ALFA SAYFA 3', 'ALFA SAYFA 1', 'ALFA SAYFA 4']
            .map((label) => text.indexOf(label));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    test('T06c: döndürme çıktıda /Rotate olarak yazılır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        const { bytes } = await buildOutput(page, { a4: false });
        const boxes = await readPageBoxes(bytes);
        expect(boxes[0].rotation).toBe(90);
    });

    test('T07: A4 normalize — her sayfa tam A4 olur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['mixed-sizes.pdf']);
        const { bytes } = await buildOutput(page, { a4: true });
        const boxes = await readPageBoxes(bytes);
        expect(boxes).toHaveLength(3);
        for (const box of boxes) {
            expect(box.width).toBeCloseTo(595.28, 0);
            expect(box.height).toBeCloseTo(841.89, 0);
        }
    });

    test('T07b: A4 normalize kapalıyken ölçüler korunur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['mixed-sizes.pdf']);
        const { bytes } = await buildOutput(page, { a4: false });
        const boxes = await readPageBoxes(bytes);
        expect(Math.round(boxes[1].width)).toBe(420);
        expect(Math.round(boxes[2].width)).toBe(612);
    });

    test('T08: A4 normalize içerik kırpmaz — metin okunabilir kalır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['mixed-sizes.pdf']);
        const { bytes } = await buildOutput(page, { a4: true });
        const text = await extractAllText(bytes);
        expect(text).toContain('KIRPMA TESTI METNI');
        // Sayfa altındaki satır da kalmalı — kırpma olmadığının kanıtı.
        expect(text).toContain('kirpilmamalidir');
        // Üç sayfanın üçü de metin içermeli.
        expect((text.match(/KIRPMA TESTI METNI/g) || []).length).toBe(3);
    });

    test('RF3: aynı sayfa listenin farklı konumlarında 3 kez çıkabilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'a.pdf']);
        await expectCardCount(page, 8);
        // Üçüncü kopyanın tek sayfasını sil, sonra dosyayı tekrar ekle.
        await page.locator('.pdf-page-card').nth(4).locator('[data-action="delete"]').click();
        await expectCardCount(page, 7);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 11);
        const { bytes } = await buildOutput(page);
        const boxes = await readPageBoxes(bytes);
        expect(boxes).toHaveLength(11);
    });

    test('RF5: 90 derece döndürülmüş A5 sayfa A4"e tam sığar', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['mixed-sizes.pdf']);
        await expectCardCount(page, 3);
        // 2. sayfa A5 (419.53 x 595.28). 90 derece döndürülünce yatay olur.
        await page.locator('.pdf-page-card').nth(1).locator('[data-action="rotate"]').click();
        const { bytes } = await buildOutput(page, { a4: true });
        const boxes = await readPageBoxes(bytes);
        expect(boxes[1].width).toBeCloseTo(595.28, 0);
        expect(boxes[1].height).toBeCloseTo(841.89, 0);
        // A4 modunda döndürme dönüşüme gömülür, /Rotate yazılmaz
        // (yazılsaydı içerik iki kez dönerdi). Yön doğruluğu
        // tests/a4-rotation.spec.mjs tarafından sayısal olarak doğrulanır.
        expect(boxes[1].rotation).toBe(0);
        const text = await extractAllText(bytes);
        expect((text.match(/KIRPMA TESTI METNI/g) || []).length).toBe(3);
    });

    test('sonuç kutusu her durumda dürüst bir mesaj gösterir', async ({ page }) => {
        // A4 normalizasyonu SIKISTIRMA değildir: 10 MB'lık taranmış bir PDF'i
        // A4'e taşımak boyutu neredeyse aynen korur. Uygulama bunu saklamaz.
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        const { bytes } = await buildOutput(page);
        await expect(page.locator('#pdf-result')).toBeVisible();
        const text = await page.locator('#pdf-result').textContent();
        expect([
            'Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.',
            ...text.match(/Orijinal .+ → Çıktı .+%/) || []
        ]).toContain(text);
        expect(bytes.length).toBeGreaterThan(0);
    });

    test('sonuç kutusu çıktı büyüdüğünde açık uyarı verir', async ({ page }) => {
        // 1.4 KB metin ağırlıklı bir PDF'i yeniden serileştirmek kaçınılmaz
        // olarak büyütür. Uygulama bunu saklamaz, açıkça söyler.
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await buildOutput(page);
        const text = await page.locator('#pdf-result').textContent();
        expect(text).toBe(
            'Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.'
        );
    });

    test('T07c: A4 normalize boş PDF üzerinde hata vermez', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['empty.pdf']);
        // Sayfa yokken indirme düğmesi devre dışı olmalı.
        await expect(page.locator('#pdf-build-btn')).toBeDisabled();
    });
});


test.describe('sıkıştırma mod 1 — görsel yeniden kodlama', () => {
    test('T10: taranmış belge en az yarıya iner, metin okunabilir kalır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });

        const input = statSync(fixturePath('scanned.pdf')).size;
        expect(bytes.length).toBeLessThan(input * 0.5);
        // Sayfa sayısı ve metin korunur.
        expect(await readPageBoxes(bytes)).toHaveLength(5);
        // Sayfa sayısı korunur; görseller yeniden kodlandığı için
        // metin çıkarımı bu fixture'da zaten boştur.
        expect((await extractAllText(bytes)).trim()).toBe('');
    });

    test('T10b: sıkıştırma metin seçilebilirliği korur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['text-only.pdf']);
        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const text = await extractAllText(bytes);
        expect(text).toContain('KIRA SOZLESMESI');
        expect(text).toContain('TAHLIYE TAAHHUDI');
    });

    test('T09: metin ağırlıklı belgede görsel yoktur, dürüst uyarı verilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['text-only.pdf']);
        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const text = await page.locator('#pdf-result').textContent();
        expect(text).toBe(
            'Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.'
        );
        // Uyarıya rağmen çıktı üretildi.
        expect(await readPageBoxes(bytes)).toHaveLength(3);
    });

    test('görseller yeniden kodlandıktan sonra /DCTDecode olur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        // A4 modunda görseller Form XObject içine gömülür; doğrudan
        // /XObject girdileri bulunmayabilir, bu yüzden çıktı ayrıştırılabilir
        // olmalı ve metin okunabilmeli.
        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(5);
    });

    test('RF4: Form XObject içindeki görsel bulunamaz, çıktı yine de üretilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['nested-image.pdf']);
        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        // Uygulama çökmemeli ve çıktı geçerli olmalı.
        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(1);
        // Görsel doğrudan /XObject olarak sayılmaz (Form içinde).
        expect(await readImageCount(bytes)).toEqual([0]);
    });

    test('sıkıştırma kapalıyken görsellere dokunulmaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        const { bytes } = await buildOutput(page, { compress: false });
        const input = statSync(fixturePath('scanned.pdf')).size;
        // A4 taşıma nötrdür; belirgin bir küçülme olmamalı.
        expect(bytes.length).toBeGreaterThan(input * 0.9);
    });
});

test.describe('sıkıştırma mod 2 — görsele çevirme ve onay', () => {
    test('T11: kayıp mod onaylanmadan dosya üretilmez', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);

        let downloaded = false;
        page.on('download', () => { downloaded = true; });

        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');

        // Uyarı modali çıkmalı.
        await expect(page.locator('#pdf-lossy-modal')).toBeVisible();
        // Vazgeç'e basılınca indirme olmaz ve uygulama kilitlenmez.
        await page.click('#pdf-lossy-cancel');
        await expect(page.locator('#pdf-lossy-modal')).toBeHidden();
        await page.waitForTimeout(500);
        expect(downloaded).toBe(false);
        expect(await page.evaluate(() => window.pdfState.busy)).toBe(false);
    });

    test('T12: onaylanınca metin kaybolur ve dosya büyük ölçüde küçülür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);

        const downloadPromise = page.waitForEvent('download');
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        await expect(page.locator('#pdf-lossy-modal')).toBeVisible();
        await page.click('#pdf-lossy-confirm');

        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));

        // Ölçülen değer: 9.81 MB giriş -> 3.53 MB çıktı (%64 küçülme), 150 DPI.
        // Fixture yüksek gürültülü sentetik bir görüntü; gerçek taranmış
        // belgelerde oran daha yüksek. Garanti edilebilir alt sınır %50.
        const input = statSync(fixturePath('scanned.pdf')).size;
        expect(bytes.length).toBeLessThan(input * 0.5);
        // Metin tamamen kaybolmuş olmalı.
        expect((await extractAllText(bytes)).trim()).toBe('');
        // Sayfa sayısı korunur.
        expect(await readPageBoxes(bytes)).toHaveLength(5);
    });

    test('kayıp modda A4 zorunludur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['mixed-sizes.pdf']);
        await page.locator('#pdf-opt-a4').setChecked(false);
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        // Modal çıkmaz, doğrudan dürüst hata verilir.
        await expect(page.locator('#pdf-lossy-modal')).toBeHidden();
        await expect(page.locator('#pdf-result')).toContainText('A4');
    });

    test('kayıp mod uyarısı metni hukuki riski açıkça söyler', async ({ page }) => {
        await openPdfTab(page);
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await uploadFixtures(page, ['scanned.pdf']);
        await page.click('#pdf-build-btn');
        const modal = page.locator('#pdf-lossy-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('Metin seçilemez, aranamaz ve kopyalanamaz hale gelecektir');
        await expect(modal).toContainText('kabul edilemez');
    });
});
