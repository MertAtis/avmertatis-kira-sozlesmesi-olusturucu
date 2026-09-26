// Üçüncü taraf kaynakları depoya gömerek tamamen sessiz (offline) çalışma.
//
//   vendor/fonts/       Inter yazı tipi (Google Fonts'tan)
//   vendor/fontawesome/ Font Awesome 6.4.0 (cdnjs'ten)
//
// Gömerek silmek yerine yerelleştiriyoruz; böylece görünüm birebir korunuyor
// ve sayfa hiçbir dış istek yapmıyor. Yeni dosya üretmek için:
//   node tests/sync-vendor.mjs
//
// Bu bir kez çalıştırılan bir betiktir; çıktısı depoya işlenir.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function get(url, asText) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

async function vendorInter() {
    const dir = join(REPO, 'vendor', 'fonts');
    mkdirSync(dir, { recursive: true });

    const url = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    let css = await get(url, true);

    // unicode-range alt kümelerinin hepsini indir ve yerele çevir.
    const urls = [...new Set(
        [...css.matchAll(/url\((https:[^)\s]+\.woff2)\)/g)].map((m) => m[1])
    )];

    if (urls.length === 0) {
        throw new Error(`Inter woff2 kaynağı bulunamadı (CSS ${css.length} bayt): ${css.slice(0, 200)}`);
    }

    let total = 0;
    for (const fontUrl of urls) {
        const name = fontUrl.split('/').pop();
        const target = join(dir, name);
        if (!existsSync(target)) {
            writeFileSync(target, await get(fontUrl, false));
        }
        css = css.split(fontUrl).join(`./${name}`);
        total++;
    }
    writeFileSync(join(dir, 'inter.css'), css);
    console.log(`Inter: ${total} woff2 + inter.css`);
}

async function vendorFontAwesome() {
    const dir = join(REPO, 'vendor', 'fontawesome');
    const webfonts = join(dir, 'webfonts');
    mkdirSync(webfonts, { recursive: true });

    const url = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
    let css = await get(url, true);

    const assets = [...new Set([...css.matchAll(/url\(\.\.\/webfonts\/([^)]+)\)/g)].map((m) => m[1]))];
    for (const name of assets) {
        const target = join(webfonts, name);
        if (!existsSync(target)) {
            writeFileSync(target, await get(
                `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/${name}`, false));
        }
    }
    // CSS ../webfonts/ yolunu kullanıyor; dosya vendor/fontawesome/ altında
    // olduğu için yol yerinde doğru.
    writeFileSync(join(dir, 'all.min.css'), css);
    console.log(`Font Awesome: ${assets.length} webfont + all.min.css`);
}

await vendorInter();
await vendorFontAwesome();
console.log('Tamamlandı.');
