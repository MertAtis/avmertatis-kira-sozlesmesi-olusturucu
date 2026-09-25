import { test, expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { extractAllText, readPageBoxes, readImageCount, readImageFilters } from '../helpers/inspect.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)));
const read = (name) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const sizeOf = (name) => statSync(join(FIXTURES, name)).size;

test.describe('fixture üretimi', () => {
    test('text-only.pdf üretilir ve 3 sayfada Türkçe metin okunabilir', async () => {
        const boxes = await readPageBoxes(read('text-only.pdf'));
        expect(boxes).toHaveLength(3);
        const text = await extractAllText(read('text-only.pdf'));
        expect(text).toContain('KIRA SOZLESMESI');
    });

    test('scanned.pdf her sayfada büyük FlateDecode ham RGB bitmap içerir', async () => {
        const counts = await readImageCount(read('scanned.pdf'));
        expect(counts).toEqual([1, 1, 1, 1, 1]);
        const filters = await readImageFilters(read('scanned.pdf'));
        expect(filters[0]).toEqual(['/FlateDecode']);
        expect(sizeOf('scanned.pdf')).toBeGreaterThan(8 * 1024 * 1024);
    });

    test('mixed-sizes.pdf A4, A5 ve Letter MediaBox içerir', async () => {
        const boxes = await readPageBoxes(read('mixed-sizes.pdf'));
        expect(boxes.map((b) => Math.round(b.width))).toEqual([595, 420, 612]);
        expect(boxes[1].height).toBeCloseTo(595.28, 1);
    });

    test('a.pdf 4, b.pdf 3, c.pdf 4 sayfa — toplam 11', async () => {
        expect((await readPageBoxes(read('a.pdf'))).length).toBe(4);
        expect((await readPageBoxes(read('b.pdf'))).length).toBe(3);
        expect((await readPageBoxes(read('c.pdf'))).length).toBe(4);
    });

    test('encrypted.pdf Standart Güvenlik İşleyicisi ile şifreli (V=1, R=2)', async () => {
        const raw = readFileSync(join(FIXTURES, 'encrypted.pdf'), 'latin1');
        expect(raw).toContain('/Filter /Standard /V 1 /R 2');
        await expect(PDFDocument.load(read('encrypted.pdf'))).rejects.toThrow(/encrypted/i);
    });

    test('corrupt.pdf yarım kalmış indirmedir: sayfa listesi alınamaz', async () => {
        // pdf-lib yarım kalmış bir PDF'yi "başarıyla" yükleyebilir; sayfa
        // ağacına erişmek patlar. Uygulamanın reddetmesi gereken sözleşme budur:
        // kullanılabilir sayfa sayısı elde edilememeli.
        let pageCount = null;
        try {
            const doc = await PDFDocument.load(read('corrupt.pdf'));
            pageCount = doc.getPageCount();
        } catch {
            pageCount = null;
        }
        expect(pageCount === null || pageCount === 0).toBe(true);
    });

    test('not-a-pdf.pdf PDF değildir ve yüklenemez', async () => {
        await expect(PDFDocument.load(read('not-a-pdf.pdf'))).rejects.toThrow(/Failed to parse PDF/);
    });

    test('empty.pdf 0 sayfa içerir', async () => {
        const doc = await PDFDocument.load(read('empty.pdf'));
        expect(doc.getPageCount()).toBe(0);
    });

    test('huge.pdf 60 MB dosyadır ve uygulama bunu ayrıştırmadan reddeder', async () => {
        // Bu dosyanın ayrıştırılabilirliği kasıtlı olarak sınanmaz: 60 MB'yi
        // ayrıştırmak dakikalar sürer. Uygulamanın sözleşmesi zaten boyutu
        // ayrıştırmadan önce denetlemektir (bkz. T16).
        expect(sizeOf('huge.pdf')).toBeGreaterThan(60 * 1024 * 1024);
        expect(sizeOf('huge.pdf')).toBeLessThan(70 * 1024 * 1024);
        // Başlık sağlamdır; dosya geçerli bir PDF olarak başlar.
        expect(read('huge.pdf').slice(0, 5)).toEqual(new TextEncoder().encode('%PDF-'));
    });

    test('sixty-pages.pdf 60 sayfa içerir', async () => {
        expect((await readPageBoxes(read('sixty-pages.pdf'))).length).toBe(60);
    });

    test('nested-image.pdf görseli Form XObject içindedir, doğrudan /XObject değil', async () => {
        expect(await readImageCount(read('nested-image.pdf'))).toEqual([0]);
    });

    test('aynı ada sahip iki farklı dosya farklı içerik taşır', async () => {
        const a = await extractAllText(read('fatura-a.pdf'));
        const b = await extractAllText(read('fatura-b.pdf'));
        expect(a).toContain('FATURA ALFA');
        expect(b).toContain('FATURA BETA');
    });
});
