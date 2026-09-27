// Dış bağımlılık guard'ı — bu uygulamanın en temel sözleşmesi:
//   "Hiçbir veri dışarı çıkmaz ve hiçbir dış servise bağımlı değiliz."
// Kırılırsa: bir CDN, uzak API, WASM indirmesi veya istatistik satırı
// eklendiğinde test KIRMIZIYA döner ve bağımlılık fark edilir.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILES = ['index.html', 'pdf-araclari.js', 'pdf-sayfalar.js', 'pdf-cikti.js'];

const PINNED = {
    'pdf-lib.min.js': '0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f',
    'pdf.min.js': '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946',
    'pdf.worker.min.js': 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
    'vendor/fontawesome/css/all.min.css': 'b8eb6937afd970383594d6955d32289d6fc751601226e03eb62a3ebab65db99a',
    'vendor/fontawesome/webfonts/fa-brands-400.woff2': '748332090c4b8e20f95d0ff59f0be20fa9c889359d3b36d4b886d73376054207',
    'vendor/fontawesome/webfonts/fa-regular-400.woff2': '8e7e5ea1b15f62ab14dbd41768e8fbcd21cc859a4ea5da812457ee714299fb35',
    'vendor/fontawesome/webfonts/fa-solid-900.woff2': '7152a6933ee3d690ec2af3d09da9d701723d16aa3410a6d80f28ff8866f3b880',
    'vendor/fontawesome/webfonts/fa-v4compatibility.woff2': '694a17c3d9d6c05f8aac63c544615552a4b220e9a4de863d87341a6bcfc1bc8d',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7W0Q5n-wU.woff2': 'aebf2ab4a4ce6810d73c1ac7be7cafb4e5ec4cee2d6db5fb3e09691747ec4bd6',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2': 'c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7W0Q5n-wU.woff2': '46dd4cdca58c26ae87cc6927657bf83b2e8abfc39ffd0ab176e301a8d28d22bf',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2': 'a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7W0Q5n-wU.woff2': 'fccca918fea40089dacadc7045861314d1a6bc91f1f323cc1eeb22ebcdb321b5',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7W0Q5n-wU.woff2': 'a2e2c783ca6f9c20486e81e72a279203e86730bbf8f01ff6a5ee9dbd09e1c271',
    'vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7W0Q5n-wU.woff2': '8db00ff46c67b22cda8bed865acf7077651cac8d2841d5b40980556b48961931',
    'vendor/fonts/inter.css': '1c761aefd4ba31eed5a67f9f37b956d7c20aaf1d2ae648acce27570f1101260b',
};

/** Sabitlenmesi gereken dosyalar: kök kütüphaneler + vendor/ altındaki her şey. */
function listPinnable() {
    const libs = ['pdf-lib.min.js', 'pdf.min.js', 'pdf.worker.min.js'];
    const vendor = walk(join(REPO, 'vendor')).map((f) => f.slice(REPO.length + 1).split('\\').join('/'));
    return [...libs, ...vendor];
}

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

test.describe('dış bağımlılık yasağı', () => {
    test('U1: uygulama kodunda ağ çağrısı ve yüklenen dış adres yok', () => {
        // Ağ çağrısı aramaları UYGULAMA kodunda yapılır. `vendor/` altındaki
        // kütüphaneler kendi içinde fetch/XHTML tanımları bulundurabilir;
        // önemli olan bizim onları ÇAĞIRMEMİZ, o yüzden yüklenen kaynak ve
        // kendi kodumuzun ağ çağrıları denetlenir.
        const files = APP_FILES.map((f) => join(REPO, f));
        const forbidden = [
            /\bfetch\s*\(/,
            /XMLHttpRequest/,
            /new\s+WebSocket/,
            /sendBeacon/,
            /EventSource/,
            /importScripts/,
            /navigator\.connection/,
            /google-analytics|gtag\(|fbq\(|hotjar/i
        ];
        const problems = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const pattern of forbidden) {
                if (pattern.test(text)) problems.push(`${file}: ${pattern}`);
            }
        }
        expect(problems).toEqual([]);
    });

    test('U2: index.html içindeki her kaynak depo içinde bir dosya', () => {
        const html = readFileSync(join(REPO, 'index.html'), 'utf8');
        // YÜKLENEN kaynaklar: <img src>, <script src>, <link href>.
        // <a href> bir BAĞLANTIDIR; kullanıcı tıklarsa yeni sekmede açılır ve
        // hiçbir veri gönderilmez — bu yüzden kaynak sayılmaz.
        const refs = [...html.matchAll(/<(?:img|script|iframe|source)\s[^>]*?src\s*=\s*"([^"]+)"/g)]
            .map((m) => m[1])
            .concat([...html.matchAll(/<link\s[^>]*?href\s*=\s*"([^"]+)"/g)].map((m) => m[1]))
            .filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
        expect(refs.length).toBeGreaterThan(3);
        for (const ref of refs) {
            if (/^https?:/i.test(ref)) {
                throw new Error(`Dış kaynak yükleniyor: ${ref}`);
            }
            expect(existsSync(join(REPO, ref)), `${ref} depoda yok`).toBe(true);
        }
    });

    test('U3: dış adres geçen satırlar yalnızca yorum/lisans metni', () => {
        // FontAwesome lisans bağlantıları gibi gerçek kaynak olmayan adresler
        // kabul edilir; yüklenen kaynak (url(...), src=) olmamalıdır.
        const problems = [];
        for (const file of walk(join(REPO, 'vendor'))) {
            if (!/\.(css|js)$/.test(file)) continue;
            const text = readFileSync(file, 'utf8');
            for (const line of text.split('\n')) {
                if (!/https?:\/\//.test(line)) continue;
                if (/^\s*(\/\*|\*|\/\/)/.test(line)) continue;      // yorum satırı
                if (/url\(\s*['"]?https?:/i.test(line)) {
                    problems.push(`${file}: ${line.trim().slice(0, 80)}`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    test('U4: kütüphaneler depoda ve sürümleri sabit', () => {
        for (const lib of ['pdf-lib.min.js', 'pdf.min.js', 'pdf.worker.min.js']) {
            expect(existsSync(join(REPO, lib)), `${lib} depoda yok`).toBe(true);
        }
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
        // Kütüphaneler build'de değil, depoda tutulur; sürümler kesin (^/~ yok).
        for (const [name, range] of Object.entries(pkg.devDependencies || {})) {
            expect(range, `${name} sürümü kesin olmalı`).toMatch(/^\d+\.\d+\.\d+$/);
        }
    });

    test('U5: içerik güvenlik politikası ağa kapalı', () => {
        const html = readFileSync(join(REPO, 'index.html'), 'utf8');
        const csp = html.match(/content="([^"]*default-src[^"]*)"/)?.[1] || '';
        expect(csp).toContain("connect-src 'none'");
        expect(csp).not.toContain('unsafe-eval');
        expect(csp).not.toContain('wasm-unsafe-eval');
        // Görseller de yalnızca depodan/yerelden gelir: uzak görsel, açılan
        // sayfanın dışarıya istek atmasının (izleme pikseli) kapısıdır.
        const imgSrc = csp.match(/img-src([^;]*)/)?.[1] || '';
        expect(imgSrc.trim().split(/\s+/).sort()).toEqual(["'self'", 'blob:', 'data:']);
    });

    test('U6: depodaki kütüphane ve vendor dosyaları değiştirilmemiş (SHA-256)', () => {
        // Bir kütüphane dosyası sessizce değişirse (elle düzenleme, bozuk
        // kopya, tedarik zinciri) test kırmızıya döner. Bilinçli güncellemede
        // `npm run sync-libs` sonrası bu özetler de güncellenir.
        const files = [...Object.keys(PINNED)];
        const actual = listPinnable();
        expect(actual.sort(), 'sabitlenmemiş yeni vendor dosyası').toEqual(files.sort());
        for (const [rel, sha] of Object.entries(PINNED)) {
            const hash = createHash('sha256').update(readFileSync(join(REPO, rel))).digest('hex');
            expect(hash, `${rel} değişmiş`).toBe(sha);
        }
    });
});
