# Plan — PDF Araçları: avukat için profesyonel, sıfır dış bağımlılık

**Tarih:** 27 Eylül 2026 · **Plan:** Opus · **Uygulama:** Sonnet alt-ajanları, aşama aşama, her aşama sonrası Opus incelemesi
**Temel:** `1353bd9`, `npm test` 146 geçti + 1 atlandı (canlı test) — başlangıç YEŞİL.

## Değişmez kurallar (her aşama)

1. **Önce kırmızı test, sonra düzeltme.** Her bulgu için testi yaz, KIRMIZI olduğunu gör (çıktıyı rapora koy), sonra düzelt, YEŞİL gör.
2. **Sıfır dış bağımlılık.** Yeni kütüphane, CDN, fontkit, ağ çağrısı yok. Yalnızca depodaki `pdf-lib.min.js` + `pdf.min.js`.
3. **Mevcut test zayıflatılmaz.** Bir beklenti bilinçli olarak değişiyorsa (ör. yatay A4) test açıkça güncellenir ve nedeni yorumda yazılır.
4. **Dürüst mesaj.** Kullanıcıya olmayan bir şey "yapıldı" denmez.
5. Fixture'lar `tests/fixtures/build-fixtures.mjs` içinde üretilir (`.pdf` dosyaları gitignore'da).
6. Test komutu (bulut oturumu): `npm run fixtures && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test`
7. Konsola dosya adı yazılmaz (A11). Kod yorumları Türkçe, mevcut üslupta.

---

## AŞAMA 1 — Doğrulanmış çıktı hataları (`pdf-cikti.js`, `pdf-sayfalar.js`)

### 1.1 Birleştirilmiş dosya ~10× şişiyor
- **Neden:** `pdf-cikti.js` döngüde her sayfa için ayrı `doc.copyPages(file.doc, [i])` → her çağrı yeni `PDFObjectCopier` → ortak font/logo her sayfaya yeniden kopyalanıyor (ölçüm 58 KB → 559 KB).
- **Düzeltme:** Önce dosya başına gerekli benzersiz `srcIndex` listesi çıkar, **dosya başına tek** `copyPages(file.doc, indices)`. Aynı `srcIndex` birden fazla kez kullanılıyorsa ikinci kullanım için ayrı bir kopya al (aynı `PDFPage` nesnesi iki kez eklenmemeli). Toplu kopya hata verirse o dosya için eski sayfa-başı yola geri dön; sayfa başına hata raporlama (`copyFailures`) korunur. Çıktı SIRASI `pdfState.pages` ile aynı kalmalı.
- **Fixture:** `shared-resources.pdf` — 10 sayfa, hepsi aynı gömülü font (StandardFonts değil, `embedFont` ile gömülü değilse de en az aynı büyük logo görseli ≥ 30 KB, Flate) kullanıyor.
- **Test:** A4 açık ve kapalı iki modda: çıktı boyutu < girdi × 1.5; ve çıktıdaki görsel nesne sayısı 1. Sıralama testi: iki dosya karışık sıralanınca metin sırası doğru.

### 1.2 A4 modunda annotation / form alanı kayboluyor
- **Neden:** `embedPage` yalnızca içerik akışını Form XObject yapar; `/Annots` (form alanı görünümü, damga, not) düşer (ölçüm: form alanı 1 → 0).
- **Düzeltme (yalnız yeniden ölçeklenen sayfada, `embedPage` ÖNCESİ):** kopyalanan sayfanın `/Annots` dizisinde her annotation için:
  - Atla: `/F` bayrağında Hidden (2) veya NoView (32); `/Subtype /Popup`.
  - `/AP /N` al; sözlükse (durumlar) `/AS` ile seç. Yoksa: `/Widget` ise "uyarı sayacı"na ekle, `/Link` vb. sessizce atla.
  - PDF 32000 §12.5.5: AP akışının `/BBox`'ını `/Matrix` ile dönüştür → eksen hizalı kutu; bu kutuyu `/Rect`'e eşleyen `A` matrisini hesapla. Sayfanın kaynaklarına `/XObject /FlatN → AP ref` ekle (AP akışında `/Type /XObject /Subtype /Form` yoksa ekle), içeriğe `q A cm /FlatN Do Q` ekle.
  - Orijinal içeriği `q … Q` ile sar (grafik durumu sızmasın), annotation çizimlerini SONA ekle.
  - Kaynaklar (`/Resources`) miras/paylaşımlı olabilir: değiştirmeden önce sayfaya ÖZEL kopya sözlük oluştur, paylaşılan sözlüğü mutasyona uğratma (başka sayfaları bozar).
  - Görünümü olmayan widget varsa sonuç mesajına: "N form alanının görünümü yok; A4'e sığdırmada bu alanlar çıktıda görünmeyebilir. A4 seçeneğini kapatarak deneyin."
- **Tam A4 (yeniden ölçeklenmeyen) sayfa:** `/Annots` olduğu gibi kalır; buna da test.
- **Fixture:** `form-field.pdf` — A5 (yeniden ölçeklenecek) sayfada 1 metin alanı (değer "AVUKAT TEST", `form.updateFieldAppearances`), 1 gizli (Hidden) annotation, 1 AP'siz widget; `form-field-a4.pdf` — tam A4.
- **Test:** A4 modu çıktısında pdf.js ile `AVUKAT TEST` metni çıkarılabilir VEYA render edilen pikselde alan bölgesi boş değil; gizli annotation çizilmemiş; uyarı mesajı görünüyor. Tam A4'te widget sayısı korunur.

### 1.3 Miras `/Rotate` okunmuyor
- **Neden:** `pdfEffectiveRotation` (`pdf-cikti.js`) ve `pdfSourceRotation` (`pdf-sayfalar.js`) `node.get('Rotate')` kullanıyor; `/Pages` ağacından miras gelen değer kaçıyor.
- **Düzeltme:** İkisi de `file.doc.getPage(i).getRotation().angle` (90'ın katına normalize, negatifleri düzelt). Tek yardımcıya indir, iki dosya da onu kullansın.
- **Fixture:** `inherited-rotate.pdf` — `/Rotate 90` yalnız kök `/Pages` düğümünde (elle `catalog.Pages` sözlüğüne yaz, sayfadan sil).
- **Test:** A4 kapalı: çıktı sayfası `Rotate` = 90. A4 açık: çıktı yatay yön doğru (mevcut `source-rotated.pdf` testleriyle aynı ölçüt).

### 1.4 CropBox yok sayılıyor
- **Neden:** `pdfPlaceOnA4` `getSize()` (MediaBox) kullanıyor; gizli kenarlar görünür, ölçek yanlış.
- **Düzeltme:** Görünür kutu = CropBox ∩ MediaBox (CropBox yoksa MediaBox). `embedPage(page, {left,bottom,right,top})` sınır kutusu ver; ölçek, ortalama ve döndürme hesabı bu kutunun `w/h`'sinden. `isExactA4` = görünür kutu A4 **ve** MediaBox = görünür kutu.
- **Fixture:** mevcut `cropbox.pdf`'e kırpma DIŞINDA bir metin ekle (`GIZLI KENAR`, y≈100).
- **Test:** (a) "KIRPMA TESTI" metninin çıktıdaki konumu CropBox ölçeğine göre beklenen yerde (±2pt); (b) `GIZLI KENAR` çıktı render'ında görünmez (pdf.js ile kırpma dikdörtgeni dışında boyalı piksel yok veya Form XObject `/BBox` = CropBox). Mevcut CropBox testi yeşil kalır.

### 1.5 Kayıpsız tekilleştirme yalnız baytları karşılaştırıyor
- **Neden:** `pdfLosslessOptimize` yalnız `contents` karşılaştırıyor; aynı bayt + farklı `/Decode`/`/ColorSpace` olan iki görsel birleşip biri bozuluyor. Ayrıca yalnız `/Image`.
- **Düzeltme:** Eşitlik = `contents` bayt bayt eşit **ve** `dict.toString()` eşit. Tüm akışlara genişlet (font dosyaları, ICC profilleri, Form XObject'ler); katalog/sayfa düğümü/`/Metadata` hariç. Tekilleştirme + budama (`pdfPruneUnusedObjects`) **her çıktıda** çalışsın (sıkıştırma kapalıyken de; pikseli değiştirmez). Üst veri silme ve 1-bit yalnız sıkıştırma açıkken.
- **Fixture:** `same-bytes-diff-decode.pdf` — aynı gri baytlar, biri `/Decode [1 0]`.
- **Test:** iki görsel ayrı kalır, render pikselleri kaynakla aynı. 1.1 fixture'ında font dosyası tekilleşir.

### 1.6 1-bit dönüşümü sözlük özelliklerini kaçırıyor
- **Düzeltme:** Beyaz liste: `{Type, Subtype, Width, Height, BitsPerComponent, ColorSpace, Filter (yalnız tekil /FlateDecode), Length, Interpolate (kopyala)}`. Başka anahtar (`/Decode`, `/Mask`, `/DecodeParms`, `/SMask`, dizi filtre, `/Intent`…) varsa ATLA.
- **Test:** `/Decode [1 0]` taşıyan saf siyah-beyaz görsel 1-bit'e çevrilmez, pikseller aynı.

### 1.7 Yatay sayfa dikey A4'e sıkıştırılıyor
- **Düzeltme:** Yeni seçenek `#pdf-opt-landscape` "Yatay sayfaları yatay A4 yap" (varsayılan açık, `pdf-opt-a4` altında). Döndürme sonrası kutu `w > h` ise hedef `[A4_HEIGHT, A4_WIDTH]`. Tam yatay A4 sayfa doğrudan eklenir. Kayıp (görsele çevirme) yolunda da aynı kural.
- **Mevcut testler:** 90/270 dereceli A4 testleri artık yatay sayfa üretir. Bu testler ya `landscape:false` ile eski davranışı kanıtlamaya devam eder ya da yeni boyutu bekler — ikisi de bilinçli; `buildOutput` yardımcısına `landscape` parametresi ekle.
- **Test:** yatay kaynak → 841.89×595.28 ve ölçek dikeye göre ≥ %40 büyük; seçenek kapalıyken eski davranış.

### 1.8 Temizlik
- `metadataStripped += 0` sil; çift JSDoc'ları (`pdfBuildOutput` üstü, `pdfSafeFileName` üstü) düzelt; "N saf siyah-beyaz sayfa 1-bit'e çevrildi" → "N görsel". Belge başlığı (`setTitle`) = çıktı dosya adı (uzantısız).
- **Test:** çıktı `Title` = indirilen dosya adı (uzantısız).

**Aşama 1 bitti ölçütü:** tüm yeni testler önce kırmızı görüldü (rapora eklendi), şimdi tüm suite yeşil. Commit: aşama başına ayrı, açıklayıcı.

---

## AŞAMA 2 — Avukat kullanımı (UX)

> **Kullanıcı kararı (27.09.2026): KISALTILMIŞ kapsam.** Bu turda yalnız madde
> **5 (çıktı adı) ve 7 (ön ayar)** yapılır. Madde 1 (e-imza uyarısı) kullanıcı
> isteğiyle KALDIRILDI; madde 2, 3, 4, 6 sonraki tura ertelendi.

1. **E-imza uyarısı:** yüklenen dosyada `/FT /Sig` alanı veya `/ByteRange` varsa dosya satırında ve çıktı öncesi belirgin uyarı: "Bu belge elektronik imzalı. Birleştirme/düzenleme imzayı geçersiz kılar; imzalı orijinali ayrıca sunun." Fixture: `signed-like.pdf` (sahte `/Sig` alanı + `/ByteRange`).
2. **Dosya sıralama:** dosya satırında ↑/↓ düğmeleri; o dosyanın sayfaları blok olarak taşınır; geri alınabilir.
3. **Klavyeyle sayfa taşıma:** her kartta "Sola taşı / Sağa taşı" düğmeleri (`aria-label`, Tab ile ulaşılır, ilk/son kartta devre dışı). Sürükle-bırak var ise korunur.
4. **Büyük önizleme:** karta tıklama/Enter → modal içinde büyük render (pdf.js, ~1.5×), Esc ile kapanır, odak geri döner, odak tuzağı (mevcut modal deseni).
5. **Düzenlenebilir çıktı adı:** `#pdf-output-name` metin kutusu; varsayılan mevcut `pdfOutputFileName()`; `pdfSafeFileName` + `.pdf` garanti.
6. **Ek etiketi + sayfa no (seçmeli, varsayılan kapalı):** "Dosya başına EK-1, EK-2… etiketi" (her dosyanın ilk sayfası sağ üst) ve "Sayfa x / y" (alt orta). Helvetica (standart font, gömme yok, fontkit yok). WinAnsi sorunu: yalnız ASCII üreten yardımcı (`pdfAsciiLabel`) — Türkçe karakter `İ→I, ş→s …`; test: yardımcı her girdide `/^[\x20-\x7E]*$/` döndürür ve çıktı metni pdf.js ile okunur.
7. **Ön ayar:** çıktı bölümünün başında iki radyo: "Mahkemeye / UYAP'a sunulacak" (A4 açık, kayıpsız, görsele çevirme kapalı — varsayılan) ve "E-posta için küçült" (kayıplı kalite 0.7). Ön ayar yalnız mevcut kutuları ayarlar; kullanıcı sonra değiştirebilir.

Her madde için Playwright testi (erişilebilirlik: rol/etiket ile seçim). Mevcut A-testleri (modal, geri al) yeşil kalır.

---

## AŞAMA 3 — Kalıcılık

1. CSP `img-src 'self' data: blob:` (`https:` kaldır). Önce kira sekmesinde `https:` görsel kullanımını ara; varsa depoya al. `dependencies.spec` U5'e `img-src`'de `https:` olmadığını test et.
2. `tests/dependencies.spec.mjs`: `pdf-lib.min.js`, `pdf.min.js`, `pdf.worker.min.js` ve `vendor/**` için SHA-256 sabitleme (beklenen özetler test dosyasında; `node:crypto` testte, uygulamada değil).
3. Aşama 1–2 fixture'ları `fixtures.spec.mjs`'te de doğrulanır.
4. `.github/workflows/test.yml`: push/PR'da `npm ci`, `npx playwright install --with-deps chromium`, `npm run fixtures`, `npx playwright test` (canlı test hariç: `--grep-invert canlı` veya mevcut atlama mekanizması).
5. `DURUM.md` güncelle: eski "push EDİLMEDİ" notu yanlış (origin/main = `1353bd9`); yeni bulgular, test sayısı.

---

## AŞAMA 4 — Yayın (kullanıcı ONAYIYLA)

1. Tam suite yeşil → çalışma dalı `main-g0uefy`'ye push.
2. **Kullanıcıdan açık onay** → `main`'e aktar (`git push origin main-g0uefy:main`) — GitHub Pages yayınlar.
3. Birkaç dakika sonra `tests/privacy-live.spec.mjs` + duman testi canlı adrese: https://mertatis.github.io/avmertatis-kira-sozlesmesi-olusturucu/
