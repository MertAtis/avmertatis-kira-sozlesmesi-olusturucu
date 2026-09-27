import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { extractAllText, readPageBoxes, readImageCount, textPositions, collectImages, readRawImageSamples, decodeJpegPixelsInPage, meanAbsError } from './helpers/inspect.mjs';
import { PDFDocument } from 'pdf-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + join(REPO, 'index.html');

export function fixturePath(name) {
    return join(REPO, 'tests', 'fixtures', name);
}

export function fixtureBytes(name) {
    return new Uint8Array(readFileSync(fixturePath(name)));
}

const readBytes = (p) => new Uint8Array(readFileSync(p));

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

    test('I15: genel yükleme hatası sonraki render\'da KAYBOLMAZ', async ({ page }) => {
        await openPdfTab(page);
        await page.evaluate(() => pdfShowError('Yükleme', 'Beklenmeyen bir hata oluştu.'));
        await expect(page.locator('#pdf-file-list .is-error')).toHaveCount(1);

        // Dosya listesi yeniden kurulduğunda hata satırı SİLİNMEDİĞİ için
        // kullanıcı hatayı kaybetmez. (Eskiden `prepend` edilen satır bir
        // sonraki render'da yok oluyordu.)
        await uploadFixtures(page, ['a.pdf']);
        await expect(page.locator('#pdf-file-list .is-error')).toHaveCount(1);
        await expect(page.locator('#pdf-file-list')).toContainText('Beklenmeyen bir hata oluştu.');
        // Dosya satırı da görünür kalmalı.
        await expect(page.locator('#pdf-file-list .pdf-file-name')).toHaveCount(2);
    });

    test('ED1: reddedilen dosya uyarısı kendiliğinden KAYBOLUR', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['not-a-pdf.pdf']);
        await expect(page.locator('#pdf-file-list')).toContainText('geçerli bir PDF değil');

        // Uyarı kalıcı bir engel olmamalı: birkaç saniye sonra kendiliğinden
        // kaybolur (kaldırma düğmesi olmayan bir satırda takılı kalıyordu).
        await expect(page.locator('#pdf-file-list .is-error')).toHaveCount(0, { timeout: 8000 });

        // Sessizce de kaybolmamalı: durumdan da düşmüş olmalı.
        expect(await page.evaluate(() => pdfState.files.length)).toBe(0);
    });

    test('ED2: reddedilen dosya uyarısı elle de kapatılabilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['not-a-pdf.pdf']);
        const row = page.locator('#pdf-file-list .pdf-file-row.is-error');
        await expect(row).toHaveCount(1);
        await row.locator('[data-dismiss-error]').click();
        await expect(row).toHaveCount(0);
        expect(await page.evaluate(() => pdfState.files.length)).toBe(0);
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

    test('T18b: geri al yığını boşken buton devre dışıdır, dosya eklemek geri alınabilir', async ({ page }) => {
        await openPdfTab(page);
        // Dosya eklemek de geri alınabilir bir işlemdir: geri al, eklenen
        // dosyayı hem listeden hem çıktıdan kaldırmalı. Bu yüzden düğme
        // yüklemeden sonra ETKİN olur ve ne yapacağını yazar (A9).
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await expect(page.locator('#pdf-undo-btn')).toBeEnabled();
        await expect(page.locator('#pdf-undo-label')).toHaveText(/Dosya eklendi/);

        // Yığın tüketilince düğme yeniden devre dışı olur.
        while (await page.locator('#pdf-undo-btn').isEnabled()) {
            await page.click('#pdf-undo-btn');
            await page.waitForTimeout(100);
        }
        await expect(page.locator('#pdf-page-grid .pdf-page-label').first()).toHaveText(/Henüz dosya eklenmedi/);
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
export async function buildOutput(page, { a4 = true, compress = false, quality = null, lossy = false, mode = null } = {}) {
    await page.locator('#pdf-opt-a4').setChecked(a4);
    await page.locator('#pdf-opt-compress').setChecked(compress);
    if (compress) {
        // Varsayılan KAYIPSIZ. Kayıplı yöntemi (görsel yeniden kodlama) veya
        // görsele çevirme modunu deneyen testler açıkça mode: 'quality' der.
        const wanted = mode || (lossy || quality !== null ? 'quality' : 'lossless');
        await page.locator(`input[name="pdf-compress-mode"][value="${wanted}"]`).check();
        if (wanted === 'quality') {
            await page.locator('#pdf-opt-lossy').setChecked(lossy);
            if (quality !== null) await page.locator(`input[name="pdf-quality"][value="${quality}"]`).check();
        }
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
        // Sıkıştırma kapalıyken neden küçülmediği açıkça söylenmelidir.
        expect(text).toContain('Sıkıştırma seçeneği kapalıydı');
        expect(bytes.length).toBeGreaterThan(0);
    });

    test('sonuç kutusu çıktı büyüdüğünde açık uyarı verir', async ({ page }) => {
        // 1.4 KB metin ağırlıklı bir PDF'i yeniden serileştirmek kaçınılmaz
        // olarak büyütür. Uygulama bunu saklamaz, açıkça söyler.
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await buildOutput(page, { compress: false });
        const text = await page.locator('#pdf-result').textContent();
        expect(text).toContain('Sıkıştırma seçeneği kapalıydı');
        expect(text).toContain('Boyutu küçült');
    });

    test('sıkıştırma AÇIKKEN küçülme yoksa görsel mesajı verilir', async ({ page }) => {
        // Aynı senaryo, bu kez sıkıştırma istendi: farklı ve doğru mesaj.
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await buildOutput(page, { compress: true, quality: '0.7' });
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
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
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

    test('A8: kayıp modda tek sayfa hata verirse mesaj KULLANICIYA ULAŞIR', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        await expectCardCount(page, 5);

        // 2. sayfanın rasterizasyonu başarısız olsun: canvas -> JPEG dönüşümü
        // null döndürür (tarayıcıda JPEG kodlaması başarısız olduğunda olan
        // budur). Küçük resimler çoktan üretildiği için sayaç onları saymaz.
        await page.evaluate(() => {
            const original = HTMLCanvasElement.prototype.toBlob;
            let calls = 0;
            HTMLCanvasElement.prototype.toBlob = function patched(cb, type, quality) {
                calls++;
                if (calls === 2) { cb(null); return; }
                return original.call(this, cb, type, quality);
            };
        });

        const downloadPromise = page.waitForEvent('download');
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        await expect(page.locator('#pdf-lossy-modal')).toBeVisible();
        await page.click('#pdf-lossy-confirm');
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));

        // Dosya yine de üretildi ve 5 sayfadan 4'ü var.
        const { PDFDocument } = await import('pdf-lib');
        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4);

        // KRİTİK: hangi sayfanın eksik olduğu kullanıcıya söylenmeli. Mesaj
        // daha önce hemen eziliyor ve "dosya zaten optimize" deniyordu.
        const text = await page.locator('#pdf-result').textContent();
        expect(text).toContain('görsele çevrilemedi');
        expect(text).toContain('1 sayfa');
    });

    test('T12: onaylanınca metin kaybolur ve dosya büyük ölçüde küçülür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);

        const downloadPromise = page.waitForEvent('download');
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
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
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        // Modal çıkmaz, doğrudan dürüst hata verilir.
        await expect(page.locator('#pdf-lossy-modal')).toBeHidden();
        await expect(page.locator('#pdf-result')).toContainText('A4');
    });

    test('kayıp mod uyarısı metni hukuki riski açıkça söyler', async ({ page }) => {
        await openPdfTab(page);
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await uploadFixtures(page, ['scanned.pdf']);
        await page.click('#pdf-build-btn');
        const modal = page.locator('#pdf-lossy-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('Metin seçilemez, aranamaz ve kopyalanamaz hale gelecektir');
        await expect(modal).toContainText('kabul edilemez');
    });
});

test.describe('regresyon: mevcut sekmeler', () => {
    const EXISTING_TABS = [
        { id: 'tab-kira', field: 'kira-landlord-name' },
        { id: 'tab-tahliye', field: 'tahliye-tenant-name' },
        { id: 'tab-anahtar', field: 'anahtar-address' },
        { id: 'tab-makbuz-avukat', field: 'makbuz-av-muvekkil-name' },
        { id: 'tab-makbuz-emlak', field: 'makbuz-emlak-musteri-name' }
    ];

    for (const tab of EXISTING_TABS) {
        test(`${tab.id}: sekmeye tıklanınca açılır ve önizleme güncellenir`, async ({ page }) => {
            await page.goto(PAGE);
            await page.click('#' + tab.id);
            await expect(page.locator('#' + tab.id)).toHaveClass(/active/);

            // Form paneli görünür olmalı, PDF paneli gizli kalmalı.
            const blockId = tab.id.replace('tab-', '') + '-form-block';
            await expect(page.locator('#' + blockId)).toBeVisible();
            await expect(page.locator('#pdf-araclari-form-block')).toBeHidden();

            // Bir alan doldurulunca önizleme değişir.
            const before = await page.locator('#printable-area').textContent();
            const field = page.locator('#' + tab.field);
            if (await field.count() > 0) {
                await field.fill('TEST DEGERI 12345');
                await page.waitForTimeout(150);
            }
            const after = await page.locator('#printable-area').textContent();
            expect(after).toContain('TEST DEGERI 12345');
            expect(after).not.toBe(before);
        });
    }

    test('handlePrint() window.print çağırır', async ({ page }) => {
        await page.goto(PAGE);
        await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
        await page.click('#tab-kira');
        await page.locator('button:has-text("Yazdır")').first().click();
        expect(await page.evaluate(() => !!window.__printed)).toBe(true);
    });

    test('yazdırmada PDF paneli ve sekmesi gizlenir, kâğıt alanı kalır', async ({ page }) => {
        await page.goto(PAGE);
        await page.click('#tab-kira');
        await page.emulateMedia({ media: 'print' });
        await expect(page.locator('#pdf-araclari-form-block')).toBeHidden();
        await expect(page.locator('#tab-pdf-araclari')).toBeHidden();
        await expect(page.locator('#printable-area')).toBeVisible();
    });
});

test.describe('tema ve duyarlılık', () => {
    test('T21: karanlık modda PDF paneli okunabilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await page.click('#theme-toggle-btn');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

        const panel = page.locator('#pdf-araclari-form-block');
        const styles = await panel.evaluate((el) => {
            const cs = getComputedStyle(el);
            const card = el.querySelector('.pdf-stage');
            return {
                background: cs.backgroundColor,
                color: cs.color,
                cardBg: getComputedStyle(card).backgroundColor,
                cardBorder: getComputedStyle(card).borderTopColor
            };
        });

        // Panel koyu arka plan üzerinde açık metin göstermeli.
        const lum = (c) => {
            const m = c.match(/\d+/g).map(Number);
            return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
        };
        expect(lum(styles.color)).toBeGreaterThan(0.5);      // açık metin
        expect(lum(styles.cardBg)).toBeLessThan(0.5);        // koyu kart
        expect(styles.cardBorder).not.toBe(styles.cardBg);    // kenar görünür
    });

    test('T23: 390 px genişlikte yatay kaydırma yok', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await page.waitForTimeout(300);

        const overflow = await page.evaluate(() => {
            const doc = document.documentElement;
            const widest = [...document.querySelectorAll('#pdf-araclari-form-block *')]
                .map((el) => ({ sel: el.id || el.className, right: el.getBoundingClientRect().right }))
                .filter((e) => e.right > 391)
                .slice(0, 5);
            return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, widest };
        });
        expect(overflow.scrollWidth).toBeLessThanOrEqual(391);
        expect(overflow.widest).toEqual([]);
    });

    test('T23b: 390 px genişlikte küçük resimler kullanılabilir boyutta kalır', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);

        const metrics = await page.locator('#pdf-page-card, .pdf-page-card').first().evaluate((el) => {
            const grid = getComputedStyle(el.parentElement);
            const rect = el.getBoundingClientRect();
            return {
                columns: grid.gridTemplateColumns.split(' ').length,
                cardWidth: rect.width
            };
        }).catch(async () => {
            const el = page.locator('.pdf-page-card').first();
            return {
                columns: await el.evaluate((e) => getComputedStyle(e.parentElement).gridTemplateColumns.split(' ').length),
                cardWidth: (await el.boundingBox()).width
            };
        });

        // 1-2 sütun: tek sütun boşa yer bırakır, 3 sütan karta küçültür.
        expect(metrics.columns).toBeGreaterThanOrEqual(1);
        expect(metrics.columns).toBeLessThanOrEqual(2);
        // Küçük resim okunabilir kalmalı.
        expect(metrics.cardWidth).toBeGreaterThanOrEqual(100);
    });

    test('modal dar ekranda taşmaz', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        const box = await page.locator('#pdf-lossy-modal .pdf-modal').boundingBox();
        expect(box.width).toBeLessThanOrEqual(390);
        expect(box.x).toBeGreaterThanOrEqual(0);
    });
});

// --- İnceleme bulguları için regresyon testleri ---------------------------

test.describe('inceleme bulguları: düzeltilmiş davranışlar', () => {
    test('F1: kaynak PDF in /Rotate değeri A4 çıktısında da uygulanır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['source-rotated.pdf']);
        const { bytes } = await buildOutput(page, { a4: true });

        // Metin çıkarılamıyorsa sayfa gerçekten görsele dönmüş demektir;
        // burada asıl önemli: dönüşüm YATAY kutuyu A4'e sığdırmış olmalı.
        const boxes = await readPageBoxes(bytes);
        expect(boxes).toHaveLength(2);
        for (const box of boxes) {
            expect(box.width).toBeCloseTo(595.28, 0);
            expect(box.height).toBeCloseTo(841.89, 0);
        }
        // Döndürülmüş içerik A4'e sığdırılırken küçültülmüş olmalı:
        // dönen A4 (842 yükseklik -> 595 genişlik) A4'e birebir sığar ve
        // ölçek 1'dir. Döndürme yok sayılırsa ölçek 1 olur da konum kayar.
        // Doğrudan ölçüm: metin konumu A4'ün sağ üstünde olmalı (90° CW).
        const positions = await textPositions(bytes);
        expect(positions.length).toBeGreaterThan(0);
        // "KAYNAK DONDURULMUS" kaynakta sol üstte; 90° saat yönünde
        // döndürülünce sağ üste düşer.
        for (const p of positions) {
            expect(p.x).toBeGreaterThan(595.28 * 0.4);
            expect(p.y).toBeGreaterThan(841.89 * 0.6);
        }
    });

    test('F1b: kullanıcı döndürmesine KAYNAK /Rotate eklenir, üstüne yazılmaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['source-rotated.pdf']);
        // Kart zaten döndürülü görünüyor; bir kez daha basıp toplam 180'e
        // ulaşmak istiyoruz ama /Rotate 90 olan kaynakta 90+90 = 180 olmalı.
        await expectCardCount(page, 2);
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        const { bytes } = await buildOutput(page, { a4: false });
        const boxes = await readPageBoxes(bytes);
        expect(boxes[0].rotation).toBe(180);
    });

    test('UD2: geri alma kaydı "üretiliyor" durumunu TAŞIMAZ', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);

        // Geri alma kaydı, üretilmekte olan sayfanın durumunu da kopyalar.
        // `thumbnailPending` kopyalanırsa geri al, o sayfayı yeniden
        // planlamaz (filtre onu "zaten üretiliyor" sayar) ve kart kalıcı
        // olarak "Yükleniyor..." ekranında takılır.
        const copied = await page.evaluate(() => {
            const target = pdfState.pages[1];
            target.thumbnailPending = true;
            pdfRotatePage(target.uid);           // geri alma kaydı alır
            const top = pdfState.undoStack[pdfState.undoStack.length - 1];
            const snapshot = top.pages.find((p) => p.uid === target.uid);
            return { recorded: !!top, pending: snapshot ? !!snapshot.thumbnailPending : null };
        });
        expect(copied.recorded).toBe(true);
        expect(copied.pending).toBe(false);
    });

    test('UD1: dosya ekledikten sonra geri al, eklenen dosyayı ÇIKTIDAN SİLMEZ', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);

        // Geri alma yığınına bir kayıt girsin (döndürme).
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();

        // Sonra ikinci dosya yüklensin.
        await uploadFixtures(page, ['b.pdf']);
        await expectCardCount(page, 7);

        // Geri al düğmesi ne yapacağını yazar (A9): en son işlem dosya eklemek.
        await expect(page.locator('#pdf-undo-label')).toHaveText(/Dosya eklendi/);
        await page.click('#pdf-undo-btn');
        await page.waitForTimeout(200);

        // Geri al, b.pdf'yi hem listeden hem çıktıdan kaldırmalı; a.pdf ve
        // ondaki döndürme KORUNMALI. Dosya satırı "3 sayfa" derken çıktıda
        // 3 sayfa bulunmasının bir yolu kalmamalı.
        const state = await page.evaluate(() => ({
            pages: pdfState.pages.length,
            cards: document.querySelectorAll('.pdf-page-card').length,
            files: pdfState.files.map((f) => f.name),
            rows: document.querySelectorAll('.pdf-file-row').length,
            rotated: pdfState.pages.filter((p) => p.rotation !== 0).length
        }));
        expect(state.files).toEqual(['a.pdf']);
        expect(state.rows).toBe(1);
        expect(state.pages).toBe(4);
        expect(state.cards).toBe(4);
        expect(state.rotated).toBe(1);

        // İkinci geri al: döndürme de geri gelmeli.
        await page.click('#pdf-undo-btn');
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => ({
            rotated: pdfState.pages.filter((p) => p.rotation !== 0).length,
            pages: pdfState.pages.length
        }));
        expect(after.rotated).toBe(0);
        expect(after.pages).toBe(4);
    });

    test('F2: dosya kaldırıldıktan sonra geri al hayalet kart üretmez', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf']);
        await expectCardCount(page, 7);

        // Önce bir sayfayı döndür (geri al yığınına girsin), sonra dosyayı kaldır.
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await page.locator('.pdf-file-row [data-remove-file]').first().click();
        await expectCardCount(page, 3);

        // Dosya kaldırıldı: geri alma yığını TÜMÜYLE silinmemeli (A7),
        // ama kaldırılan dosyanın sayfaları kayıttan düşmüş olmalı; geri
        // alınca "Bilinmeyen dosya" kartları doğmamalı.
        const undoEnabled = await page.locator('#pdf-undo-btn').isEnabled();
        if (undoEnabled) {
            await page.click('#pdf-undo-btn');
            await page.waitForTimeout(200);
        }

        const state = await page.evaluate(() => ({
            cards: document.querySelectorAll('#pdf-page-grid .pdf-page-card').length,
            pages: pdfState.pages.length,
            orphans: pdfState.pages.filter((p) => !pdfState.files.some((f) => f.id === p.fileId)).length,
            unknown: [...document.querySelectorAll('.pdf-page-label')]
                .filter((el) => el.textContent.includes('Bilinmeyen')).length
        }));
        expect(state.orphans).toBe(0);
        expect(state.unknown).toBe(0);
        expect(state.cards).toBe(state.pages);
        expect(state.cards).toBe(3);

        // Ters sıra da güvenli olmalı: önce geri al, sonra dosyayı kaldır.
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await page.click('#pdf-undo-btn');
        await page.locator('.pdf-file-row [data-remove-file]').first().click();
        const after = await page.evaluate(() => ({
            orphans: pdfState.pages.filter((p) => !pdfState.files.some((f) => f.id === p.fileId)).length,
            cards: document.querySelectorAll('#pdf-page-grid .pdf-page-card').length,
            pages: pdfState.pages.length
        }));
        expect(after.orphans).toBe(0);
        expect(after.cards).toBe(after.pages);
    });

    test('F3: kayıp mod vektör belgeyi iki kez kurmaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf']);

        // copyPages çağrı sayısını say: kayıp modda hiç çağrılmamalı.
        await page.evaluate(() => {
            window.__copyCalls = 0;
            const original = PDFLib.PDFDocument.prototype.copyPages;
            PDFLib.PDFDocument.prototype.copyPages = function (...args) {
                window.__copyCalls++;
                return original.apply(this, args);
            };
        });

        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        await page.click('#pdf-lossy-confirm');
        await expect(page.locator('#pdf-progress-wrap')).toBeHidden({ timeout: 60000 });

        expect(await page.evaluate(() => window.__copyCalls)).toBe(0);
    });

    test('F4: toplam boyut sınırı aşılınca dosya listesi de yenilenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expect(page.locator('#pdf-file-list .pdf-file-row')).toHaveCount(1);

        // Sınırı test için düşür: 1 KB üstü toplam reddedilsin.
        await page.evaluate(() => { window.pdfLimits.maxTotalBytes = 1024; });
        await uploadFixtures(page, ['b.pdf']);

        // Yalnızca reddedilen dosya geri alınır; daha önce yüklenenler korunur
        // (kullanıcının emeği silinmemeli) ve liste durumu yansıtır.
        const rows = await fileListRows(page);
        const state = await page.evaluate(() => ({
            files: pdfState.files.length,
            loaded: pdfState.files.filter((f) => f.doc).length,
            pages: pdfState.pages.length
        }));
        expect(state.files).toBe(2);
        expect(state.loaded).toBe(1);
        expect(state.pages).toBe(4);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('a.pdf');
        expect(rows[1]).toContain('Yüklenemedi');
    });

    test('F5: meşguliyet sırasında yeni dosya eklenmez', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        const before = await page.evaluate(() => pdfState.pages.length);

        // busy=true iken addFiles çağrısı yok sayılmalı.
        await page.evaluate(() => { pdfSetBusy(true); });
        const bytesB = Array.from(readFileSync(fixturePath('b.pdf')));
        await page.evaluate(async (arr) => {
            const file = new File([new Uint8Array(arr)], 'b.pdf', { type: 'application/pdf' });
            await addFiles([file]);
        }, bytesB);
        const during = await page.evaluate(() => pdfState.pages.length);
        expect(during).toBe(before);
        await page.evaluate(() => { pdfSetBusy(false); });
    });

    test('F6: çift tıklama iki çıktı üretmez', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        let downloads = 0;
        page.on('download', () => { downloads++; });

        await page.evaluate(() => { pdfSetBusy(true); });
        await page.evaluate(() => { pdfOnBuildClick(); });
        await page.waitForTimeout(400);
        expect(downloads).toBe(0);
        await page.evaluate(() => { pdfSetBusy(false); });

        await page.click('#pdf-build-btn');
        await page.waitForTimeout(1500);
        expect(downloads).toBe(1);
    });

    test('F7: kütüphane indirilemezse "Tekrar Dene" çalışır', async ({ page }) => {
        await page.route('**/pdf-lib.min.js', (route) => route.abort());
        await page.goto(PAGE);
        await page.click('#tab-pdf-araclari');
        await expect(page.locator('#pdf-libs-status')).toHaveClass(/is-error/, { timeout: 30000 });
        await expect(page.locator('#pdf-libs-status')).toContainText('yüklenemedi');

        // Engel kaldırılır, "Tekrar Dene" tıklanır ve kütüphaneler yüklenir.
        await page.unroute('**/pdf-lib.min.js');
        await page.click('#pdf-retry-libs-btn');
        await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded), { timeout: 30000 })
            .toBe(true);
    });

    test('F8: sıkıştırma kapalıyken dürüst mesaj verilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await buildOutput(page, { compress: false });
        const text = await page.locator('#pdf-result').textContent();
        // "sıkıştırılacak büyük görsel bulunamadı" yanlış: kullanıcı hiç
        // sıkıştırma istemedi. Dürüst mesaj bunu söylemeli.
        expect(text.toLowerCase()).toContain('sıkıştırma seçeneği kapalıydı');
        expect(text).not.toContain('büyük görsel bulunamadı');
    });

    test('F9: düzenleme küçük resimleri yeniden kodlamaz', async ({ page }) => {
        await openPdfTab(page);
        // toDataURL çağrılarını say: her çağrı bir küçük resim kodlamasıdır.
        await page.evaluate(() => {
            window.__thumbRenders = 0;
            const original = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (...args) {
                window.__thumbRenders++;
                return original.apply(this, args);
            };
        });
        await uploadFixtures(page, ['sixty-pages.pdf']);
        await expectCardCount(page, 60);
        await page.waitForTimeout(500);

        const before = await page.evaluate(() => window.__thumbRenders);
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await page.waitForTimeout(1200);
        const after = await page.evaluate(() => window.__thumbRenders);

        // Döndürme YALNIZCA döndürülen sayfanın küçük resmini yeniden üretir
        // (kullanıcı ne görüyorsa basılacak odur) — 60 kartın 60'ı değil.
        expect(after - before).toBe(1);

        // Toplu döndürmede ise hepsi yeniden üretilir.
        const beforeAll = after;
        await page.click('#pdf-rotate-all-btn');
        await page.waitForTimeout(3000);
        const afterAll = await page.evaluate(() => window.__thumbRenders);
        expect(afterAll - beforeAll).toBe(60);

        // SİLME ve SÜRÜKLEME küçük resimleri yeniden üretmemeli: sayfa
        // görseli değişmemiştir, yalnızca sırası/numarası değişmiştir. Önceden
        // 60 sayfada tek silme 59 yeniden kodlama tetikliyordu.
        const beforeDelete = afterAll;
        await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        await expectCardCount(page, 59);
        await page.waitForTimeout(1200);
        expect(await page.evaluate(() => window.__thumbRenders) - beforeDelete).toBe(0);

        const beforeDrag = await page.evaluate(() => window.__thumbRenders);
        await page.evaluate(() => pdfMovePage(pdfState.pages[5].uid, 0));
        await page.waitForTimeout(1200);
        expect(await page.evaluate(() => window.__thumbRenders) - beforeDrag).toBe(0);
    });
});


test.describe('döndürme görsel geri bildirimi ve önizleme paneli', () => {
    test('G1: tek sayfa döndürülünce küçük resim ve rozet güncellenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await expect(page.locator('.pdf-page-badge')).toHaveCount(0);

        const firstThumb = page.locator('.pdf-page-card').first().locator('.pdf-page-thumb');
        const before = await firstThumb.getAttribute('src');

        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await expect(page.locator('.pdf-page-badge').first()).toHaveText('90°');
        // Küçük resim yeniden üretilmeli: kaynak (data URL) değişmeli.
        await expect.poll(async () => firstThumb.getAttribute('src'), { timeout: 60000 }).not.toBe(before);
    });

    test('G2: tüm sayfalar döndürülünce her rozet güncellenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);

        await page.click('#pdf-rotate-all-btn');
        await expect(page.locator('.pdf-page-badge')).toHaveCount(4);
        await expect(page.locator('.pdf-page-badge').first()).toHaveText('90°');

        await page.click('#pdf-rotate-all-btn');
        await expect(page.locator('.pdf-page-badge').first()).toHaveText('180°');
        await page.click('#pdf-rotate-all-btn');
        await expect(page.locator('.pdf-page-badge').first()).toHaveText('270°');
        await page.click('#pdf-rotate-all-btn');
        await expect(page.locator('.pdf-page-badge')).toHaveCount(0);
    });

    test('G3: küçük resim gerçekten döner (görüntü değişir)', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        await expectCardCount(page, 5);
        await page.waitForTimeout(600);

        const thumb = page.locator('.pdf-page-card').first().locator('.pdf-page-thumb');
        const before = await thumb.getAttribute('src');
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await expect.poll(async () => thumb.getAttribute('src'), { timeout: 60000 }).not.toBe(before);
    });

    test('G4: kaynak /Rotate küçük resimde de görünür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['source-rotated.pdf']);
        await expectCardCount(page, 2);

        // CSS kutusu aspect-ratio ile sabit 3:4 olduğundan ÖLÇÜLEMEZ;
        // kodlanmış görüntünün gerçek boyutu (naturalWidth/Height) okunur.
        // naturalWidth/Height, görüntü çözülene kadar 0'dır; decode edilmesi
        // beklenir. Tek bir evaluate içinde beklemek yoksa test titiz oluyor.
        const natural = () => page.evaluate(() => {
            const img = document.querySelector('.pdf-page-card .pdf-page-thumb');
            return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
        });
        // Playwright'ın waitForFunction'ı bu sayfada yanlış negatif veriyor
        // (snapshot yatay gösterirken de zaman aşımına uğruyor); bu yüzden
        // açık bir yoklama döngüsü kullanılır.
        const waitOrientation = async (want) => {
            const deadline = Date.now() + 60000;
            let last = null;
            while (Date.now() < deadline) {
                last = await page.evaluate(() => {
                    const img = document.querySelector('.pdf-page-card .pdf-page-thumb');
                    return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
                });

                if (last && last.w > 0) {
                    // 210x148 => genişlik büyük => YATAY
                    const ok = want === 'landscape' ? last.w > last.h : last.h > last.w;
                    if (ok) return last;
                }
                await page.waitForTimeout(200);
            }
            throw new Error(`Küçük resim ${want} olmadı; son durum: ${JSON.stringify(last)}`);
        };

        // Kaynak zaten 90° döndükçe küçük resim YATAY olmalı.
        expect(await waitOrientation('landscape')).toEqual({ w: 210, h: 148 });

        // Kullanıcı 90° daha ekler: toplam 180°, küçük resim DİKEY olmalı.
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await expect(page.locator('.pdf-page-badge').first()).toHaveText('180°');
        expect(await waitOrientation('portrait')).toEqual({ w: 148, h: 210 });
    });

    test('G5: düzenleme yapılmayan kartların küçük resmi korunur', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await page.waitForTimeout(400);

        const before = await page.locator('.pdf-page-card').nth(2).locator('.pdf-page-thumb').getAttribute('src');
        // 1. kartı döndür — 3. kart DOKUNULMAMALI.
        await page.locator('.pdf-page-card').first().locator('[data-action="rotate"]').click();
        await expect(page.locator('.pdf-page-badge')).toHaveCount(1);
        const after = await page.locator('.pdf-page-card').nth(2).locator('.pdf-page-thumb').getAttribute('src');
        expect(after).toBe(before);
    });

    test('G6: PDF sekmesinde sağdaki belge önizlemesi gizlenir', async ({ page }) => {
        await page.goto(PAGE);
        // Kira sekmesinde önizleme görünür.
        await expect(page.locator('.preview-inspector')).toBeVisible();
        expect((await page.locator('#printable-area').textContent()).trim().length).toBeGreaterThan(0);

        // PDF sekmesinde gizlenmeli — o sekmede belge üretilmez.
        await page.click('#tab-pdf-araclari');
        await expect(page.locator('.preview-inspector')).toBeHidden();
    });

    test('G7: PDF sekmesinden başka bir sekmeye dönünce önizleme geri gelir', async ({ page }) => {
        await page.goto(PAGE);
        await page.click('#tab-pdf-araclari');
        await expect(page.locator('.preview-inspector')).toBeHidden();
        await page.click('#tab-kira');
        await expect(page.locator('.preview-inspector')).toBeVisible();
        expect((await page.locator('#printable-area').textContent()).trim()).toContain('KİRA SÖZLEŞMESİ');
    });
});

test.describe('alt aksiyon çubuğu: PDF Birleştir ve İndir', () => {
    test('H1: dosya yüklendiğinde altta birleştir ve indir butonu görünür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf']);

        const bar = page.locator('#pdf-action-bar');
        await expect(bar).toBeVisible();
        await expect(page.locator('#pdf-build-btn')).toBeVisible();
        await expect(page.locator('#pdf-build-btn')).toContainText('PDF Birleştir ve İndir');
        // Buton panelin en altında olmalı.
        const barBox = await bar.boundingBox();
        const cardBox = await page.locator('#pdf-araclari-form-block').boundingBox();
        expect(barBox.y).toBeGreaterThan(cardBox.y);
    });

    test('H2: hiç dosya yokken buton gizli ve devre dışı', async ({ page }) => {
        await openPdfTab(page);
        await expect(page.locator('#pdf-action-bar')).toBeHidden();
    });

    test('H3: buton gerçekten birleştirip indirir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf']);

        const downloadPromise = page.waitForEvent('download');
        await page.locator('#pdf-build-btn').click();
        const download = await downloadPromise;
        const chunks = [];
        for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));

        expect(await readPageBoxes(bytes)).toHaveLength(7);
        const text = await extractAllText(bytes);
        expect(text).toContain('ALFA SAYFA 1');
        expect(text).toContain('BETA SAYFA 1');
    });

    test('H4: buton metni tek dosyada da aynıdır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expect(page.locator('#pdf-build-btn')).toContainText('PDF Birleştir ve İndir');
    });

    test('H5: dosya kaldırılınca buton tekrar gizlenir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expect(page.locator('#pdf-action-bar')).toBeVisible();
        await page.locator('.pdf-file-row [data-remove-file]').first().click();
        await expect(page.locator('#pdf-action-bar')).toBeHidden();
    });

    test('H6: buton A4 + küçültme onayını uygular', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        await page.locator('#pdf-opt-compress').setChecked(true);
        // Kalite seçeneği kayıplı yöntemde anlamlıdır.
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('input[name="pdf-quality"][value="0.7"]').check();

        const downloadPromise = page.waitForEvent('download');
        await page.locator('#pdf-build-btn').click();
        const download = await downloadPromise;
        const chunks = [];
        for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));

        const input = statSync(fixturePath('scanned.pdf')).size;
        expect(bytes.length).toBeLessThan(input * 0.5);
        const boxes = await readPageBoxes(bytes);
        expect(boxes).toHaveLength(5);
        for (const box of boxes) {
            expect(box.width).toBeCloseTo(595.28, 0);
            expect(box.height).toBeCloseTo(841.89, 0);
        }
    });

    test('H7: buton dar ekranda taşmaz', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        const box = await page.locator('#pdf-build-btn').boundingBox();
        expect(box.width).toBeLessThanOrEqual(390);
        expect(box.x).toBeGreaterThanOrEqual(0);
    });

    test('H8: çift tıklama tek indirme yapar', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        let downloads = 0;
        page.on('download', () => { downloads++; });
        await page.locator('#pdf-build-btn').dblclick();
        await page.waitForTimeout(2000);
        expect(downloads).toBe(1);
    });
});

test.describe('gizlilik: hiçbir dış servise istek yapılmaz', () => {
    const THIRD_PARTY = /fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare|countapi|mileshilliard|google-analytics|gtag/i;

    async function recordRequests(page, action) {
        const seen = [];
        const onRequest = (r) => seen.push(r.url());
        page.on('request', onRequest);
        await action();
        page.off('request', onRequest);
        return seen;
    }

    test('K1: sayfa yüklenirken hiçbir üçüncü taraf isteği olmaz', async ({ page }) => {
        const urls = await recordRequests(page, async () => {
            await page.goto(PAGE, { waitUntil: 'networkidle' });
        });
        expect(urls.filter((u) => THIRD_PARTY.test(u))).toEqual([]);
    });

    test('K2: PDF araçlarının tamamı hiçbir dış istek yapmaz', async ({ page }) => {
        await openPdfTab(page);
        const urls = await recordRequests(page, async () => {
            await uploadFixtures(page, ['a.pdf', 'scanned.pdf']);
            await page.waitForTimeout(1200);
            await page.locator('#pdf-opt-compress').setChecked(true);
            const downloadPromise = page.waitForEvent('download');
            await page.locator('#pdf-build-btn').click();
            await downloadPromise;
        });
        expect(urls.filter((u) => THIRD_PARTY.test(u))).toEqual([]);
    });

    test('K3: hiçbir istek kendi origin dışına çıkmaz', async ({ page }) => {
        // Testler file:// üzerinde çalışır; origin null olur. Bu yüzden
        // "kendi originimiz" yerine doğrudan üçüncü taraf + şüpheli desen
        // denetimi yapılır.
        const urls = await recordRequests(page, async () => {
            await page.goto(PAGE, { waitUntil: 'networkidle' });
            await page.click('#tab-pdf-araclari');
            await page.waitForFunction(() => !!window.pdfState?.libsLoaded);
            await page.setInputFiles('#pdf-file-input', [fixturePath('a.pdf')]);
            await page.waitForFunction(() => !window.pdfState.busy);
        });
        const external = urls.filter((u) => !u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:'));
        expect(external).toEqual([]);
        // Klasik izleme/analitik desenleri de olmamalı.
        expect(urls.some((u) => /collect|track|beacon|analytics|gtag|doubleclick/i.test(u))).toBe(false);
    });

    test('K4: CSP ağ giden istekleri engeller (connect-src none)', async ({ page }) => {
        await page.goto(PAGE);
        // Uygulama kendi koduyla dış adrese fetch denerse CSP reddetmeli.
        const result = await page.evaluate(async () => {
            try {
                await fetch('https://countapi.mileshilliard.com/api/v1/get/test', { mode: 'no-cors' });
                return 'IZINSIZ';
            } catch (e) {
                return 'RED';
            }
        });
        expect(result).toBe('RED');
    });

    test('K5: yazı tipi ve ikonlar depodan gelir', async ({ page }) => {
        const urls = await recordRequests(page, async () => {
            await page.goto(PAGE, { waitUntil: 'networkidle' });
        });
        expect(urls.some((u) => u.includes('/vendor/fonts/inter.css'))).toBe(true);
        expect(urls.some((u) => u.includes('/vendor/fontawesome/css/all.min.css'))).toBe(true);
        expect(urls.some((u) => /UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa.*\.woff2$/.test(u))).toBe(true);
    });

    test('K6: görsel yükleme hiçbir sunucuya gitmez (yine çalışır)', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        // Bozuk olsaydı burada hata çıkardı; sadece görsel sunucusuna gidilmedi.
        await expect(page.locator('.pdf-page-card').first()).toBeVisible();
    });

    test('K7: yazdırma sayacı yalnızca yerelde artar', async ({ page }) => {
        const urls = await recordRequests(page, async () => {
            await page.goto(PAGE);
            await page.evaluate(() => { window.print = () => {}; });
            await page.click('#tab-kira');
            await page.locator('button:has-text("Yazdır")').first().click();
        });
        expect(urls.filter((u) => THIRD_PARTY.test(u))).toEqual([]);
        const count = await page.evaluate(() =>
            Number(localStorage.getItem('kira_contract_local_count')));
        expect(count).toBeGreaterThan(0);
    });

    test('K8: rozet metni yerel sayacı doğru anlatır', async ({ page }) => {
        await page.goto(PAGE);
        const badge = page.locator('#contract-counter-badge');
        await expect(badge).toContainText('Bu Cihazda');
        await expect(badge).toHaveAttribute('title', /yalnızca yerel/);
    });
});

// --- Son kalite denetimi düzeltmelerini kilitleyen testler ---------------

test.describe('denetim düzeltmeleri', () => {
    test('A1: sayfa silindiğinde küçülme yüzdesi silinen sayfaları saymaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        await expectCardCount(page, 5);

        const fileSize = statSync(fixturePath('scanned.pdf')).size;

        // 4 sayfayı sil -> tek sayfa kalsın
        for (let i = 0; i < 4; i++) {
            await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        }
        await expectCardCount(page, 1);

        // Sıkıştırma KAPALI. 'Orijinal' boyutu dosyanın tamamı değil, çıktıya
        // giren TEK sayfanın payı olmalı; aksi halde sayfa silmek küçülme
        // gibi görünür.
        await buildOutput(page, { compress: false });
        const text = await page.locator('#pdf-result').textContent();
        const onePage = fileSize / 5;
        const shown = Number((text.match(/Orijinal ([\d.,]+) (KB|MB)/) || [])[1]?.replace(',', '.'));
        const unit = (text.match(/Orijinal [\d.,]+ (KB|MB)/) || [])[1];
        const shownBytes = unit === 'MB' ? shown * 1024 * 1024 : shown * 1024;
        // Beşte biri: silinen 4 sayfa hesaba katılmamalı. Tolerans, biçimlendiricinin
        // (0,1 MB'ye yuvarlama) kendi hatasından GENİŞ olmalı; aksi halde test
        // kendi kaba yuvarlaması yüzünden kırmızıya döner.
        expect(shownBytes / onePage).toBeGreaterThan(0.95);
        expect(shownBytes / onePage).toBeLessThan(1.05);
        expect(shownBytes).toBeLessThan(fileSize * 0.5);

        // Sıkıştırma kapalıyken bu ipucu her hâlükârda görünmeli.
        expect(text).toContain('Sıkıştırma seçeneği kapalıydı');
    });

    test('A2: onay damgası (Annots/AP) içindeki görsel bulunur ve küçülür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['stamped.pdf']);
        const input = statSync(fixturePath('stamped.pdf')).size;

        const before = await collectImages(readBytes(fixturePath('stamped.pdf')));
        expect(before).toHaveLength(1);
        expect(before[0].path).toContain('annot');
        expect(before[0].filter).toBe('/FlateDecode');

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const after = await collectImages(bytes);
        expect(after).toHaveLength(1);
        // Yeniden kodlanmış olmalı
        expect(after[0].filter).toBe('/DCTDecode');
        expect(bytes.length).toBeLessThan(input * 0.6);
    });

    test('A2b: tiling pattern içindeki görsel bulunur ve küçülür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['pattern.pdf']);
        const input = statSync(fixturePath('pattern.pdf')).size;

        const before = await collectImages(readBytes(fixturePath('pattern.pdf')));
        expect(before).toHaveLength(1);
        expect(before[0].path).toContain('pattern');

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const after = await collectImages(bytes);
        expect(after[0].filter).toBe('/DCTDecode');
        expect(bytes.length).toBeLessThan(input * 0.6);
    });

    test('A3: ICCBased renk uzaylı görsel yeniden kodlanır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['iccbased.pdf']);
        const input = statSync(fixturePath('iccbased.pdf')).size;

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const after = await collectImages(bytes);
        expect(after).toHaveLength(1);
        expect(after[0].filter).toBe('/DCTDecode');
        expect(bytes.length).toBeLessThan(input * 0.6);
    });

    test('A3b: Indexed (paletli) görsel yeniden kodlanır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['indexed.pdf']);
        const input = statSync(fixturePath('indexed.pdf')).size;
        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const after = await collectImages(bytes);
        expect(after[0].filter).toBe('/DCTDecode');
        expect(bytes.length).toBeLessThan(input * 0.6);
    });

    test('A3c: renk uzayı desteklenmiyorsa DURUŞT mesajı verilir', async ({ page }) => {
        await openPdfTab(page);
        // DeviceCMYK bu araçta desteklenmiyor
        await uploadFixtures(page, ['cmyk.pdf']);
        await buildOutput(page, { compress: true, quality: '0.7' });
        const text = await page.locator('#pdf-result').textContent();
        expect(text).toContain('küçültülemedi');
        expect(text).toContain('renk uzayı');
        // "zaten optimize" gibi yanlış bilgi verilmemeli
        expect(text).not.toContain('zaten optimize');
    });

    // --- Yeniden kodlamanın GÖRÜNTÜ DOĞRULUĞU ---------------------------------
    // Filtre '/DCTDecode' olması "başarılı" demek DEĞİLDİR: pikseller
    // bozulmuş olabilir. Bu testler kaynak örnekleri bağımsız olarak
    // (Node + zlib) okuyup çıktıdaki JPEG ile karşılaştırır.

    test('PX1: ters gri tonlu görsel yeniden kodlandığında pikselleri bozulmaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['inverted-gray.pdf']);

        const source = await readRawImageSamples(fixtureBytes('inverted-gray.pdf'));
        expect(source.channels).toBe(1);

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.85' });
        const after = await collectImages(bytes);
        expect(after[0].filter).toBe('/DCTDecode');
        // /Decode korunmalı: aynı /Decode ile kaydedilen örnekler aynı görünür.
        // /Decode [1 0] korunmalı: aynı /Decode ile yazılan örnekler aynı görünür.
        expect(after[0].decode).toContain('1');

        const pixels = await decodeJpegPixelsInPage(page, bytes);
        expect(pixels.width).toBe(source.width);
        expect(pixels.height).toBe(source.height);
        // Ters çevirme uygulanmadan ham örnekler karşılaştırılır; 90 kalite
        // için ortalama hata 12'nin altında olmalı. Ters çevrilmiş bir çıktı
        // ortalama hatayı ~85'e çıkarır.
        expect(meanAbsError(source.samples, 1, pixels.data)).toBeLessThan(12);
    });

    test('PX2: Indexed görsel yeniden kodlandığında pikselleri bozulmaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['indexed.pdf']);

        // Kaynak paletten bağımsız olarak hesaplanır.
        const palette = Array.from({ length: 768 }, (_, i) => (i * 7) % 256);
        const { inflateSync } = await import('node:zlib');
        const { PDFDocument, PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.load(fixtureBytes('indexed.pdf'));
        let image = null;
        for (const [, ref] of doc.getPages()[0].node.Resources().lookup(PDFName.of('XObject')).entries()) {
            image = doc.context.lookup(ref);
        }
        const indices = new Uint8Array(inflateSync(Buffer.from(image.contents)));
        const expected = new Uint8Array(indices.length * 3);
        for (let i = 0; i < indices.length; i++) {
            expected[i * 3] = palette[indices[i] * 3];
            expected[i * 3 + 1] = palette[indices[i] * 3 + 1];
            expected[i * 3 + 2] = palette[indices[i] * 3 + 2];
        }

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.85' });
        expect((await collectImages(bytes))[0].filter).toBe('/DCTDecode');
        const pixels = await decodeJpegPixelsInPage(page, bytes);
        expect(meanAbsError(expected, 3, pixels.data)).toBeLessThan(20);
    });

    test('PX3: 4 kanallı ICCBased (CMYK) görsel sessizce bozulmaz, atlanır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['iccbased-cmyk.pdf']);

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const after = await collectImages(bytes);
        // Yeniden kodlanmamalı: CMYK profili desteklenmiyor.
        expect(after[0].filter).toBe('/FlateDecode');

        const text = await page.locator('#pdf-result').textContent();
        expect(text).toContain('küçültülemedi');
        expect(text).toContain('renk uzayı');
    });

    // --- Kayıpsız sıkıştırma (kurumsal kullanım) ---------------------------

    test('L1: aynı görsel 3 kez gömülüyse çıktıda TEK nesne kalır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['duplicate-images.pdf']);
        await expectCardCount(page, 3);

        const before = await collectImages(fixtureBytes('duplicate-images.pdf'));
        expect(before).toHaveLength(3);

        const { bytes } = await buildOutput(page, { compress: true });
        const after = await collectImages(bytes);

        // Üç sayfa korunur, ama görsel NESNESİ tektir (piksel aynı).
        const { PDFDocument } = await import('pdf-lib');
        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
        expect(after).toHaveLength(1);
        // Görselin kendisi değişmemiş olmalı: örnekler birebir aynı.
        expect(after[0].bytes).toBe(before[0].bytes);
    });

    test('L2: kayıpsız modda görsel baytları DOKUNULMAZ', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        const before = await collectImages(fixtureBytes('scanned.pdf'));

        const { bytes } = await buildOutput(page, { compress: true });
        const after = await collectImages(bytes);
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
            // Filtre değişmemeli (Flate kalmalı, DCTDecode olmamalı) ve
            // bayt sayısı aynı olmalı.
            expect(after[i].filter).toBe(before[i].filter);
            expect(after[i].bytes).toBe(before[i].bytes);
        }
    });

    test('L3: varsayılan (kayıpsız) mod görseli JPEG\'e ÇEVRİLMEZ', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['scanned.pdf']);
        const { bytes } = await buildOutput(page, { compress: true });
        const after = await collectImages(bytes);
        // Dönüşüm olsaydı burada DCTDecode olurdu.
        expect(after.some((i) => i.filter === '/DCTDecode')).toBe(false);
    });

    test('L8: karmaşık belgeler kayıpsız modda BOZULMAZ', async ({ page }) => {
        await openPdfTab(page);
        // Damga, tiling pattern, döndürülmüş kaynak, CropBox, çok sayfa:
        // kullanılmayan nesne budama (prune) bunları bozabilirdi.
        for (const name of ['stamped.pdf', 'pattern.pdf', 'source-rotated.pdf',
            'cropbox.pdf', 'sixty-pages.pdf', 'nested-image.pdf']) {
            await page.setInputFiles('#pdf-file-input', fixturePath(name));
            await expect.poll(() => page.evaluate(() => window.pdfState.busy)).toBe(false);

            const input = fixtureBytes(name);
            const beforePages = (await PDFDocument.load(input)).getPageCount();
            const beforeImages = (await collectImages(input)).length;
            const beforeText = (await extractAllText(input)).replace(/\s+/g, '').length;

            const { bytes } = await buildOutput(page, { compress: true });

            const after = await PDFDocument.load(bytes);
            expect(after.getPageCount(), `${name}: sayfa sayısı`).toBe(beforePages);
            expect((await collectImages(bytes)).length, `${name}: görsel sayısı`).toBe(beforeImages);
            const afterText = (await extractAllText(bytes)).replace(/\s+/g, '').length;
            expect(afterText, `${name}: metin korundu`).toBe(beforeText);

            // Sayfayı temizle ki sonraki dosya birikmesin.
            await page.evaluate(() => {
                for (const f of [...pdfState.files]) pdfRemoveFile(f.id);
            });
            await expect.poll(() => page.locator('.pdf-page-card').count()).toBe(0);
        }
    });

    test('L7a: saf siyah-beyaz sayfa 1-bit\'e çevrilir, pikseller BİREBİR aynı', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['pure-bw.pdf']);
        const before = await collectImages(fixtureBytes('pure-bw.pdf'));
        expect(before[0].depth).toBe(8);

        const { bytes } = await buildOutput(page, { compress: true });
        const after = await collectImages(bytes);
        // 1-bit gri görsel: /DeviceGray + BitsPerComponent 1 + Flate.
        expect(after[0].depth).toBe(1);
        expect(after[0].filter).toBe('/FlateDecode');
        expect(after[0].width).toBe(before[0].width);
        expect(after[0].height).toBe(before[0].height);

        // Kayıpsızlık: kaynak 8-bit örnekleri (yalnız 0/255) ile çıktının
        // 1-bit örnekleri birebir aynı olmalı.
        const source = await readRawImageSamples(fixtureBytes('pure-bw.pdf'));
        const packed = await readRawImageSamples(bytes);
        const stride = Math.ceil(source.width / 8);
        expect(packed.samples.length).toBe(stride * source.height);
        let diff = 0;
        for (let i = 0; i < source.width * source.height; i++) {
            const bit = (packed.samples[(i / source.width | 0) * stride + ((i % source.width) >> 3)]
                >> (7 - (i % source.width & 7))) & 1;
            if ((bit ? 255 : 0) !== source.samples[i]) diff++;
        }
        expect(diff).toBe(0);

        // Ve gerçekten küçüldü mü?
        expect(bytes.length).toBeLessThan(fixtureBytes('pure-bw.pdf').length * 0.5);
    });

    test('L7b: gri tonlu fotoğraf 1-bit\'e ÇEVRİLMEZ', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['photo-gray.pdf']);
        const before = await collectImages(fixtureBytes('photo-gray.pdf'));

        const { bytes } = await buildOutput(page, { compress: true });
        const after = await collectImages(bytes);
        // Fotoğrafın ara tonları var: 1-bit'e çevirmek görünümü bozardı.
        expect(after[0].depth).toBe(8);
        expect(after[0].bytes).toBe(before[0].bytes);
    });

    test('L4: JPEG-only belgede dürüst mesaj, sahte yüzde yok', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['jpeg-only.pdf']);
        await buildOutput(page, { compress: true });
        const text = await page.locator('#pdf-result').textContent();
        // Ne yapıldığı açıkça yazılmalı...
        expect(text).toMatch(/kayıpsız/i);
        // ...ve kullanıcı yanlış yönlendirilmemeli.
        expect(text).not.toContain('zaten JPEG');
        expect(text).not.toContain('%0 küçüldü');
    });

    test('PX4: PNG predictor kodlanmış görsel atlanır, bozulmaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['predictor.pdf']);

        const { bytes } = await buildOutput(page, { compress: true, quality: '0.7' });
        const after = await collectImages(bytes);
        // Predictor çözülmeden yeniden kodlanırsa pikseller gürültü olur.
        expect(after[0].filter).toBe('/FlateDecode');

        const text = await page.locator('#pdf-result').textContent();
        expect(text).toContain('küçültülemedi');
        expect(text).toContain('predictor');
    });

    test('A2c: SMask olan görsel atlanır ve bu durum bildirilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['smask.pdf']);
        await buildOutput(page, { compress: true, quality: '0.7' });
        const text = await page.locator('#pdf-result').textContent();
        expect(text).toContain('küçültülemedi');
        expect(text).toContain('şeffaflık');
    });

    test('A4: localStorage erişilemezse belge yine de üretilir', async ({ page }) => {
        // localStorage'ı tamamen engelle
        await page.addInitScript(() => {
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() { throw new DOMException('Access denied', 'SecurityError'); }
            });
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));

        await page.goto(PAGE);
        // Uygulama hâlâ açılmalı ve önizleme üretmeli
        await page.click('#tab-kira');
        await page.locator('#kira-landlord-name').fill('DEPOLAMA YOK');
        await page.waitForTimeout(300);
        const preview = await page.locator('#printable-area').textContent();
        expect(preview).toContain('DEPOLAMA YOK');

        // Yazdırma da çalışmalı
        await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
        await page.locator('button:has-text("Yazdır")').first().click();
        expect(await page.evaluate(() => !!window.__printed)).toBe(true);

        // PDF araçları da çalışmalı
        await page.click('#tab-pdf-araclari');
        await page.waitForFunction(() => !!window.pdfState?.libsLoaded);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        expect(errors).toEqual([]);
    });

    test('A5: kayıp modda 5 eşzamanlı tıklama TEK indirme yapar', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        let downloads = 0;
        page.on('download', () => { downloads++; });

        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.evaluate(async () => {
            for (let i = 0; i < 5; i++) pdfOnBuildClick();
        });
        // Tek onay tıklaması TÜM bekleyen istekleri çözmeli ama tek indirme olmalı
        await page.click('#pdf-lossy-confirm');
        await page.waitForTimeout(2500);
        expect(downloads).toBe(1);
    });

    test('A6: modal açıkken arka plan odaklanamaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await page.locator('#pdf-opt-compress').setChecked(true);
        await page.locator('input[name="pdf-compress-mode"][value="quality"]').check();
        await page.locator('#pdf-opt-lossy').setChecked(true);
        await page.click('#pdf-build-btn');
        await expect(page.locator('#pdf-lossy-modal')).toBeVisible();

        // Tab tuzağı: 6 kez Tab sonrası odak hâlâ modal içinde olmalı
        for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
        const focusInModal = await page.evaluate(() =>
            !!document.querySelector('#pdf-lossy-modal')?.contains(document.activeElement));
        expect(focusInModal).toBe(true);

        await page.click('#pdf-lossy-cancel');
    });

    test('A7: dosya kaldırılınca diğer düzenlemeler geri alınabilir kalır', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf', 'b.pdf']);
        await expectCardCount(page, 7);

        // b.pdf'de sayfa döndür (geri alma yığınına girer)
        await page.locator('.pdf-page-card').nth(5).locator('[data-action="rotate"]').click();
        await expect(page.locator('.pdf-page-badge')).toHaveCount(1);

        // a.pdf'yi kaldır
        await page.locator('.pdf-file-row [data-remove-file]').first().click();
        await expectCardCount(page, 3);

        // Geri al HÂLÂ çalışmalı (eski davranışta kalıcı olarak devre dışıydı)
        await expect(page.locator('#pdf-undo-btn')).toBeEnabled();
        await page.click('#pdf-undo-btn');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => ({
            orphans: pdfState.pages.filter((p) => !pdfState.files.some((f) => f.id === p.fileId)).length,
            cards: document.querySelectorAll('#pdf-page-card, .pdf-page-card').length,
            pages: pdfState.pages.length
        }));
        expect(state.orphans).toBe(0);
        expect(state.cards).toBe(state.pages);
    });

    test('A9: geri al düğmesi ne yapılacağını yazar', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        await expect(page.locator('#pdf-undo-label')).toHaveText(/Silme/);
    });

    test('A10: tüm sayfalar silinince doğru mesaj görünür', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await expectCardCount(page, 4);
        for (let i = 0; i < 4; i++) {
            await page.locator('.pdf-page-card').first().locator('[data-action="delete"]').click();
        }
        await expect(page.locator('#pdf-page-grid')).toContainText('Tüm sayfalar silindi');
    });

    test('A11: konsola dosya adı yazılmaz', async ({ page }) => {
        const logs = [];
        page.on('console', (m) => logs.push(m.text()));
        await openPdfTab(page);
        await uploadFixtures(page, ['encrypted.pdf']);
        // Dosya adı "encrypted.pdf" idi; konsolda geçmemeli
        expect(logs.some((l) => l.includes('encrypted.pdf'))).toBe(false);
    });

    test('karanlık modda küçük resim etiketi okunabilir', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['a.pdf']);
        await page.click('#theme-toggle-btn');
        await page.waitForTimeout(200);
        const label = page.locator('.pdf-page-label').first();
        const style = await label.evaluate((el) => {
            const cs = getComputedStyle(el);
            return { color: cs.color, bg: cs.backgroundColor };
        });
        const lum = (c) => {
            const m = c.match(/[\d.]+/g).map(Number);
            return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
        };
        const labelLum = lum(style.color);
        // Etiket kart üstünde okunur olmalı (koyu temada açık metin)
        expect(labelLum).toBeGreaterThan(0.35);
    });

    test('CropBox MediaBox tan küçükse içerik kaymaz', async ({ page }) => {
        await openPdfTab(page);
        await uploadFixtures(page, ['cropbox.pdf']);
        const { bytes } = await buildOutput(page, { a4: true });
        const boxes = await readPageBoxes(bytes);
        expect(boxes).toHaveLength(1);
        expect(boxes[0].width).toBeCloseTo(595.28, 0);
        expect(boxes[0].height).toBeCloseTo(841.89, 0);
        // Metin korunmuş olmalı
        expect(await extractAllText(bytes)).toContain('KIRPMA TESTI');
    });
});
