// Kütüphane dosyalarını node_modules'ten depo köküne kopyalar.
// Böylece sürümler package.json ile senkron kalır ve elle güncellenmez.
//
// Kütüphaneler UMD derlemesidir (pdf.js 3.x'in son UMD sürümü). Bu bilinçli
// bir seçimdir: pdf.js 4+ yalnızca ESM yayınlıyor ve `file://` altında
// `<script type="module">` CORS kuralları gereği engellenir. README'deki
// "index.html dosyasına çift tıklayarak açın" yolu ESM ile bozulur.

import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
    { from: 'node_modules/pdf-lib/dist/pdf-lib.min.js', to: 'pdf-lib.min.js' },
    { from: 'node_modules/pdfjs-dist/build/pdf.min.js', to: 'pdf.min.js' },
    { from: 'node_modules/pdfjs-dist/build/pdf.worker.min.js', to: 'pdf.worker.min.js' }
];

for (const file of FILES) {
    const source = join(REPO, file.from);
    if (!existsSync(source)) {
        console.error(`Eksik: ${file.from}\nÖnce \`npm install\` çalıştırın.`);
        process.exit(1);
    }
    const target = join(REPO, file.to);
    copyFileSync(source, target);
    const kb = (statSync(target).size / 1024).toFixed(1);
    console.log(`${file.to.padEnd(20)} ${kb.padStart(9)} KB`);
}
