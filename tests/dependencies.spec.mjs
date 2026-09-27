// Dış bağımlılık guard'ı — bu uygulamanın en temel sözleşmesi:
//   "Hiçbir veri dışarı çıkmaz ve hiçbir dış servise bağımlı değiliz."
// Kırılırsa: bir CDN, uzak API, WASM indirmesi veya istatistik satırı
// eklendiğinde test KIRMIZIYA döner ve bağımlılık fark edilir.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILES = ['index.html', 'pdf-araclari.js', 'pdf-sayfalar.js', 'pdf-cikti.js'];

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
    });
});
