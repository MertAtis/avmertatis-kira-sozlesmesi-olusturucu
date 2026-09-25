// Çıktı PDF'lerini denetlemek için yardımcılar.
// Playwright testleri tarayıcıda çalışır, bu modül ise Node tarafında
// indirilen baytları inceler.

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// pdf.js, Node'da canvas olmadığı için DOMMatrix/Path2D uyarısı basar.
// Metin çıkarımı bu uyarıdan etkilenmez; test çıktısını okunur tutmak için
// yalnızca bu uyarı susturulur.
const isPolyfillNoise = (args) => /Cannot polyfill|Require stack|^\s*-\s*\/Users/.test(String(args[0]));
for (const level of ['warn', 'log', 'error']) {
    const original = console[level];
    console[level] = (...args) => {
        if (isPolyfillNoise(args)) return;
        original(...args);
    };
}

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

// Node ortamında gerçek worker yüklenir; fake worker DOMMatrix gerektirir
// ve çalışmaz.
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
const STANDARD_FONT_DATA = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/');

/**
 * Her sayfa için MediaBox genişlik/yüksekliği ve /Rotate değerini döndürür.
 * Döndürme dikkate alınmadan, ham MediaBox ölçüleri verilir — A4 kontrolü
 * ham ölçü üzerinden yapılır.
 */
export async function readPageBoxes(bytes) {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
        const { width, height } = page.getSize();
        const rotate = page.node.get(PDFName.of('Rotate'));
        return { width, height, rotation: rotate ? Number(rotate.toString()) : 0 };
    });
}

/** Tüm sayfaların metnini tek string'de birleştirir. */
export async function extractAllText(bytes) {
    // pdf.js, veriyi worker'a TRANSFER edip ayırıyor (detach). Aynı bayt
    // dizisini sonra pdf-lib'nin okuması gerekebildiği için kopya verilir.
    const doc = await pdfjs.getDocument({
        data: bytes.slice(),
        standardFontDataUrl: STANDARD_FONT_DATA
    }).promise;
    let out = '';
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        out += content.items.map((it) => it.str).join(' ') + '\n';
    }
    return out;
}

/**
 * Her sayfadaki doğrudan /Image XObject sayısı.
 * Form XObject içine gömülü görseller sayılmaz — sıkıştırma modu 1'in
 * kapsamını ölçmek için kullanılır.
 */
export async function readImageCount(bytes) {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
        const xoDict = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (!xoDict) return 0;
        let count = 0;
        for (const [key] of xoDict.entries()) {
            const obj = xoDict.lookup(key);
            const subtype = obj?.dict?.lookup(PDFName.of('Subtype'));
            if (subtype && String(subtype) === '/Image') count++;
        }
        return count;
    });
}

/** Görsellerin /Filter değerleri — yeniden kodlamanın çalıştığını doğrular. */
export async function readImageFilters(bytes) {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
        const xoDict = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (!xoDict) return [];
        const filters = [];
        for (const [key] of xoDict.entries()) {
            const obj = xoDict.lookup(key);
            const subtype = obj?.dict?.lookup(PDFName.of('Subtype'));
            if (subtype && String(subtype) === '/Image') {
                filters.push(String(obj.dict.lookup(PDFName.of('Filter')) ?? 'null'));
            }
        }
        return filters;
    });
}
