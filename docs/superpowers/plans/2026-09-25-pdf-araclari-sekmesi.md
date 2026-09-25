# PDF Araçları Sekmesi — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mevcut `index.html` uygulamasına 6. sekme (`PDF Araçları`) eklemek: çoklu PDF birleştirme, sayfa silme/sıralama/döndürme, A4 normalize, görsel yeniden kodlamayla küçültme ve görsele çevirme.

**Architecture:** Kütüphaneler depoya elle eklenen UMD dosyalarıdır ve çalışma anında `<script>` enjeksiyonuyla **lazy** yüklenir. Uygulama kodu `index.html` içine gömülmez; sorumluluğu ayrılmış üç dosyada yaşar (`pdf-araclari.js` durum + yükleme, `pdf-sayfalar.js` sayfa ızgarası, `pdf-cikti.js` çıktı üretimi) ve tek bir olay veriyolu (`pdfBus`) üzerinden haberleşir.

**Tech Stack:** pdf-lib 1.17.1 (UMD), pdf.js 3.11.174 (UMD, worker dahil), Playwright 1.63.0 (Chromium), Node.js

**Spec:** `docs/superpowers/specs/2026-09-25-pdf-araclari-sekmesi-design.md`

---

## Global Constraints

Bunlar her görevin gereksinimlerine örtük olarak dahildir.

- **Kütüphane sürümleri sabit:** `pdf-lib@1.17.1`, `pdfjs-dist@3.11.174`, `playwright@1.63.0`. pdf.js 4+ **kullanılamaz** (ESM-only; `file://` altında `<script type="module">` CORS ile engellenir, README'deki "çift tıkla aç" yolu bozulur).
- **A4 ölçüsü:** `595.28 × 841.89` pt. Testlerde `MediaBox` bu değerlere eşit olmalı (tolerans ±0.5).
- **Boyut sınırları:** tek dosya > 50 MB reddedilir, toplam > 150 MB reddedilir. Sınırlar yükleme *öncesi* kontrol edilir.
- **A4 dönüşümü sırası (spec boşluğu — bu plan kararı verir):** Her sayfada önce `/Rotate` uygulanır, sonra A4'e sığdırma yapılır ve sığdırma **döndürülmüş** sınır kutusu üzerinden hesaplanır (90°/270° için genişlik/yükseklik yer değiştirir). Bu sıra ters çevrilirse çift döndürme veya yanlış ölçek üretir.
- **A4 dönüşümü kırpmaz:** içerik ölçeklenip ortalanır, kırpma yapılmaz, ek kenar boşluğu eklenmez. A5/A6 girdiler büyütülür.
- **Sıkıştırma atlama kuralları (mod 1):** `/BitsPerComponent` 8 **ve** `/ColorSpace` `DeviceRGB` veya `DeviceGray` **ve** `/SMask` yok **ve** `/Filter` `FlateDecode` veya filtre yok **ve** çözülmüş boyut > 20 KB. `DCTDecode` (zaten JPEG) görseller atlanır.
- **Kayıp modu varsayılan kapalıdır** ve işaretlenirse onay modalı zorunludur. Modal iptal edilirse hiçbir dosya üretilmez.
- **Durum referans tabanlıdır:** `pdfState.pages` yalnızca `{uid, fileId, srcIndex, rotation, thumbUrl, thumbError}` tutar; PDF sayfa nesneleri kopyalanmaz. Çıktı yalnızca indirme anında `pdfBuildOutput()` ile kurulur.
- **Konsola dosya içeriği yazdırılmaz.** Hatalar `console.error` ile loglanır, içerik yok.
- **Yeni CSS değişkeni tanımlanmaz.** Tüm renkler mevcut `--card`, `--border`, `--primary`, `--muted`, `--input`, `--radius` değişkenlerinden gelir; karanlık mod `[data-theme="dark"]` üzerinden otomatik çalışır.
- **Yeni global isimler `pdf` önekiyle başlar** ve mevcut global isimlerle (`currentTab`, `renderPreview`, `handlePrint`, `toggleTheme`) çakışmaz.
- **Mevcut davranış değişmez:** 5 sekme, `renderPreview()`, `handlePrint()`, tema anahtarı, `no-print` yazdırma davranışı.
- **Arayüz metinleri Türkçedir** ve `İ`/`ı`/`ş`/`ğ` karakterlerini doğru kullanır.

---

## Review Focus

Bunlar spec'in ima ettiği ancak hiçbir testin ölçmediği giriş sınıflarıdır. Her satır, sahibi olan göreve bir test olarak eklenmiştir.

| # | Giriş / durum | Beklenen davranış | Sahip görev |
|---|---|---|---|
| 1 | Dosya adında `/`, `&`, `'`, `ç`, boşluk, emoji var (ör. `Ahmet & Ayşe/Kira.pdf`) | Dosya listesi adı kesmeden gösterir; indirilen dosya adında `/` temizlenir, kayıt başarısız olmaz | Task 3 |
| 2 | Farklı klasörlerden gelen **aynı adlı** iki dosya (`fatura.pdf` × 2) | Listede iki ayrı satır; her biri kendi `fileId`'siyle, çıktıda iki ayrı sayfa grubu | Task 3 |
| 3 | Aynı kaynak sayfa listenin **farklı, bitişik olmayan** konumlarında 3 kez | Çıktıda 3 kopya bulunur, `copyPages` tekrarında çökme olmaz | Task 5 |
| 4 | Görseller bir **Form XObject'in içinde** gömülü | Mod 1 bu görselleri bulamaz; sessizce atlar, çıktı üretilir, kullanıcı yanlış başarı mesajı görmez — boyut değişimi dürüstçe raporlanır | Task 6 |
| 5 | 90° döndürülmüş **A5** sayfa + A4 normalize | Döndürme sonrası sınır kutusu (A5 yatay) üzerinden ölçeklenir, sayfa A4'e tam sığar ve yatayda ortalanır | Task 5 |

---

## Dosya Haritası

| Dosya | Sorumluluk | Oluşturma |
|---|---|---|
| `package.json` | Yalnızca devDependencies + `sync-libs` / `test` scriptleri | Task 1 |
| `playwright.config.mjs` | `file://` tabanlı testler, Chromium | Task 1 |
| `tests/fixtures/build-fixtures.mjs` | 9 test fixture'ı üretir (RC4 şifreli + 60 MB dahil) | Task 1 |
| `tests/helpers/inspect.mjs` | Çıktı PDF'lerini denetleme yardımcıları | Task 1 |
| `tests/pdf-araclari.spec.mjs` | T01–T24 Playwright testleri | Task 1'den itibaren büyür |
| `pdf-lib.min.js` | pdf-lib UMD derlemesi (node_modules'tan kopyalanır) | Task 2 |
| `pdf.min.js`, `pdf.worker.min.js` | pdf.js UMD derlemesi (node_modules'tan kopyalanır) | Task 2 |
| `index.html` | CSP `worker-src`, 6. sekme butonu, panel HTML/CSS | Task 2, 8 |
| `pdf-araclari.js` | `loadScript`, `loadPdfLibs`, `pdfState`, `pdfBus`, `addFiles`, dosya listesi, hata yönetimi | Task 3 |
| `pdf-sayfalar.js` | Küçük resim ızgarası, sürükle-bırak, döndür, sil, geri al | Task 4 |
| `pdf-cikti.js` | `pdfBuildOutput`, A4 normalize, sıkıştırma mod 1 ve 2 | Task 5–7 |
| `README.md` | Yeni özellik ve test talimatları | Task 9 |

`index.html` içine hiçbir PDF iş mantığı yazılmaz; yalnızca CSP satırı, sekme butonu, panel iskeleti ve `<script>` yokluğu (lazy enjeksiyon) yer alır.

---

## Ortak Arayüzler

Görevler birbirinin isimlerini bu bloklardan öğrenir. Bu bloklar plana aittir, sonradan değiştirilmez.

**`pdfState`** (tanım: `pdf-araclari.js`)

```js
const pdfState = {
  files: [],   // {id: string, name: string, bytes: number, doc: PDFDocument, pageCount: number, error: string|null}
  pages: [],   // {uid: string, fileId: string, srcIndex: number, rotation: 0|90|180|270, thumbUrl: string|null, thumbError: boolean}
  output: { a4: true, compress: false, quality: 0.7, lossy: false },
  undoStack: [],  // {pages: Array, label: string} — en fazla 20
  busy: false,
  libsLoaded: false
};
```

**`pdfBus`** (tanım: `pdf-araclari.js`)

```js
pdfBus.on(event, handler)   // event: 'files' | 'pages' | 'busy' | 'result'
pdfBus.emit(event, payload)
```

**Fonksiyon imzaları**

| imza | tanımlandığı görev |
|---|---|
| `loadScript(src: string) => Promise<void>` | Task 2 |
| `loadPdfLibs() => Promise<void>` | Task 2 |
| `pdfFormatBytes(n: number) => string` | Task 3 |
| `pdfIsMemoryError(message: string) => boolean` | Task 3 |
| `pdfShowError(fileName: string, message: string) => void` | Task 3 |
| `pdfSetBusy(isBusy: boolean) => void` | Task 3 |
| `addFiles(fileList: FileList) => Promise<void>` | Task 3 |
| `pdfRecordUndo(label: string) => void` | Task 4 |
| `pdfUndo() => void` | Task 4 |
| `pdfRotatePage(uid: string) => void` | Task 4 |
| `pdfDeletePage(uid: string) => void` | Task 4 |
| `pdfResetEdits() => void` | Task 4 |
| `pdfRenderThumb(entry) => Promise<void>` | Task 4 |
| `pdfBuildOutput() => Promise<{bytes: Uint8Array, originalSize: number, outputSize: number}>` | Task 5 |
| `pdfPlaceOnA4(targetDoc, srcPage, rotation) => PDFPage` | Task 5 |
| `pdfCompressImages(doc, quality) => Promise<number>` | Task 6 |
| `pdfRasterize(bytes: Uint8Array, rotations: number[], quality: number) => Promise<Uint8Array>` | Task 7 |

---

### Task 1: Test altyapısı ve fixture üretimi

**Dosyalar:**
- Oluştur: `package.json`
- Oluştur: `playwright.config.mjs`
- Oluştur: `tests/fixtures/build-fixtures.mjs`
- Oluştur: `tests/helpers/inspect.mjs`
- Oluştur: `tests/fixtures/fixtures.spec.mjs`

**Üretir:** 9 fixture + `inspect.mjs` API'si. Sonraki tüm görevler bu API'yi kullanır.

**Tüketir:** —

- [ ] **Adım 1: `package.json` oluştur**

`devDependencies`: `pdf-lib@1.17.1`, `pdfjs-dist@3.11.174`, `playwright@1.63.0`. Scriptler:
`"sync-libs": "node tests/sync-libs.mjs"`, `"fixtures": "node tests/fixtures/build-fixtures.mjs"`, `"test": "playwright test"`.
`"type": "module"`, `"private": true`.

- [ ] **Adım 2: `playwright.config.mjs` oluştur**

`testDir: './tests'`, `use: {}` (baseURL yok — testler `file://` kullanır), `projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}]`, `fullyParallel: true`, `reporter: [['list']]`.
`globalSetup` yok; fixture'lar `build-fixtures.mjs` tarafından idempotent olarak üretilir.

- [ ] **Adım 3: `tests/helpers/inspect.mjs` oluştur**

Dışa aktarılacak fonksiyonlar:

```js
export async function readPageBoxes(bytes: Uint8Array): Promise<Array<{width: number, height: number, rotation: number}>>
// her sayfa için MediaBox genişlik/yükseklik ve /Rotate değerini döndürür
export async function extractAllText(bytes: Uint8Array): Promise<string>
// pdf.js getTextContent ile tüm sayfaların metnini birleştirir
export async function readImageCount(bytes: Uint8Array): Promise<number[]>
// her sayfadaki Image subtype XObject sayısı
```

`extractAllText` içinde `pdfjsLib.GlobalWorkerOptions.workerSrc` `node_modules/pdfjs-dist/build/pdf.worker.js` dosyasına göre ayarlanır ve worker `disableWorker: true` seçeneğiyle kapatılır (Node ortamında worker yok).

- [ ] **Adım 4: Geçen testi yaz — `tests/fixtures/fixtures.spec.mjs`**

Testler ve beklenen sonuçlar:

| Test | Beklenen |
|---|---|
| `text-only.pdf üretilir ve 3 sayfada Türkçe metin okunabilir` | `extractAllText` sonucu `KİRA SÖZLEŞMESİ` içerir; `readPageBoxes` uzunluğu 3 |
| `scanned.pdf her sayfada 2 MB ham RGB bitmap içerir` | her sayfada `readImageCount` ≥ 1; dosya boyutu > 8 MB |
| `mixed-sizes.pdf A4, A5 ve Letter MediaBox içerir` | sayfa genişlikleri `[595.28, ~419.53, 612]` |
| `a+b+c toplam 11 sayfa` | `a.pdf` 4, `b.pdf` 3, `c.pdf` 4 |
| `encrypted.pdf pdf-lib tarafından şifreli olarak reddedilir` | `PDFDocument.load` `EncryptedPDFError` fırlatır; `V=1, R=2` |
| `corrupt.pdf yüklenemez` | `PDFDocument.load` hata fırlatır |
| `empty.pdf 0 sayfa` | `getPageCount() === 0` |
| `huge.pdf 60 MB ve ayrıştırılabilir` | boyut 60–70 MB arası; `getPageCount() === 1` |

- [ ] **Adım 5: Testi koşup geçtiğini doğrula**

Kurulum: `npm install && npx playwright install chromium`
Koşu: `npx playwright test tests/fixtures/fixtures.spec.mjs`
Beklenen: 8 test geçer.

- [ ] **Adım 6: Commit**

```bash
git add package.json package-lock.json playwright.config.mjs tests/
git commit -m "Add Playwright test harness and PDF fixture builder"
```

---

### Task 2: Kütüphane vendor'ı, CSP ve sekme iskeleti

**Dosyalar:**
- Oluştur: `tests/sync-libs.mjs`
- Oluştur: `pdf-lib.min.js`, `pdf.min.js`, `pdf.worker.min.js` (kopyalama ile)
- Değiştir: `index.html:6` (CSP) ve `index.html:698-714` (tab-container)

**Tüketir:** Task 1 `package.json`

**Üretir:** `loadScript(src)`, `loadPdfLibs()`, 6. sekme butonu, boş PDF paneli iskeleti.

- [ ] **Adım 1: Geçen testi yaz — `tests/pdf-araclari.spec.mjs` (ilk sürüm)**

```js
import { test, expect } from '@playwright/test';
const PAGE = 'file://' + new URL('../index.html', import.meta.url).pathname;

test('T01: kütüphaneler sekme açılınca yüklenir, konsol hatası yok', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(PAGE);
  await page.click('#tab-pdf-araclari');
  await expect.poll(() => page.evaluate(() => !!window.pdfState?.libsLoaded)).toBe(true);
  expect(await page.evaluate(() => typeof window.PDFLib?.PDFDocument)).toBe('function');
  expect(await page.evaluate(() => typeof window.pdfjsLib?.getDocument)).toBe('function');
  expect(errors).toEqual([]);
});
```

Aynı dosyaya T20 ve T22:

```js
test('T22: CSP ihlali yok', async ({ page }) => {
  const csp = [];
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
  await page.goto(PAGE);
  await page.click('#tab-pdf-araclari');
  await page.waitForTimeout(1500);
  expect(csp).toEqual([]);
});

test('T20: yazdırmada PDF Araçları sekmesi görünmez', async ({ page }) => {
  await page.goto(PAGE);
  const tab = page.locator('#pdf-araclari-form-block');
  await expect(tab).toBeVisible();
  // no-print sınıfı üzerinden print media'da gizlenmeli
  expect(await tab.evaluate(el => el.className)).toContain('no-print');
  expect(await page.locator('#tab-pdf-araclari').evaluate(el => el.closest('.tab-container').className)).toContain('no-print');
});
```

- [ ] **Adım 2: Testi koşup başarısız olduğunu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs`
Beklenen: T01, T20, T22 FAIL — `#tab-pdf-araclari` bulunamadı.

- [ ] **Adım 3: `tests/sync-libs.mjs` yaz**

`node_modules/pdf-lib/dist/pdf-lib.min.js` → `./pdf-lib.min.js`
`node_modules/pdfjs-dist/build/pdf.min.js` → `./pdf.min.js`
`node_modules/pdfjs-dist/build/pdf.worker.min.js` → `./pdf.worker.min.js`
Hedef dosya yoksa hata fırlatır (sessiz boş dosya yazmaz). `npm run sync-libs` ile çalıştırılır.

- [ ] **Adım 4: `index.html` CSP satırına `worker-src 'self' blob:;` ekle**

- [ ] **Adım 5: `index.html` içine lazy yükleme fonksiyonlarını ekle**

Mevcut `<script>` bloğunun sonuna, Global Constraints'teki `loadScript` ve `loadPdfLibs` imzalarına birebir uygun implementasyon. `pdfState` nesnesini Global Constraints'teki alanlarla birebir tanımla (bu görevde `addFiles` henüz yok; `pdfBus.on/emit` de tanımlanır).

- [ ] **Adım 6: Sekme butonunu ve panel iskeletini ekle**

`#tab-pdf-araclari` butonu `switchTab('pdf-araclari')` çağırır. `switchTab` içine: buton `.active` toggle'u ve `#pdf-araclari-form-block` display kontrolü. Panel iskeleti `no-print` sınıflı ve 4 aşama başlıklı boş bölümlerden oluşur (içerik sonraki görevlerde dolar).

- [ ] **Adım 7: `sync-libs` koş, testi geç**

```bash
npm run sync-libs && npx playwright test tests/pdf-araclari.spec.mjs
```
Beklenen: 3 test geçer.

- [ ] **Adım 8: Commit**

```bash
git add pdf-lib.min.js pdf.min.js pdf.worker.min.js tests/sync-libs.mjs index.html tests/pdf-araclari.spec.mjs
git commit -m "Add PDF libraries, worker-src CSP directive, and PDF Araclari tab shell"
```

---

### Task 3: Dosya yükleme, durum yönetimi, dosya listesi ve hata yönetimi

**Dosyalar:**
- Oluştur: `pdf-araclari.js`
- Değiştir: `index.html` (Aşama 1 HTML'i), `tests/pdf-araclari.spec.mjs`

**Tüketir:** `loadPdfLibs()` (Task 2), `pdfState`, `pdfBus` (Task 2)

**Üretir:** `addFiles`, `pdfFormatBytes`, `pdfShowError`, `pdfSetBusy`, `pdfBus.emit('files')`, `pdfState.files`

- [ ] **Adım 1: Geçen testleri yaz — T02, T03, T13, T14, T15, T16, T17 + Review Focus 1 ve 2**

| Test | Fixture | Beklenen |
|---|---|---|
| T02 | `a.pdf` | dosya listesinde 1 satır, "4 sayfa" yazıyor |
| T03 | `a.pdf` + `b.pdf` + `c.pdf` | 3 satır, 4/3/4 sayfa |
| T13 | `encrypted.pdf` | tam olarak bu metin görünür: `Bu PDF şifreli.` ve `Yazdır → PDF olarak kaydet`; konsolda `pageerror` yok |
| T14 | `corrupt.pdf` + `a.pdf` | `geçerli bir PDF değil veya bozuk` görünür **ve** `a.pdf` yüklenmiş olur (2. satır) |
| T15 | `empty.pdf` | `içinde sayfa bulunamadı` görünür |
| T16 | `huge.pdf` | `50 MB üzeri dosyalar işlenemez` görünür, dosya listeye hiç eklenmez |
| T17 | `a.pdf` × 2 | `pdfState.pages.length === 8` |
| RF1 | `Ahmet & Ayşe-test.pdf` (fixture'a ekle) | liste adı kesmeden gösterir; `addFiles` hata fırlatmaz |
| RF2 | iki farklı `fatura.pdf` (farklı içerik) | 2 satır, 2 farklı `fileId`, `pages.length` toplam sayfa sayısı |
| T26 | `pdfIsMemoryError` eşleştiricisi (spec §6, bellek satırı) | `'Out of memory'`, `'Array buffer allocation failed'`, `'Array buffer too large'` girdileri için `true`; `''`, `'Bir şey oldu'`, `null`, `undefined` için `false` |

T26 ve RF1/RF2 için `build-fixtures.mjs`'e `weird-name.pdf` (adı `Ahmet & Ayşe-test.pdf`) ve `fatura-a.pdf` / `fatura-b.pdf` (aynı dosya adı, farklı içerik) fixture'ları da ekle.

- [ ] **Adım 2: Testleri koşup başarısız olduğunu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs -g "T02|T03|T13|T14|T15|T16|T17|RF"`
Beklenen: 9 test FAIL.

- [ ] **Adım 3: `pdf-araclari.js` oluştur — Aşama 1 UI**

Dosya seçme butonu (`#pdf-file-input`, `accept="application/pdf"`, `multiple`), sürükle-bırak alanı (`#pdf-dropzone`, `dragover` sınıfı ile), dosya listesi (`#pdf-file-list`). Her satır: ad, `N sayfa`, boyut, "Kaldır" butonu.

- [ ] **Adım 4: `pdf-araclari.js` — `addFiles(fileList)`**

Sırayla: 50 MB kontrolü (aşım → `pdfShowError` ve bu dosyayı atla) → `await loadPdfLibs()` → `PDFLib.PDFDocument.load(bytes, {ignoreEncryption: false})` → `getPageCount() === 0` kontrolü → `pdfState.files.push(...)` → `pdfState.pages` için girdi başına `{uid, fileId, srcIndex, rotation: 0, thumbUrl: null, thumbError: false}` üret.

`uid`: `pdfState.files.length` + monoton artan sayaç birleşimi; dosya adına **bağlı değildir** (RF2). Tüm hatalar `catch` içinde yakalanır, ilgili dosya `error` alanıyla listeye yazılır, işlem diğer dosyalarla sürer (RF/T14). Toplam 150 MB kontrolü yükleme sonunda.

- [ ] **Adım 5: `pdfFormatBytes`, `pdfIsMemoryError`, `pdfShowError`, `pdfSetBusy`**

`pdfFormatBytes(n)`: `B`, `KB`, `MB` ondalıklı, gösterimde Türkçe ondalık ayırıcı `.` (ör. `12.4 MB` → `12,4 MB`).
`pdfIsMemoryError(message)`: `String(message)` içinde aşağıdakilerden biri geçiyorsa `true` — `'out of memory'`, `'array buffer allocation failed'`, `'array buffer too large'`, `'cannot allocate memory'`; **büyük/küçük harf duyarsız**. `null`/`undefined` girdide `false` döner, istisna atmaz.
`pdfShowError(fileName, message)`: dosya listesine kırmızı `Yüklenemedi` satırı + mesaj.
`pdfSetBusy(isBusy)`: `pdfState.busy` atar, `#pdf-form-block` içindeki tüm `button` ve `input` öğelerini `disabled` yapar, `pdfBus.emit('busy', isBusy)` yayınlar.

`addFiles` ve `pdfBuildOutput` içindeki genel `catch` blokları `pdfIsMemoryError(err.message)` kontrolüyle ayrışır: `true` ise mesaj tam olarak `Tarayıcı belleği tükendi. Daha küçük dosyalarla veya daha az sayfa seçerek deneyin.` olarak gösterilir, aksi halde spec §6 tablosundaki dosya-özel mesaj kullanılır. Genel `catch` sonunda mesaj `Çıktı üretilmedi, girdi dosyalarınız etkilenmedi.` ek cümlesiyle verilir.

- [ ] **Adım 6: Testleri koş**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs`
Beklenen: T01–T03, T13–T17, RF1, RF2, T20, T22 geçer.

- [ ] **Adım 7: Commit**

```bash
git add pdf-araclari.js index.html tests/fixtures/build-fixtures.mjs tests/pdf-araclari.spec.mjs
git commit -m "Add PDF file loading, state management, and upload error handling"
```

---

### Task 4: Küçük resim ızgarası, sıralama, döndürme, silme, geri alma

**Dosyalar:**
- Oluştur: `pdf-sayfalar.js`
- Değiştir: `index.html` (Aşama 2 HTML'i + CSS), `tests/pdf-araclari.spec.mjs`

**Tüketir:** `pdfState`, `pdfBus` (Task 2/3), `loadPdfLibs` (Task 2)

**Üretir:** `pdfRecordUndo`, `pdfUndo`, `pdfRotatePage`, `pdfDeletePage`, `pdfResetEdits`, `pdfRenderThumb`, `pdfBus.emit('pages')`

- [ ] **Adım 1: Geçen testleri yaz — T04, T05, T06, T18, T24**

| Test | Beklenen |
|---|---|
| T04 | `a.pdf` yükle, 1. kartın sil butonuna tıkla → kart sayısı 3 |
| T05 | `a.pdf` yükle, 1. kartı 3. konuma sürükle → `pdfState.pages.map(p => p.srcIndex)` `[2,0,1]` |
| T06 | `a.pdf` yükle, 1. kartı 1 kez döndür → `pdfState.pages[0].rotation === 90`; A4 kapalıyken indir → `readPageBoxes` ilk sayfa `rotation === 90` |
| T18 | 2 kez düzenle, "Geri Al" → ilk düzenleme öncesi sıra geri gelir; 20 kereden sonra "Geri Al" butonu `disabled` değil, 21. geri almada en eski kayıt düşer |
| T24 | 60 sayfalık fixture → 60 kart, düzenleme yapılabiliyor, indirme 60 sayfa üretir |

T24 için `build-fixtures.mjs`'e `sixty-pages.pdf` ekle.

- [ ] **Adım 2: Testleri koşup başarısız olduğunu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs -g "T04|T05|T06|T18|T24"`
Beklenen: 5 test FAIL.

- [ ] **Adım 3: `pdf-sayfalar.js` — küçük resim üretimi**

`pdfRenderThumb(entry)`: `loadScript('pdf.worker.min.js')` bir kez çağrılır (singleton bayrağı), `pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'`, `getDocument({data})` → `getPage(srcIndex+1)` → `getViewport({scale: 0.25})` → canvas → `toDataURL('image/jpeg', 0.7)` → `entry.thumbUrl`. Hata olursa `entry.thumbError = true`.

İlk 12 kart eşzamanlı; kalanlar `requestIdleCallback` ile (yoksa `setTimeout(fn, 0)`) sırayla. Aynı `fileId` için `getDocument` bir kez açılıp `pdfDocCache` içinde saklanır.

- [ ] **Adım 4: `pdf-sayfalar.js` — ızgara render'ı**

`pdfBus.on('pages', render)`. Her kart: `thumbUrl ? <img>` : `thumbError ? "Önizlenemedi"` : spinner. Altında `Sayfa N/M · dosya adı`. Sağ üstte `↻` ve `🗑` butonları. Kart `draggable="true"`, `dragstart`/`dragover`/`drop` ile yeniden sıralama; her düzenlemeden önce `pdfRecordUndo('Sıralama')`.

`pdfRecordUndo` yığını 20 ile sınırla (taşarsa `shift()`). Yalnızca `pages` dizisinin sığ kopyası saklanır, `thumbUrl` referansları korunur. `pdfUndo` yığın boşsa hiçbir şey yapmaz.

- [ ] **Adım 5: `pdfRotatePage`, `pdfDeletePage`, `pdfResetEdits`**

`pdfRotatePage(uid)`: `rotation = (rotation + 90) % 360`, `pdfRecordUndo('Döndürme')`.
`pdfDeletePage(uid)`: diziden çıkar, `pdfRecordUndo('Silme')`.
`pdfResetEdits`: tüm `rotation` → 0, `pages` kaynak sırasına göre sıralanır, `pdfRecordUndo('Sıfırlama')`, küçük resimler yeniden üretilmez.

- [ ] **Adım 6: Aşama 2 HTML/CSS'ini `index.html`'e ekle**

Izgara `grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))`. Tüm renkler mevcut CSS değişkenlerinden. Araç çubuğu: "Geri Al", "Tüm Sayfaları Döndür (90°)", "Döndürmeleri ve Sıralamayı Sıfırla".

- [ ] **Adım 7: Testleri koş**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs`
Beklenen: T01–T06, T13–T18, T20, T22, T24 geçer.

- [ ] **Adım 8: Commit**

```bash
git add pdf-sayfalar.js index.html tests/fixtures/build-fixtures.mjs tests/pdf-araclari.spec.mjs
git commit -m "Add page thumbnail grid with drag reorder, rotate, delete, undo"
```

---

### Task 5: Çıktı üretimi — birleştirme ve A4 normalize

**Dosyalar:**
- Oluştur: `pdf-cikti.js`
- Değiştir: `index.html` (Aşama 3 ve 4 HTML'i), `tests/pdf-araclari.spec.mjs`

**Tüketir:** `pdfState` (Task 3), `pdfRotatePage`/düzenleme sonucu (Task 4)

**Üretir:** `pdfBuildOutput`, `pdfPlaceOnA4`, `pdfBus.emit('result')`

- [ ] **Adım 1: Geçen testleri yaz — T05 (çıktı sırası), T07, T08, T03 (birleştirme) + Review Focus 3 ve 5**

| Test | Beklenen |
|---|---|
| T05b | `a+b` yükle, sürükle-bırak ile karıştır, indir → `extractAllText` sırası beklenen metin sırasıyla aynı |
| T07 | `mixed-sizes.pdf` yükle, "A4'e normalize et" açık, indir → `readPageBoxes` **her** sayfa `595.28 × 841.89` (±0.5) |
| T08 | `mixed-sizes.pdf` aynı → `extractAllText` kaynak metnin tamamını içerir (kırpma yok) |
| T03b | `a+b+c` indir → `readPageBoxes` uzunluğu 11 |
| RF3 | `a.pdf` yükle, "Döndürmeleri ve Sıralamayı Sıfırla" yerine 1. kartı sil, sonra aynı dosyayı ikinci kez ekle → 8 sayfa; 3. kopyayı 1. ve 2. kopyanın arasına sürükle, indir → 3 kopya var |
| RF5 | `mixed-sizes.pdf`'ın 2. sayfasını 90° döndür, A4 normalize açık, indir → 2. sayfa `595.28 × 841.89`, metin okunabilir, sayfa yatay/yön kontrolü ile merkezde |

- [ ] **Adım 2: Testleri koşup başarısız olduğunu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs -g "T05b|T07|T08|T03b|RF3|RF5"`
Beklenen: 6 test FAIL (`#pdf-build-btn` yok).

- [ ] **Adım 3: `pdf-cikti.js` — `pdfBuildOutput()`**

Sıra: `pdfSetBusy(true)` → yeni `PDFLib.PDFDocument.create()` → `pdfState.pages` sırasına göre her girdi için kaynak `doc`'tan `copyPages(doc, [srcIndex])` → `copy[0].setRotation(deg)` → `output.a4` ise `pdfPlaceOnA4(target, copy[0], rotation)` sonucu ekle, değilse `copy[0]` doğrudan ekle → `doc.setTitle(...)` → `doc.save({useObjectStreams: true})` → `{bytes, originalSize, outputSize}`.

`originalSize`: yüklü dosyaların bayt toplamı. `finally` içinde `pdfSetBusy(false)`.

- [ ] **Adım 4: `pdf-cikti.js` — `pdfPlaceOnA4(targetDoc, srcPage, rotation)`**

Döndürme **önce** uygulanmış sayfanın sınır kutusundan hesapla. `rot90 = rotation === 90 || rotation === 270`. Kaynak boyutlar: rot90 ise `{w: h, h: w}`, değilse `{w, h}` (MediaBox'ten; `srcPage.getSize()` çağrısı pdf-lib'de rotasyonu yansıtmaz, bu yüzden elle takas edilir). `scale = min(595.28/w, 841.89/h)`. Hedef `targetDoc.addPage([595.28, 841.89])`. `srcPage.draw` veya hedefe `embedPages` ile `drawPage` çağrısı: `targetPage.drawPage(srcPage, {x: (595.28 - w*scale)/2, y: (841.89 - h*scale)/2, width: w*scale, height: h*scale})`.

Kaynak zaten A4 ve rotasyon 0 isa `targetDoc.addPage(srcPage)` ile doğrudan aktar (gereksiz ölçekleme yapma).

- [ ] **Adım 5: Aşama 3 ve 4 UI'ını ekle**

`#pdf-opt-a4` (varsayılan `checked`), `#pdf-opt-compress`, `#pdf-opt-quality` (`0.5` / `0.7` / `0.85`, varsayılan `0.7`), `#pdf-opt-lossy`. `#pdf-build-btn` "PDF Oluştur ve İndir". İlerleme çubuğu `#pdf-progress` + `Sayfa N/M` metni. Sonuç kutusu `#pdf-result`.

- [ ] **Adım 6: Testleri koş**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs`
Beklenen: T01–T08, T13–T18, T20, T22, T24 geçer.

- [ ] **Adım 7: Commit**

```bash
git add pdf-cikti.js index.html tests/pdf-araclari.spec.mjs
git commit -m "Add PDF output build with merge and A4 normalization"
```

---

### Task 6: Sıkıştırma mod 1 — gömülü görselleri yeniden kodlama

**Dosyalar:**
- Değiştir: `pdf-cikti.js`, `tests/pdf-araclari.spec.mjs`

**Tüketir:** `pdfBuildOutput` (Task 5), Global Constraints'teki atlama kuralları

**Üretir:** `pdfCompressImages(doc, quality) => Promise<number>` (değiştirilen görsel sayısı)

- [ ] **Adım 1: Geçen testleri yaz — T09, T10 + Review Focus 4**

| Test | Beklenen |
|---|---|
| T09 | `text-only.pdf` + sıkıştırma açık → işlem biter, `extractAllText` kaynak metni içerir, `#pdf-result` içinde `sıkıştırılacak büyük görsel bulunamadı` uyarısı var |
| T10 | `scanned.pdf` + sıkıştırma açık, kalite 0.7 → `outputSize < originalSize * 0.5`, `extractAllText` kaynak metni içerir |
| RF4 | Görseli Form XObject içine gömülü fixture (`nested-image.pdf`) + sıkıştırma → çıktı üretilir, `readImageCount` çıktıda ≥ 1, `#pdf-result` boyut karşılaştırmasını **dürüst** gösterir (yanlış başarı iddiası yok) |

`build-fixtures.mjs`'e `nested-image.pdf` ekle: bir Form XObject içine gömülü görsel içeren sayfa.

- [ ] **Adım 2: Testleri koşup başarısız olduğunu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs -g "T09|T10|RF4"`
Beklenen: 3 test FAIL (sıkıştırma UI'ı yok).

- [ ] **Adım 3: `pdfCompressImages(doc, quality)` yaz**

Doğrulanmış pdf-lib 1.17.1 API'si (gerçekten çalıştırılarak teyit edildi):

```js
const { PDFName, PDFDict } = PDFLib;
for (const page of doc.getPages()) {
  const xoDict = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xoDict) continue;
  for (const [key] of xoDict.entries()) {
    const xobj = xoDict.lookup(key);          // PDFRef -> PDFRawStream çözümler
    if (xobj.constructor.name !== 'PDFRawStream') continue;
    // ... koşul denetimleri, aşağıda ...
    xobj.contents = jpegBytes;                  // Uint8Array, yerinde değiştirir
    xobj.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    xobj.dict.delete(PDFName.of('DecodeParms'));
    xobj.dict.delete(PDFName.of('SMask'));
  }
}
```

Notlar (hepsi deneyimle doğrulandı):
- `page.node.Resources` bir **özellik değil metottur**: `page.node.Resources()`
- `Resources` içindeki `/XObject` değeri bir `PDFRef`'tir; nesneye çözmek için `lookupMaybe(PDFName.of('XObject'), PDFDict)` ve sonra `lookup(key)` gerekir
- `PDFRawStream.of` imzası **`(dict, contents)`** sırasındadır, tersi değil; `dict` düz nesne değil `doc.context.obj({...})` olmalıdır
- `xobj.contents` doğrudan atanabilir ve `save()` sırasında serileştirilir; yeni `PDFRef` kaydı gerekmez
- `doc.save()` → `PDFDocument.load()` round-trip'i bu değişikliği bozmadan taşır

Koşul denetimleri, hepsi sağlanmazsa `continue`: `Subtype === Image`, `BitsPerComponent === 8`, `ColorSpace` `DeviceRGB` veya `DeviceGray`, `SMask` yok, `Filter` `DCTDecode` değil, çözülmüş boyut > 20 KB.

Yeniden kodlama: `xobj.contents` içeriğini `pako`/`DecompressionStream('deflate')` ile çöz, `Width`/`Height`/`ColorSpace` ile `ImageData` üret, `OffscreenCanvas` (yoksa `document.createElement('canvas')`) üzerinden `convertToBlob({type: 'image/jpeg', quality})`, sonucu `new Uint8Array(await blob.arrayBuffer())` olarak `xobj.contents`'a yaz.

`Blob` dönüşümü `await` edildiği için fonksiyon async. Dönüş: değiştirilen görsel sayısı.

- [ ] **Adım 4: `pdfBuildOutput` içine mod 1'i bağla**

`output.compress && !output.lossy` ise `await pdfCompressImages(doc, output.quality)` çağrı, sonuç sayısı `#pdf-result` mesajına yazılır.

- [ ] **Adım 5: `#pdf-result` dürüstlük kuralını uygula**

`outputSize >= originalSize` ise mesaj tam olarak: `Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.`
Aksi halde: `Orijinal X MB → Çıktı Y MB (%N küçüldü)`, `N = Math.round((1 - outputSize/originalSize) * 100)`.

- [ ] **Adım 6: Testleri koş**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs`
Beklenen: T01–T10, T13–T18, T20, T22, T24 geçer.

- [ ] **Adım 7: Commit**

```bash
git add pdf-cikti.js tests/fixtures/build-fixtures.mjs tests/pdf-araclari.spec.mjs
git commit -m "Add image re-encoding compression preserving selectable text"
```

---

### Task 7: Sıkıştırma mod 2 — görsele çevirme ve onay modalı

**Dosyalar:**
- Değiştir: `pdf-cikti.js`, `index.html` (modal HTML/CSS), `tests/pdf-araclari.spec.mjs`

**Tüketir:** `pdfRenderThumb` altyapısı/pdf.js kurulumu (Task 4), `pdfState.output` (Task 3)

**Üretir:** `pdfRasterize(srcDoc, rotationList, quality) => Promise<Uint8Array>`

- [ ] **Adım 1: Geçen testleri yaz — T11, T12**

| Test | Beklenen |
|---|---|
| T11 | `scanned.pdf` + sıkıştırma + `lossy` işaretli → modal çıkar; "Vazgeç" tıklanır → **dosya indirilmez** (`page.on('download')` tetiklenmedi), `pdfState.busy === false` |
| T12 | Aynı akış, "Görsele Çevir ve İndir" → `outputSize < originalSize * 0.2`, `extractAllText` **boş string** |

- [ ] **Adım 2: Testleri koşup başarısız olduğunu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs -g "T11|T12"`
Beklenen: 2 test FAIL.

- [ ] **Adım 3: `index.html`'e onay modalını ekle**

`#pdf-lossy-modal`, spec 5.2'deki uyarı metniyle birebir. İki buton: "Vazgeç" (`#pdf-lossy-cancel`, modalı kapatır) ve "Görsele Çevir ve İndir" (`#pdf-lossy-confirm`). `no-print` sınıflı, `role="dialog"`, `aria-modal="true"`.

- [ ] **Adım 4: `pdfRasterize` yaz**

`pdfjsLib.getDocument({data: bytes})` → her sayfa için `getPage(i+1)`, `getViewport({scale: 150/72})` (150 DPI) → canvas → `convertToBlob({type: 'image/jpeg', quality})` → `PDFLib.PDFDocument.create()` → `addPage([595.28, 841.89])` → `embedJpg` → tam sayfa `drawImage`. Döndürme pdf.js tarafında `getPage(i).rotate = rotations[i]` atanarak uygulanır. Sonuç `save()` baytları.

- [ ] **Adım 5: `pdfBuildOutput`'a mod 2'yi bağla**

`output.lossy` ise `pdfBuildOutput` çıktı kurulumunu atlar, doğrudan `pdfRasterize(...)` çağırır ve dönen baytları kullanır. `output.a4` mod 2'de zorunludur (görsel zaten A4'e çizilir); `output.a4` kapalıysa uyarı göster ve mod 2'yi reddet.

- [ ] **Adım 6: Testleri koş**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs`
Beklenen: T01–T18, T20, T22, T24 geçer.

- [ ] **Adım 7: Commit**

```bash
git add pdf-cikti.js index.html tests/pdf-araclari.spec.mjs
git commit -m "Add lossy rasterize mode with confirmation modal"
```

---

### Task 8: Tema, duyarlılık ve regresyon taraması

**Dosyalar:**
- Değiştir: `index.html` (CSS), `tests/pdf-araclari.spec.mjs`

**Tüketir:** Task 2–7'nin tümü

**Üretir:** T19, T21, T23

- [ ] **Adım 1: Geçen testleri yaz — T19, T21, T23**

| Test | Beklenen |
|---|---|
| T19 | 5 mevcut sekmenin tamamı: sekmeye tıkla, birkaç alan doldur, `#printable-area` içeriğinin değiştiğini doğrula; `handlePrint()` çağrılınca `window.print` stub'ı çağrılır |
| T21 | `data-theme="dark"` altında PDF paneli: `getComputedStyle` ile arka plan `rgb(13, 17, 23)` (`--background` koyu değeri) ile eşleşir, metin rengi arka planla karışmaz |
| T23 | `390 × 844` viewport'ta `document.documentElement.scrollWidth <= 390` |

- [ ] **Adım 2: Testleri koşup durumu doğrula**

Koşu: `npx playwright test tests/pdf-araclari.spec.mjs -g "T19|T21|T23"`
Beklenen: T19 geçer (regresyon yok), T21 ve T23 geçer ya da CSS düzeltmesi gerektiğini gösterir. Çıkan her kırmızı test için `index.html` CSS'ini düzelt ve yeniden koş.

- [ ] **Adım 3: Gerekli CSS düzeltmelerini yap**

Yeni CSS değişkeni **tanımlama**. Karanlık modda düşük kontrastlı kalan öğeleri mevcut değişkenlerle eşle. 390 px'te ızgara tek sütuna düşsün, `.tab-container` yatay kaydırılabilir kalsın.

- [ ] **Adım 4: Tam test paketini koş**

Koşu: `npx playwright test`
Beklenen: T01–T24 + fixture testlerinin tamamı geçer, 0 hata.

- [ ] **Adım 5: Commit**

```bash
git add index.html tests/pdf-araclari.spec.mjs
git commit -m "Fix dark theme contrast and mobile layout for PDF tools panel"
```

---

### Task 9: README, tam doğrulama ve canlıya alma

**Dosyalar:**
- Değiştir: `README.md`

**Tüketir:** Task 1–8

- [ ] **Adım 1: `README.md`'yi güncelle**

"Özellikler" listesine PDF Araçları maddesi; kullanım bölümüne "Çoklu PDF birleştirme, sayfa düzenleme, A4'e sığdırma ve boyut küçültme için **PDF Araçları** sekmesini kullanın" cümlesi; "Geliştirici" başlığı altında `npm install && npx playwright install chromium && npm test` ve `npm run sync-libs` talimatları. `%100 Çevrimdışı` ve KVKK vurgusu korunur (PDF işlemleri de tamamen tarayıcıda olduğu için bu vaat artık PDF aracı için de geçerlidir).

- [ ] **Adım 2: Sıfırdan tam doğrulama koşusu**

```bash
rm -rf node_modules tests/fixtures/*.pdf
npm install && npx playwright install chromium
npm run sync-libs && npm test
```
Beklenen: fixture'lar yeniden üretilir, tüm testler geçer. Bu, ortam durumuna değil depoya bağlı olduğunu kanıtlar.

- [ ] **Adım 3: `file://` elle doğrulama**

`open index.html` ile aç → 6 sekme görünür → PDF Araçları sekmesi tıklanır → kütüphaneler yüklenir → `a.pdf` yüklenir → küçük resimler çıkar → bir sayfa silinir, bir sayfa döndürülür → A4 normalize + sıkıştırma ile indirilir → dosya geçerli bir PDF olarak açılır. Konsolda hata yok.

- [ ] **Adım 4: Dosya listesi ve boyut kontrolü**

```bash
git status --short
ls -la pdf-lib.min.js pdf.min.js pdf.worker.min.js
```
Beklenen: yalnızca planlanan dosyalar; `node_modules`, `tests/fixtures/*.pdf`, `test-results/` temizlenmiş veya `.gitignore`'da.

- [ ] **Adım 5: Commit ve push**

```bash
git add README.md .gitignore
git commit -m "Document PDF Araclari sekmesi and developer test commands"
git push origin main
```
Beklenen: push başarılı. ~1 dakika sonra `https://mertatis.github.io/avmertatis-kira-sozlesmesi-olusturucu/` güncellenir.

- [ ] **Adım 6: Canlı doğrulama raporu**

Yayımdan sonra tarayıcıda `Cmd+Shift+R` ile aç, 6 sekmenin ve PDF aracının çalıştığını doğrula. Doğrulanamayan üç kalemi rapora yaz: (1) GitHub Pages CDN önbelleği, (2) 100+ sayfalık gerçek belge bellek gözlemi, (3) iOS Safari dosya seçici davranışı.
