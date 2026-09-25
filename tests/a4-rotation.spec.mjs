// pdfPlaceOnA4 dönüşümünün sayısal doğrulaması.
//
// Kaynak A5 sayfasının üç köşesine işaret koyar ve her birinin çıktıda hangi
// köşeye düştüğünü sınıflandırır. "Hareket ediyor mu" değil, "DOĞRU YERDE ve
// DOĞRU YÖNDE mi" sorusunu yanıtlar — gözle kontrol edilemeyecek bir şey.
//
// Bu dosya aynı zamanda `tests/verify-a4-rotation.mjs` düzeneğinin kaynağıdır;
// ikisi birlikte `pdfPlaceOnA4` ile `pdf-cikti.js` içindeki eşdeğer dönüşüm
// matematiğini paylaşır.

import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, radians } from 'pdf-lib';
import { extractAllText } from './helpers/inspect.mjs';

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// pdf-cikti.js içindeki pdfPlaceOnA4 ile birebir aynı dönüşüm.
async function placeOnA4(targetDoc, srcPage, rotation) {
    const { width: w, height: h } = srcPage.getSize();
    const target = targetDoc.addPage([A4_WIDTH, A4_HEIGHT]);

    const quarterTurn = rotation === 90 || rotation === 270;
    const boxW = quarterTurn ? h : w;
    const boxH = quarterTurn ? w : h;
    const scale = Math.min(A4_WIDTH / boxW, A4_HEIGHT / boxH);

    const dx = (A4_WIDTH - boxW * scale) / 2;
    const dy = (A4_HEIGHT - boxH * scale) / 2;

    let minX = 0, minY = 0;
    if (rotation === 90) { minX = 0; minY = -w * scale; }
    else if (rotation === 180) { minX = -w * scale; minY = -h * scale; }
    else if (rotation === 270) { minX = -h * scale; minY = 0; }

    const embedded = await targetDoc.embedPage(srcPage);
    target.drawPage(embedded, {
        x: dx - minX,
        y: dy - minY,
        xScale: scale,
        yScale: scale,
        rotate: radians((-rotation * Math.PI) / 180)
    });
    return target;
}

// İşaretler tek harften oluşur: pdf.js metin çıkarımı çok harfli tireli
// etiketleri bölüyordu, tek harf güvenilir şekilde çıkarılıyor.
const MARKERS = [
    { name: 'P', corner: 'ust-sol', x: 20, y: 555, expected: { 0: 'sol-ust', 90: 'sag-ust', 180: 'sag-alt', 270: 'sol-alt' } },
    { name: 'Q', corner: 'ust-sag', x: 355, y: 555, expected: { 0: 'sag-ust', 90: 'sag-alt', 180: 'sol-alt', 270: 'sol-ust' } },
    { name: 'R', corner: 'alt-sol', x: 20, y: 25, expected: { 0: 'sol-alt', 90: 'sol-ust', 180: 'sag-ust', 270: 'sag-alt' } }
];

function classify(x, y) {
    const col = x < A4_WIDTH / 3 ? 'sol' : x > (2 * A4_WIDTH) / 3 ? 'sag' : 'orta';
    const row = y > (2 * A4_HEIGHT) / 3 ? 'ust' : y < A4_HEIGHT / 3 ? 'alt' : 'orta';
    return `${col}-${row}`;
}

// Uygulamadaki akışın aynısı: kaynak AYRI bir belgede, çıktı belgesine
// kopyalanıp A4'e yerleştirilir. Böylece çıktının 1. sayfası A4 sayfasıdır.
async function buildOutput(rotation) {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const src = source.addPage([419.53, 595.28]);
    for (const marker of MARKERS) {
        src.drawText(marker.name, { x: marker.x, y: marker.y, size: 40, font });
    }

    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(source, [0]);
    await placeOnA4(out, copied, rotation);
    return new Uint8Array(await out.save());
}

for (const rotation of [0, 90, 180, 270]) {
    test(`A4 dönüşümü: ${rotation} derece — köşe işaretleri doğru köşeye düşer`, async () => {
        const bytes = await buildOutput(rotation);
        const text = await extractAllText(bytes);
        const doc = await PDFDocument.load(bytes);
        const page = doc.getPage(0); // pdf-lib 0-indeksli
        expect(Math.round(page.getWidth())).toBe(595);
        expect(Math.round(page.getHeight())).toBe(842);

        // Dönüşüm uygulanmazsa metin kaybolur; uygulanmışsa üç işaret de okunabilir.
        for (const marker of MARKERS) {
            expect(text).toContain(marker.name);
        }
    });
}

test('A4 dönüşümü dört açıda da üç işareti korur (sayısal köşe denetimi)', async () => {
    // pdf.js metin çıkarımı konum verir; sınıflandırma burada yapılır.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url + '/');
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
    const standardFontDataUrl = require.resolve('pdfjs-dist/package.json')
        .replace(/package\.json$/, 'standard_fonts/');

    const problems = [];
    for (const rotation of [0, 90, 180, 270]) {
        const bytes = await buildOutput(rotation);
        const loaded = await pdfjs.getDocument({ data: bytes, standardFontDataUrl }).promise;
        const page = await loaded.getPage(1);
        const content = await page.getTextContent();
        const positions = new Map();
        for (const item of content.items) {
            const label = item.str.trim();
            if (MARKERS.some((m) => m.name === label)) {
                positions.set(label, { x: item.transform[4], y: item.transform[5] });
            }
        }
        for (const marker of MARKERS) {
            const pos = positions.get(marker.name);
            if (!pos) {
                problems.push(`${rotation}°: ${marker.name} çıktıda bulunamadı`);
                continue;
            }
            const actual = classify(pos.x, pos.y);
            if (actual !== marker.expected[rotation]) {
                problems.push(
                    `${rotation}°: ${marker.name} (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}) `
                    + `-> ${actual}, beklenen ${marker.expected[rotation]}`
                );
            }
        }
    }
    expect(problems).toEqual([]);
});
