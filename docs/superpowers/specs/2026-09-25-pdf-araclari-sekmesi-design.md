# PDF Araçları Sekmesi — Tasarım Dokümanı

**Tarih:** 2026-09-25
**Durum:** Onaylandı
**Kapsam:** Mevcut tek dosyalık `index.html` uygulamasına 6. sekme (`PDF Araçları`) eklenmesi.

---

## 1. Amaç ve Kapsam

Hukuki belge üreten mevcut uygulamaya, tarayıcı üzerinde tamamen çalışan bir PDF aracı seti eklemek. Kullanıcı PDF dosyalarını birleştirebilecek, sayfaları silebilecek/sıralayabilecek/döndürebilecek, tüm çıktıyı A4'e normalize edebilecek ve dosya boyutunu küçültebilecek.

### Yapılacaklar

| # | Yetenek |
|---|---|
| 1 | Birden fazla PDF yükleyip tek dosyada birleştirme |
| 2 | Sayfa silme |
| 3 | Sürükle-bırak ile sayfa sıralama |
| 4 | Sayfa döndürme (90° / 180° / 270°) |
| 5 | Her sayfayı kırpma olmadan A4'e ölçekleyip ortalamak |
| 6 | Gömülü görselleri yeniden kodlayarak boyut küçültme (metin seçilebilir kalır) |
| 7 | Sayfayı görsele çevirerek agresif küçültme (ölçülen %64; metin seçilemez — açık uyarıyla) |
| 8 | Küçük resimli ızgara ile görsel önizleme |

### Yapılmayacaklar (kapsam dışı)

- Var olan PDF metnini düzenleme (teknik olarak kırılgan, kapsam dışı)
- PDF parola çözme / koruma kaldırma (yasal risk, kapsam dışı)
- OCR ile taranmış belgeyi aranabilir metne çevirme
- Form alanları (AcroForm) doldurma
- Dijital imza ekleme veya doğrulama
- Sunucu tarafı işleme (backend yok)

### Değişmeyenler

- Mevcut 5 sekme ve `switchTab()` davranışı
- `renderPreview()` ve `handlePrint()` akışı
- `%100 çevrimdışı` ve KVKK uyumlu konumlandırma
- `file://` üzerinden çift tıklayarak açılabilme
- Tek dosya dağıtım modeli (`index.html` + yan kütüphane dosyaları)

---

## 2. Mimari

### 2.1 Yeni dosyalar

| Dosya | Kütüphane | Sürüm | Yaklaşık Boyut | Rol |
|---|---|---|---|---|
| `pdf-lib.min.js` | pdf-lib | 1.17.1 (UMD) | ~380 KB | Sayfa kopyalama, silme, sıralama, döndürme, A4 kurulumu, kaydetme |
| `pdf.min.js` | pdf.js | 3.11.174 (UMD) | ~330 KB | Küçük resim render, metin çıkarma (testler) |
| `pdf.worker.min.js` | pdf.js | 3.11.174 | ~1 MB | pdf.js worker, lazy yüklenir |

Dosyalar depo köküne (`kira-sozlesmesi-olusturucu/`) yerleştirilir. GitHub Pages bunları site kökünde servis eder.

### 2.2 Sürüm kararı: neden pdf.js 3.11.174

README'nin ana kullanım vaadi *"index.html dosyasına çift tıklayarak herhangi bir web tarayıcısında açın"*. `file://` protokolünde `<script type="module">` CORS kuralları gereği engellenir. pdf.js 4.x ve üzeri yalnızca ESM modülü olarak yayınlanır. Bu nedenle UMD derlemesi sunan **son sürüm olan 3.11.174** kullanılacaktır.

pdf.js 4.x/5.x kullanılırsa `file://` ile açma bozulur ve README'deki kullanım talimatı geçersizleşir.

### 2.3 `file://` uyumu

pdf.js worker'ı `file://` altında oluşturamaz. pdf.js bu durumda otomatik olarak **fake worker** moduna düşer: worker kodu ana thread üzerinde çalıştırılır. Bu yavaştır ancak işlevseldir. `http(s)://` altında (github.io, yerel sunucu) gerçek worker devreye girer.

Bu davranış kütüphane tarafından yönetilir; uygulama kodunda müdahale gerekmez.

### 2.4 Content Security Policy değişikliği

`index.html` 6. satırdaki `<meta http-equiv="Content-Security-Policy">` içeriğine **tek** yönerge eklenir:

```
worker-src 'self' blob:;
```

Gerekçeler ve diğer yönergelerin değişmeme sebebi:

- `script-src 'self' 'unsafe-inline'` → yan dosyalar (`pdf-lib.min.js`, `pdf.min.js`) zaten `'self'` kapsamında. Değişiklik gerekmez.
- `worker-src` → pdf.js gerçek worker'ı `new Worker(URL.createObjectURL(blob))` ile oluşturur. `blob:` izni olmadan engellenir.
- `connect-src` → worker yüklemesi `fetch`/XHR değildir; `script-src` ve `worker-src` kapsamındadır. Değişiklik gerekmez.
- `img-src 'self' data: https:` → küçük resimler `data:` URL olarak üretilir. İzni zaten var.
- `default-src 'self'` → yeni kaynak türü tanımlanmadığı için etkilenmez.

### 2.5 Yükleme stratejisi

Kütüphaneler `index.html` içine statik `<script>` etiketi olarak **eklenmez**. Bunun yerine `PDF_ARACLARI` adlı bir global yükleme fonksiyonu, `<script>` etiketini çalışma anında DOM'a enjekte eder:

```js
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Yükleme hatası: ' + src));
        document.head.appendChild(s);
    });
}

async function loadPdfLibs() {
    if (pdfState.libsLoaded) return;
    await loadScript('pdf-lib.min.js');
    await loadScript('pdf.min.js');
    pdfState.libsLoaded = true;
}
```

Gerekçe: `pdf-lib.min.js` + `pdf.min.js` birlikte ~710 KB'dır. Statik `defer` etiketleri sayfa yüklenirken indirilirdi; PDF aracını hiç kullanmayan ziyaretçiler için boşa maliyet. Dinamik enjeksiyon, kütüphaneyi yalnızca ilk gerçek kullanımda indirir. Bu ayrıca `file://` altında da çalışır (aynı dizinden göreli yol).

`loadPdfLibs()` şu anda tetiklenir:

- `switchTab('pdf-araclari')` çağrıldığında (arka planda, sessizce)
- "Dosya Seç" / sürükle-bırak ile dosya eklenmeden hemen önce (kullanıcı beklemesin diye)

Yükleme sırasında PDF panelinin tüm etkileşimli öğeleri `disabled` olur ve "Araçlar yükleniyor..." yazılı bir spinner gösterilir. Yükleme başarısız olursa (ağ kesintisi, eksik dosya) kullanıcıya net hata gösterilir ve "Tekrar Dene" butonu sunulur.

`pdf.worker.min.js` statik `<script>` olarak **eklenmez**; yalnızca ilk küçük resim üretilirken `loadScript('pdf.worker.min.js')` ile indirilir, ardından `pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'` atanır.

### 2.6 Kod organizasyonu

Yeni JavaScript, mevcut `<script>` bloğunun sonuna eklenen ayrı bir `<script>` bloğunda tutulur. Değişken adları `pdf` önekiyle ayrılır (`pdfState`, `pdfFiles`, `pdfPages`, `pdfRender`, ...) ve mevcut global isimlerle (`currentTab`, `renderPreview`, `toggleTheme`, `handlePrint`) çakışmaz.

Mevcut `switchTab()` fonksiyonu 6. sekme için genişletilir; ayrı bir yönlendirme mekanizması kurulmaz.

---

## 3. Kullanıcı Arayüzü

### 3.1 Sekme

`tab-container` içine 6. buton eklenir:

```html
<button class="tab-btn" id="tab-pdf-araclari" onclick="switchTab('pdf-araclari')">
    <i class="fa-solid fa-wrench"></i> PDF Araçları
</button>
```

`switchTab('pdf-araclari')` çağrıldığında `pdf-form-block` gösterilir, `renderPreview()` PDF sekmesinde `printable-area` içine uyarı metni basar (bu sekmede belge üretilmez).

`#pdf-araclari-form-block` ve tab butonu `no-print` sınıfını taşır; Yazdır/PDF İndir sırasında gizlenir.

### 3.2 Panel yapısı

Tek kart paneli, içinde 4 dikey aşama:

**Aşama 1 — Dosyalar**

- Sürükle-bırak alanı (`dragover` durumunda vurgulu kenarlık)
- "Dosya Seç" butonu (`<input type="file" accept="application/pdf" multiple>`)
- Yüklenen dosya listesi: her satırda dosya adı, sayfa sayısı, dosya boyutu, "Kaldır" butonu
- Çoklu dosya tek seferde de eklenebilir; aynı dosya iki kez eklenirse sayfaları iki kez gelir (kasıtlı)

**Aşama 2 — Sayfalar**

- Küçük resimli ızgara (`grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))`)
- Her kart: küçük resim (`<img>`), altında `Sayfa 3/8 · Kira Sözleşmesi.pdf`, sağ üstte döndür (↻) ve sil (🗑) butonları
- Kartlar HTML5 sürükle-bırak ile sıralanır
- Üstte araç çubuğu: "Geri Al", "Tüm Sayfaları Döndür (90°)", "Döndürmeleri ve Sıralamayı Sıfırla"
  - "Döndürmeleri ve Sıralamayı Sıfırla" yalnızca mevcut dosya listesini etkiler; yüklenmiş dosyaları silmez, küçük resimleri yeniden üretmez. Bu buton da geri alınabilir bir düzenlemedir.
- Boş durum: "Henüz dosya eklenmedi" yönlendirmesi

**Aşama 3 — Çıktı**

- Onay kutusu: `A4'e normalize et` — **varsayılan açık**
- Onay kutusu: `Boyutu küçült` — varsayılan kapalı
  - Açıksa görünür olan seçim: `Kalite: Düşük (0.5) / Orta (0.7) / Yüksek (0.85)` (varsayılan Orta)
  - Onay kutusu: `⚠ Metin seçilemez olsun (sayfaları görsele çevir)` — varsayılan kapalı; işaretlenirse onay modalı çıkar

**Aşama 4 — İndir**

- "PDF Oluştur ve İndir" birincil butonu
- İşlem sırasında ilerleme çubuğu ve `Sayfa 12/48` metni
- Bittiğinde sonuç kutusu: `Orijinal 12,4 MB → Çıktı 2,1 MB (%83 küçüldü)` veya küçülme olmadıysa dürüst uyarı

### 3.3 A4 normalize davranışı

- A4 ölçüsü: 595.28 × 841.89 pt (72 dpi, PostScript punto)
- Her kaynak sayfanın `MediaBox` okunur
- İçerik **kırpılmaz, ölçeklenir** ve sayfa merkezine hizalanır
- Ölçek = `min(595.28/kaynakGenişlik, 841.89/kaynakYükseklik)`
- Küçük sayfalar (A5, A6) büyütülür, böylece baskıda okunur olur
- Orijinal kenar boşluğu korunur; ek boşluk eklenmez
- Sayfa zaten tam A4 ve döndürme 0 ise doğrudan kopyalanır (gerekçesiz işlem yapılmaz)

### 3.4 Duyarlılık ve tema

- 390 px genişlikte ızgara tek sütuna düşer; yatay kaydırma oluşmaz
- Tüm renkler mevcut CSS değişkenlerini (`--card`, `--border`, `--primary` ...) kullanır; `[data-theme="dark"]` altında otomatik uyum sağlar
- Yeni arayüz öğeleri için yeni renk değişkeni tanımlanmaz

---

## 4. Durum Modeli

```js
const pdfState = {
  files: [],   // {id, name, bytes, doc, pageCount}
  pages: [],   // {uid, fileId, srcIndex, rotation, thumbUrl, thumbError}
  output: { a4: true, compress: false, quality: 0.7, lossy: false },
  undoStack: [],  // {pages: [...], label: string} — en fazla 20 kayıt
  busy: false,
  libsLoaded: false
};
```

### 4.1 Neden referans tabanlı

Sayfa nesneleri yüklenirken kopyalanmaz. `pages` dizisinde yalnızca `{fileId, srcIndex, rotation}` tutulur. Çıktı yalnızca "İndir" anında sıfırdan kurulur.

Kazançları:

- Sıralama, silme ve döndürme anında tamamlanır (pahalı iş yok)
- 300 sayfalık belgede düzenleme akıcı kalır
- Hatalı düzenleme geri alınabilir
- Aynı kaynak sayfa birden çok kez çıktıya eklenebilir

### 4.2 Çıktı kurulumu

```
1. Yeni PDFDocument oluştur
2. Her sayfa girdisi için:
   a. copyPages(kaynakDoc, [srcIndex])
   b. Rotasyon uygula (0/90/180/270)
   c. a4 açıksa: ölçekli A4 sayfası oluştur, kopyalanan sayfayı ortalanmış çiz
      değilse: kopyalanan sayfayı doğrudan ekle
3. compress açıksa: bölüm 5'teki algoritma
4. useObjectStreams(true) — pdf-lib varsayılanı
5. save() → Blob → indirme
```

### 4.3 Geri alma

Her düzenleme (sil / sırala / döndür) öncesinde `pages` dizisinin sığ kopyası `undoStack`'e itilir. Yığın en fazla 20 kayıt tutar; taşarsa en eski atılır. "Geri Al" butonu yığında kayıt yoksa `disabled` olur. Küçük resim `thumbUrl` değerleri kopyalanmaz (aynı referans kullanılır), yalnızca sayfa dizisi geri alınır.

### 4.4 Küçük resim üretimi

- pdf.js ile `page.getViewport({scale: 0.25})` → `canvas` → `toDataURL('image/jpeg', 0.7)`
- `toDataURL` sonucu `thumbUrl` olarak saklanır
- İlk 12 küçük resim dosya yüklendiğinde hemen üretilir; kalanlar `requestIdleCallback` ile arka planda. `requestIdleCallback` desteklenmiyorsa `setTimeout(fn, 0)` kullanılır.
- Üretilemeyen sayfa (bozuk içerik) `thumbError: true` işaretlenir ve kartta "Önizlenemedi" placeholder gösterilir; işlem akışı durmaz.
- Sayfa silindiğinde o sayfaya ait `thumbUrl` serbest bırakılır (`thumbUrl` bir data URL'dir, `URL.revokeObjectURL` gerekmez).

---

## 5. Sıkıştırma Motoru

İki mod bulunur. Kullanıcı mod seçmez; mod, "Metin seçilemez olsun" onay kutusu tarafından belirlenir.

### 5.1 Mod 1 — Kaliteli sıkıştırma (varsayılan, metin korur)

Sayfa içerik akışı ve yazı tipleri olduğu gibi kopyalanır; **yalnızca gömülü görseller yeniden kodlanır.** Metin seçilebilir ve aranabilir kalır.

Algoritma:

1. Sayfanın `Resources.XObject` sözlüğündeki her XObject incelenir
2. `/Subtype` `/Image` olanlar hedeflenir
3. Aşağıdaki koşulların **hepsi** sağlanmalıdır:
   - `/BitsPerComponent` 8
   - `/ColorSpace` `DeviceRGB` veya `DeviceGray`
   - `/SMask` **yok** (şeffaflık varsa atlanır, alfa bozulmasın)
   - `/Filter` `FlateDecode` veya `/Length` düz `null` (ham)
   - Çözülmüş boyutu 20 KB'ın üzerinde (küçük görsellerde kazanç yok, risk var)
4. Sıfır filtreli (DCTDecode / JPEG) görseller **atlanır** — zaten sıkıştırılmış, tekrar kodlamak yalnızca kaliteyi düşürür
5. Uygun görseller canvas üzerinden `image/jpeg` olarak `quality` seviyesinde yeniden kodlanır
6. Orijinal XObject sözlük girdisi, yeni `PDFRawStream` ile değiştirilir

Beklenen kazanç: taranmış/sayfa görüntülü belgelerde %50–80. Metin ağırlıklı belgelerde değişim ihmal edilebilir.

### 5.2 Mod 2 — Görsele çevirme (agresif, metin kaybolur)

1. Her sayfa pdf.js ile 150 DPI çözünürlükte canvas'a render edilir
2. Canvas `image/jpeg` (`quality` seviyesinde) olarak blob'a çevrilir
3. pdf-lib'de tam sayfa A4 oluşturulur, görsel kenardan kenara çizilir

Beklenen kazanç: ölçülen değer **%64** (9.81 MB sentetik gürültülü tarama → 3.53 MB, 150 DPI, kalite 0.7). Gerçek taranmış sözleşmelerde oran daha yüksek olur; gürültülü sentetik içerik en kötü durumdur. Sonuçta metin seçilemez, arama yapılamaz, kopyalama yapılamaz.

Kullanıcı onayı: bu onay kutusu işaretlendiğinde, işlem başlamadan önce şu uyarı modalı gösterilir ve "Görsele Çevir ve İndir" onayı istenir:

> Sayfalar görsele çevirilecek. **Metin seçilemez, aranamaz ve kopyalanamaz hale gelecektir.** Hukuki belge ve sözleşmelerde bu durum çoğu zaman kabul edilemez. Yalnızca e-posta ekine koyulacak nihai kopyalar için önerilir.

### 5.3 Dürüst geri bildirim

Sıkıştırma sonrası çıktı boyutu, girdi boyutundan büyük veya eşitse kullanıcıya şu mesaj gösterilir:

> Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.

Sayfa başına kazanılan bayt sayacı değil, yalnızca toplam boyut karşılaştırması kullanıcıya gösterilir; teknik iç detaylar arayüzde gösterilmez.

---

## 6. Hata Yönetimi

| Durum | Tespit yöntemi | Kullanıcıya gösterilen mesaj |
|---|---|---|
| Şifreli PDF | `pdf-lib` `EncryptedPDFError` fırlatır | "Bu PDF şifreli. PDF'yi bir PDF okuyucuda açıp **Yazdır → PDF olarak kaydet** ile şifresiz kopyasını alıp tekrar deneyin." Parola kırma **desteklenmiyor**. |
| Geçersiz / bozuk dosya | Yükleme veya `copyPages` hatası | "«{dosya adı}» geçerli bir PDF değil veya bozuk." |
| 0 sayfalı PDF | `doc.getPageCount() === 0` | "«{dosya adı}» içinde sayfa bulunamadı." |
| 50 MB üzeri tek dosya | Yüklemeden önce boyut kontrolü | "«{dosya adı}» {X} MB. Tarayıcı belleği sınırı nedeniyle 50 MB üzeri dosyalar işlenemez. Dosyayı bölebilir ya da önce sıkıştırabilirsiniz." |
| Toplam 150 MB üzeri | Yükleme sonrası toplam kontrolü | "Yüklenen dosyaların toplamı {X} MB. Bellek sınırı nedeniyle işlem yapılamaz." |
| Bellek tükenmesi | `catch` bloğunda `"Array buffer allocation failed"`, `"Out of memory"` ve benzeri mesajlar eşleştirilir | "Tarayıcı belleği tükendi. Daha küçük dosyalarla veya daha az sayfa seçerek deneyin." |
| Küçük resim render hatası | `page.render()` hata fırlatır | Yalnızca o kartta "Önizlenemedi"; akış devam eder |
| Kütüphane yüklenemedi | `loadScript` `onerror` | "PDF araçları bileşenleri yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin." + "Tekrar Dene" butonu |
| İndirme engellendi | Blob indirme tetiklemesi | "İndirme başlatılamadı. Tarayıcınız indirmeleri engelliyor olabilir." |
| İşlem sırasında hata | Genel `catch` | Hata mesajı + "Çıktı üretilmedi, girdi dosyalarınız etkilenmedi." |

### 6.1 Uygulama bütünlüğü kuralları

- `switchTab` ve PDF bloğu arasındaki hata aktarımı yoktur; PDF hatası diğer sekmeleri etkilemez
- `pdfState.busy` sırasında tüm PDF paneli butonları `disabled` olur (çift tıklama ve yarış koşulu koruması)
- `busy` değeri her zaman `try/finally` içinde sıfırlanır; hata olsa da arayüz kilitlenmez
- Kısmi hatalı yüklemede (5 dosyadan 2'si bozuk) başarılı 3 dosya yüklenmeye devam eder, hatalar dosya listesinde kırmızı "Yüklenemedi" satırı olarak listelenir
- Konsola `console.error` yazılır (hata ayıklama), ancak konsolda hiçbir dosya içeriği yazdırılmaz (KVKK)

---

## 7. Doğrulama Planı

Hedef: uygulama teslim edildiğinde kullanıcının elle kontrol etmesi gereken hiçbir şey kalmaması.

### 7.0 Test araç zinciri

Testler için `package.json` **yalnızca geliştirme bağımlılıkları** içerir. Bunlar uygulamanın çalışma zamanına hiç girmez; tarayıcıdaki kütüphaneler depoya elle eklenen dosyalardır.

| Paket | Sürüm | Kullanım |
|---|---|---|
| `pdf-lib` | 1.17.1 | Fixture üretimi, çıktı doğrulama (MediaBox, `/Rotate`, metin) |
| `pdfjs-dist` | 3.11.174 | Çıktı PDF'lerinden metin okuma (`getTextContent`) |
| `playwright` | 1.63.0 | Chromium ile uçtan uca test |

Kurulum: `npm install && npx playwright install chromium`
Çalıştırma: `npm test` → `npx playwright test`

Kütüphane dosyaları (`pdf-lib.min.js`, `pdf.min.js`, `pdf.worker.min.js`) `node_modules` üzerinden kopyalanır, böylece sürümler `package.json` ile senkron kalır ve elle güncellenmez.

### 7.1 Test verisi üretimi

`tests/fixtures/build-fixtures.mjs` (Node + pdf-lib, harici bağımlılıksız) çalıştırılarak üretilir. Üretilen dosyalar `tests/fixtures/` altına yazılır ve `.gitignore` ile depoya girmez; test betiği eksikse kendisi üretir (`node tests/fixtures/build-fixtures.mjs`).

| Fixture | Üretim yöntemi | Amacı |
|---|---|---|
| `text-only.pdf` | pdf-lib, 3 sayfa Türkçe metin, görsel yok | Sıkıştırmanın dürüst uyarı vermesini test etmek |
| `scanned.pdf` | pdf-lib, 5 sayfa × 2 MB **FlateDecode ham RGB** bitmap | Sıkıştırma kazancını test etmek |
| `mixed-sizes.pdf` | pdf-lib, 3 sayfa: A4 (595.28×841.89), A5, Letter MediaBox | A4 normalize + kırpma yok testi |
| `rotate-me.pdf` | pdf-lib, 3 sayfa, hepsi 0° | Döndürme testi |
| `a.pdf` (4 sy) + `b.pdf` (3 sy) + `c.pdf` (4 sy) | pdf-lib, her sayfada ayırt edici metin | Birleştirme ve sıralama testi |
| `encrypted.pdf` | Elle yazılmış standart güvenlik işleyicisi (aşağıda) | Hata yönetimi |
| `corrupt.pdf` | Geçerli PDF'in gövdesi rastgele baytlarla bozulur | Hata yönetimi |
| `empty.pdf` | pdf-lib, 0 sayfa | Hata yönetimi |
| `huge.pdf` | Geçerli PDF + `%%EOF` sonrasına 60 MB yorum satırı (`%...`) | Boyut sınırı |

**Şifreli fixture üretimi — gerekçeli çözüm:** pdf-lib şifreli PDF *üretemez*, `qpdf` ve `pikepdf` bu makinede kurulu değildir. Bu nedenle `build-fixtures.mjs`, PDF Standart Güvenlik İşleyicisini (revision 2, 40-bit RC4) doğrudan uygular:

- RC4 şifreleme: ~15 satırlık saf JS uygulaması (Node'un `crypto`'su OpenSSL 3'te RC4'ü kaldırdığı için hazır gelmez)
- `crypto.createHash('md5')` ile `O` ve `U` değerleri üretilir
- RC4 şifreleme uygulanmış bir PDF, uygulamanın `EncryptedPDFError` yolunu gerçekten tetikler

Bu yaklaşım harici bağımlılık istemez ve testin amacını (uygulamanın şifreli dosyayı doğru tanıyıp doğru mesajı göstermesi) birebir karşılar.

**`huge.pdf` üretimi — gerekçeli çözüm:** 60 MB ham rastgele veri Flate ile sıkıştırılamaz; bu yüzden boyut artırma, geçerli bir PDF'in `%%EOF` satırından sonrasına yorum satırları (`%` ile başlayan, PDF okuyucularınca yok sayılan baytlar) eklenerek yapılır. Dosya geçerli bir PDF olmaya devam eder ve tam olarak istenen boyutta olur. Uygulama bu dosyayı ayrıştırmadan, boyut kontrolünde reddeder.

### 7.2 Otomatik testler

Playwright ile `tests/pdf-araclari.spec.mjs` içinde yazılır. Tüm testler `index.html` dosyasını **gerçek `file://` protokolü ile** açar; böylece README'deki kullanım yolu doğrulanır.

| ID | Doğrulanan davranış | Beklenen sonuç |
|---|---|---|
| T01 | Kütüphaneler yükleniyor | `PDFLib` ve `pdfjsLib` tanımlı, konsolda hata yok |
| T02 | Tek dosya yükleme | 3 küçük resim render edildi |
| T03 | Çoklu dosya yükleme | 11 küçük resim, dosya listesi 3 satır |
| T04 | Sayfa silme | 10 küçük resim, silinen sayfa listede yok |
| T05 | Sürükle-bırak sıralama | Çıktıdaki sayfa sırası beklenen diziyle birebir aynı |
| T06 | Sayfa döndürme | Çıktının ilgili sayfasında `/Rotate 90` |
| T07 | A4 normalize | Çıktının **her** sayfası MediaBox `595.28 × 841.89` |
| T08 | A4 normalize kırpma yok | `mixed-sizes.pdf` metni çıktıda `getTextContent` ile hâlâ okunabiliyor |
| T09 | Sıkıştırma, metinli PDF | `text-only.pdf` işleniyor, metin hâlâ okunabiliyor, dürüst uyarı gösteriliyor |
| T10 | Sıkıştırma, taranmış PDF | Çıktı boyutu ≥ %50 küçük, metin hâlâ okunabiliyor |
| T11 | Kayıpsız mod açık uyarısı | Uyarı modalı çıkıyor, iptal edince dosya oluşmuyor |
| T12 | Kayıpsız sıkıştırma | Çıktı ≥ %80 küçük, `getTextContent` boş dönüyor |
| T13 | Şifreli PDF | Net Türkçe hata mesajı, uygulama çökmedi |
| T14 | Bozuk dosya | Net hata mesajı, diğer dosyalar yüklenmeye devam etti |
| T15 | 0 sayfalı PDF | Net hata mesajı |
| T16 | 60 MB dosya | Yükleme reddedildi, boyut sınırı mesajı |
| T17 | Aynı dosya iki kez | 8 küçük resim (4 + 4 kopya) |
| T18 | Geri Al | Eklenen son sayfa geri alındı, küçük resim sayısı 3'e döndü |
| T19 | **Regresyon: mevcut sekmeler** | 5 sekmenin tamamı form doldurup önizleme üretir, `handlePrint()` çalışır |
| T20 | **Regresyon: yazdırma** | Yazdırma önizlemesinde `PDF Araçları` sekmesi görünmüyor (`.no-print`) |
| T21 | **Regresyon: karanlık mod** | `data-theme="dark"` altında PDF paneli okunabilir |
| T22 | **Regresyon: CSP** | Konsolda CSP ihlali veya kaynak yükleme hatası yok |
| T23 | **Duyarlılık** | 390 px genişlikte yatay kaydırma çubuğu oluşmuyor |
| T24 | Çok sayfalı | 60 sayfalık PDF'de küçük resimler, düzenleme ve indirme çalışıyor |

### 7.3 Otomasyonun yakalayamayacağı doğrulamalar

Playwright gerçek tarayıcıda Chromium kullanır. Aşağıdaki üç kalem kodla doğrulanamaz ve teslim notunda **açıkça belirtilir**:

1. **github.io yayını** — `git push` sonrası `Cmd+Shift+R` ile gerçek sayfa yüklemesi. GitHub Pages CDN önbelleği nedeniyle doğrudan açıldığında eski sürüm görülebilir.
2. **100+ sayfalık gerçek sözleşme** — bellek ve akıcılık gözlemi.
3. **iOS Safari** — dosya seçici davranışı ve bellek sınırı.

### 7.4 Kabul kriterleri

- T01–T24'ün tamamı geçiyor
- Konsolda CSP ihlali yok
- Mevcut 5 sekmede davranış değişikliği yok
- `file://` ile açıldığında PDF araçları çalışıyor
- Değişiklik yalnızca şu dosyalarda: `index.html`, üç yeni kütüphane dosyası (`pdf-lib.min.js`, `pdf.min.js`, `pdf.worker.min.js`), `README.md`, `tests/` ve bu dokümanın kendisi (`docs/superpowers/specs/`)

---

## 8. Sıralama ve Aşamalar

| Aşama | İçerik | Bağımlılık |
|---|---|---|
| A1 | Test verisi üretim betiği | — |
| A2 | Kütüphane dosyalarını depoya ekleme | — |
| A3 | CSP `worker-src` ekleme | — |
| A4 | Sekme iskeleti + `switchTab` genişletme + panel HTML/CSS | A2, A3 |
| A5 | Durum modeli, dosya yükleme, dosya listesi | A4 |
| A6 | Küçük resim ızgarası, sürükle-bırak, döndür, sil, geri al | A5 |
| A7 | Çıktı kurulumu (birleştir + A4 normalize) | A6 |
| A8 | Sıkıştırma mod 1 (görsel yeniden kodlama) | A7 |
| A9 | Sıkıştırma mod 2 (görsele çevirme) + onay modalı | A8 |
| A10 | Hata yönetimi ve boyut sınırları | A7 |
| A11 | Playwright test paketi, T01–T24 | A5–A10 |
| A12 | README güncellemesi | A11 |

Her aşama bağımlılığı sağlandıktan sonra başlar. A8, A9 ve A10 birbirinden bağımsız olarak geliştirilebilir; A11 hepsini bekler.

---

## 9. Bilinen Sınırlar

- Şifreli PDF'ler işlenemez; şifre kırma kapsam dışıdır.
- Sıkıştırma, içerik akışındaki vektör çizimleri (tablo çizgileri, şekiller) sıkıştırmaz; yalnızca raster görselleri hedefler.
- Kayıpsız modda CMYK, 16 bit derinlikli ve şeffaflık maskesi (SMask) içeren görseller atlanır; kazanç oranı belgeye göre değişir.
- Form alanları (AcroForm) yüklenen PDF'lerde korunur, ancak A4 normalize modunda form alanı konumları ölçeklenmez ve kayabilir.
- Çok büyük dosyalarda (>50 MB) tarayıcı belleği tükenebilir; bu durum yakalanıp kullanıcıya bildirilir.
- Çıktı PDF'leri şifrelenmez; parola koruması eklenmez.
