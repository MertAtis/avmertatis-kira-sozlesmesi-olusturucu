/* =============================================================================
 * tek-dosya-olustur.mjs — siteyi TEK html dosyasına paketler.
 *
 * Çıktı: <repo kökü>/tek-dosya.html — internet olmadan, dosyaya çift tıklayarak
 * (file://) açılır ve tüm araçların tamamı çalışır. Yalnızca eklemeler yapılır:
 * index.html ve kütüphaneler HİÇ değiştirilmez; bütün yamalar çıktının kopyası
 * üzerinde uygulanır, böylece yayındaki site birebir aynı kalır.
 *
 * Kullanım:  npm run tek-dosya   (veya: node scripts/tek-dosya-olustur.mjs)
 * Doğrulama: tests/tek-dosya.spec.mjs (tazelik + üretilmiş dosyanın smoke'u)
 * ========================================================================== */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CSS_LINK_TAGS = {
    'vendor/fonts/inter.css': '<link href="vendor/fonts/inter.css" rel="stylesheet">',
    'vendor/fontawesome/css/all.min.css': '<link rel="stylesheet" href="vendor/fontawesome/css/all.min.css">',
};
const APP_SCRIPTS = ['pdf-tiff.js', 'pdf-araclari.js', 'pdf-sayfalar.js', 'pdf-cikti.js'];
const VERASET_PDF = path.join(repoRoot, 'belgeler', 'veraset-intikal-beyannamesi-bos.pdf');

const MIME_BY_EXT = {
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.pdf': 'application/pdf', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
};

/** Kesin marker bulamayan build, çıktı yazmadan HATA fırlatır (sessiz bozukluk yasak). */
function assertOnce(text, marker, label) {
    const count = text.split(marker).length - 1;
    if (count !== 1) {
        throw new Error(`Tek-dosya build: marker ${count || 0} kez bulundu (1 beklenir): ${label ?? marker} — index.html düzenlenmiş olabilir.`);
    }
}

/** css yolu repo köküne göre; url(...) kaynaklarını data URI'ye çevirir. */
function inlineCssUrls(cssText, cssRelPath) {
    const cssDir = path.dirname(path.join(repoRoot, cssRelPath));
    return cssText.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g, (m, _q, target) => {
        if (/^(data:|https?:)/.test(target)) return m;
        const abs = path.resolve(cssDir, decodeURIComponent(target.split('?')[0].split('#')[0]));
        const bytes = readFileSync(abs); // dosya yoksa build çökerr (sessiz eksiklık yasak)
        const ext = path.extname(abs).toLowerCase();
        const mime = MIME_BY_EXT[ext];
        if (!mime) throw new Error(`Tek-dosya build: bilinmeyen MIME türü (${abs})`);
        return `url(data:${mime};base64,${Buffer.from(bytes).toString('base64')})`;
    });
}

/**
 * Satır içine alınan <script> gövdesinde </script dizisini nötrleştirir.
 * B7 JS dosyalarında bu dize yok (test eder); yine de geleceğe karşı güvenli.
 * Dize içinde '<\\/' g ÇIKTISI yine '</' olur — tarayıcıda birebir aynı baytlar.
 */
function escapeScriptClose(js) {
    return js.replace(/<\/(script)/gi, '<\\/$1');
}

function readInlineScript(rel) {
    return `<script>\n${escapeScriptClose(readFileSync(path.join(repoRoot, rel)).toString('utf8'))}\n</script>`;
}

export function tekDosyaHtml() {
    let html = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

    // --- 0) üretim rozeti -------------------------------------------------------
    html = html.replace(
        /<!doctype html>/i,
        (m) => `${m}\n<!-- OTO ÜRETİM — ELLE DÜZENLEME — kaynak: index.html — üreten: node scripts/tek-dosya-olustur.mjs -->`,
    );

    // --- 1) CSP: veraset iframe yazdırması artık blob: url — frame-src ekle ---
    assertOnce(html, "img-src 'self' data: blob:;", 'CSP img-src');
    html = html.replace(
        "img-src 'self' data: blob:;",
        "img-src 'self' data: blob:; frame-src 'self' blob:;",
    );

    // --- 2) CSS'leri satır içine al (yazı tipleri → data URI ) ----------------
    for (const [rel, tag] of Object.entries(CSS_LINK_TAGS)) {
        assertOnce(html, tag, rel);
        html = html.replace(tag, `<style data-tek-css="${rel}">${inlineCssUrls(readFileSync(path.join(repoRoot, rel), 'utf8'), rel)}</style>`);
    }

    // --- 3) Uygulama betikleri: satır içine al + tek-dosya yamaları -----------
    let pdfCiktiInline = null;
    for (const src of APP_SCRIPTS) {
        const tag = `<script src="${src}"></script>`;
        assertOnce(html, tag, src);
        let inlined = readInlineScript(src);
        if (src === 'pdf-sayfalar.js') {
            const workerSrcLine = "pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';";
            assertOnce(inlined, workerSrcLine, 'workerSrc satırı');
            inlined = inlined.replace(workerSrcLine, 'pdfjsLib.GlobalWorkerOptions.workerSrc = window.__tekWorkerUrl;');
        }
        if (src === 'pdf-araclari.js') {
            const startMarker = 'function loadScript(src) {';
            assertOnce(inlined, startMarker, 'loadScript açılışı');
            const start = inlined.indexOf(startMarker);
            // İşlev, dosyada ilk '\n}\n' ile biter (gövdede boş satır yok — sed çıktısı incelendi).
            const end = inlined.indexOf('\n}\n', start) + 3;
            const shim = [
                'function loadScript(src) {',
                '    // TEK-DOSYA: kütüphaneler bu dosyanın içine gömülüdür; dış dosya yüklenmez.',
                '    return new Promise((resolve, reject) => {',
                "        if (src === 'pdf-lib.min.js' && window.PDFLib) return resolve();",
                "        if (src === 'pdf.min.js' && window.pdfjsLib) return resolve();",
                "        if (src === 'pdf.worker.min.js' && window['pdfjs-dist/build/pdf.worker']) return resolve();",
                "        reject(new Error('Yükleme hatası: ' + src));",
                '    });',
                '}',
            ].join('\n');
            inlined = inlined.slice(0, start) + shim + inlined.slice(end);
        }
        if (src === 'pdf-cikti.js') pdfCiktiInline = inlined;
        html = html.replace(tag, () => inlined);
    }

    // --- 4) Gömülü yükler: worker + veraset PDF (base64) + pdf-lib + pdf.js ---
    // pdf-cikti inline'ından HEMEN sonra yer alır: ana inline script'ten önce,
    // loadPdfLibs() ilk çağrısından önce (runtime duck-typing shim'i yeterli).
    const workerB64 = Buffer.from(readFileSync(path.join(repoRoot, 'pdf.worker.min.js'))).toString('base64');
    const verasetB64 = Buffer.from(readFileSync(VERASET_PDF)).toString('base64');
    const bootstrap = `<script>
/* TEK-DOSYA: gömülü yükler — bağlanılacak hiçbir dış yol yok; hepsi bu dosyada. */
(function () {
    'use strict';
    function b64ToU8(b64) {
        const raw = atob(b64);
        const u8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
        return u8;
    }
    /* pdf.js worker'ı: tek dosyada, blob URL olarak veriliyor (CSP worker-src blob:). */
    window.__tekWorkerUrl = URL.createObjectURL(new Blob([b64ToU8(${JSON.stringify(workerB64)})], { type: 'application/javascript' }));
    /* Boş veraset beyanname formu: kayıpsız, orijinal baytlar (lazy blob). */
    let verasetUrl = null;
    window.__tekVerasetUrl = function () {
        return verasetUrl || (verasetUrl = URL.createObjectURL(new Blob([b64ToU8(${JSON.stringify(verasetB64)})], { type: 'application/pdf' })));
    };
})();
</script>`;
    html = html.replace(pdfCiktiInline, () => `${pdfCiktiInline}\n${bootstrap}\n${readInlineScript('pdf-lib.min.js')}\n${readInlineScript('pdf.min.js')}\n${readInlineScript('pdf.worker.min.js')}`);

    // --- 5) Veraset PDF referanslarını gömülü yüklere bağla -------------------
    assertOnce(html, 'id="btn-veraset-indir" href="belgeler/veraset-intikal-beyannamesi-bos.pdf"', 'veraset indir <a>');
    html = html.replace(
        'id="btn-veraset-indir" href="belgeler/veraset-intikal-beyannamesi-bos.pdf"',
        'id="btn-veraset-indir" href="#"');
    assertOnce(html, "const url = 'belgeler/veraset-intikal-beyannamesi-bos.pdf';", 'verasetBeyannameYazdir url');
    html = html.replace(
        "const url = 'belgeler/veraset-intikal-beyannamesi-bos.pdf';",
        'const url = window.__tekVerasetUrl();');

    // İndir düğmesinin href'i, ana inline script başında (DOM hazır) blob URL'e bağlanır.
    const mainScriptStartMarker = "    let currentTab = 'kira';";
    assertOnce(html, mainScriptStartMarker, 'ana inline script başlangıcı');
    html = html.replace(
        mainScriptStartMarker,
        `    document.getElementById('btn-veraset-indir').href = window.__tekVerasetUrl();\n${mainScriptStartMarker}`,
    );

    // --- 6) Tek-dosya indirme düğmesini ÇIKAR ------------------------------------
    // index.html'deki #btn-tek-dosya ürettiği dosyanın İÇİNDE anlamsızdır
    // (kendine işaret eder); canlı sitede kalır, çıktıdan şeritlenir.
    const btnRe = /<a\b[^>]*id="btn-tek-dosya"[^>]*>[\s\S]*?<\/a>\s*/g;
    if (!/id="btn-tek-dosya"/.test(html)) throw new Error("index.html'de #btn-tek-dosya yok — düğme kaldırılmış olabilir.");
    html = html.replace(btnRe, '');
    if (/id="btn-tek-dosya"/.test(html)) throw new Error('#btn-tek-dosya çıktıdan şeritlenemedi.');

    // --- 7) Sonlu denetim: dış dosya referansı kalmamalı -----------------------
    for (const bad of [
        /<script src="/,
        /<link href="vendor\//,
        /href="belgeler\//,
        /src="belgeler\//,
        /veraset-intikal-beyannamesi/,
    ]) {
        const m = html.match(bad);
        if (m) throw new Error(`Tek-dosya build: dış dosya referansı kaldı: ${m[0]}`);
    }

    return html;
}

// --- CLI -----------------------------------------------------------------------

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const html = tekDosyaHtml();
    const sha = createHash('sha256').update(html).digest('hex');
    writeFileSync(path.join(repoRoot, 'tek-dosya.html'), html);
    console.log(`tek-dosya.html yazıldı — ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB  sha256=${sha.slice(0, 16)}…`);
}
