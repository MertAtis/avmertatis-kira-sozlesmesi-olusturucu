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

/** Çıktı PDF'indeki metin öğelerinin kullanıcı uzayındaki konumları. */
export async function textPositions(bytes) {
    const doc = await pdfjs.getDocument({
        data: bytes.slice(),
        standardFontDataUrl: STANDARD_FONT_DATA
    }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        for (const item of content.items) {
            if (item.str.trim()) out.push({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] });
        }
    }
    return out;
}

/**
 * Belgedeki TÜM görselleri bulur — sayfa, Form XObject, Annots/AP ve Pattern
 * içine kadar özyinelemeli. Denetimde "testler sayı sayıyor, içerik
 * doğrulamıyor" bulgusu bu yüzden çıkmıştı; sıkıştırma regresyon testleri
 * gerçekten görsel sayısını ve filtrelerini ölçebilmeli.
 *
 * Dönüş: [{width, height, filter, colorSpace, depth, bytes, path}]
 */
export async function collectImages(bytes) {
    const { PDFName, PDFDict } = require('pdf-lib');
    const doc = await PDFDocument.load(bytes);
    // pdf-lib, iç içe referansları ancak flush() sonrasında
    // context.lookup ile çözebiliyor (uygulamadaki pdfCompressImages ile
    // aynı gereklilik).
    await doc.flush();
    const resolve = (v) => (v && v.tag ? doc.context.lookup(v) : v);
    const out = [];
    const visited = new Set();

    const visitResources = (resources, path, host) => {
        const res = resolve(resources);
        if (!res || typeof res.lookupMaybe !== 'function') return;
        const xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (xo) {
            for (const key of xo.keys()) {
                const obj = resolve(xo.get(key));
                if (!obj || !obj.dict || visited.has(obj)) continue;
                visited.add(obj);
                const subtype = String(obj.dict.lookup(PDFName.of('Subtype')) ?? '');
                if (subtype === '/Form') {
                    visitResources(resolve(obj.dict.lookup(PDFName.of('Resources'))), `${path}/${String(key)}`);
                } else if (subtype === '/Image') {
                    out.push(describe(obj, `${path}/${String(key)}`));
                }
            }
        }
        // Annots -> /AP -> /N  (widget annotation görselleri: onay damgası, imza)
        // DİKKAT: /Annots SAYFA sözlüğünde durur, /Resources içinde değil.
        const hostDict = host && typeof host.lookupMaybe === 'function' ? host : null;
        const annots = hostDict ? hostDict.lookupMaybe(PDFName.of('Annots'), require('pdf-lib').PDFArray) : null;
        if (annots) {
            for (let i = 0; i < annots.size(); i++) {
                const annot = resolve(annots.lookup(i));
                // annot bir PDFDict'tir; akış nesnesi (PDFRawStream) değil.
                const annotDict = annot && annot.contents ? annot.dict : annot;
                if (!annotDict || typeof annotDict.lookup !== 'function') continue;
                const ap = resolve(annotDict.lookup(PDFName.of('AP')));
                if (!ap || typeof ap.lookup !== 'function') continue;
                // /AP /N bir AKIŞTIR (görünüm formu); /Resources onun
                // sözlüğündedir. PDFDict olmadığı için lookupMaybe PATLAR.
                const normal = resolve(ap.lookup(PDFName.of('N')));
                const normalDict = normal && normal.contents ? normal.dict : normal;
                if (normalDict && typeof normalDict.lookup === 'function') {
                    visitResources(resolve(normalDict.lookup(PDFName.of('Resources'))), `${path}/annot${i}/AP/N`);
                }
            }
        }
        // Pattern -> painter -> /Resources
        const patterns = res.lookupMaybe(PDFName.of('Pattern'), PDFDict);
        if (patterns) {
            for (const key of patterns.keys()) {
                const pat = resolve(patterns.get(key));
                // DİKKAT: PDFDict'in `.dict` ÖZELLİĞİ içteki Map'tir (sözlük
                // DEĞİL). Yalnızca AKIŞLarda (contents'ı vardır) .dict sözlüktür.
                const patDict = pat && pat.contents ? pat.dict : pat;
                if (!patDict || typeof patDict.lookup !== 'function') continue;
                // pdf-lib adı '/1' ve '1' olarak raporlayabilir; ikisini de kabul et.
                const patternType = String(patDict.lookup(PDFName.of('PatternType')) ?? '').replace(/^\//, '');
                if (patternType === '1') {
                    visitResources(resolve(patDict.lookup(PDFName.of('Resources'))), `${path}/pattern${String(key)}`);
                }
            }
        }
    };

    const describe = (obj, path) => {
        const d = obj.dict;
        return {
            path,
            width: Number(d.lookup(PDFName.of('Width')) ?? 0),
            height: Number(d.lookup(PDFName.of('Height')) ?? 0),
            filter: String(d.lookup(PDFName.of('Filter')) ?? 'null'),
            colorSpace: describeColorSpace(d.lookup(PDFName.of('ColorSpace'))),
            depth: Number(d.lookup(PDFName.of('BitsPerComponent')) ?? 0),
            hasSmask: d.has(PDFName.of('SMask')),
            decode: d.has(PDFName.of('Decode')) ? String(d.lookup(PDFName.of('Decode'))) : null,
            bytes: obj.contents ? obj.contents.length : 0
        };
    };

    doc.getPages().forEach((page, i) => visitResources(page.node.Resources(), `p${i + 1}`, page.node));
    return out;
}

function describeColorSpace(cs) {
    if (cs === undefined || cs === null) return null;
    const name = cs.constructor ? cs.constructor.name : typeof cs;
    if (name === 'PDFArray') {
        const head = cs.lookup(0);
        // PDFName.toString() kaçışlı biçim verir ('/Indexed' -> '#2FIndexed')
        const first = head && head.asString ? '/' + head.decodeText().replace(/^\//, '') : String(head ?? '');
        const n = cs.size();
        return n === 1 ? first : first + (n === 4 ? ' CMYK' : `[${n}]`);
    }
    return String(cs);
}
