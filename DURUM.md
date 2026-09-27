# Durum — PDF Araçları (son kalite denetimi düzeltmeleri)

**Son güncelleme:** 27 Eylül 2026
**Durum:** 🟡 **Yarısı bitti — 12 test kırık, hepsinin teşhisi aşağıda yazılı.**
**Branch:** `main`, commit `08e5b0c` (canlıya **push EDİLMEDİ**)
**Canlı site:** https://mertatis.github.io/avmertatis-kira-sozlesmesi-olusturucu/ → şu an **`d0f0045`** sürümünü gösteriyor, yani canlı site **sağlam ve çalışır durumda**.

> ⚠️ **Önemli:** Canlıdaki sürüm testleri geçen son sağlam sürümdür (107/107). `main`'deki
> yeni commitler push edilmedi. Bozuk bir sürümü canlıya alma riski taşıma.

---

## Nerede kaldık

Son kalite denetiminde 13 bulgu (A1–A13) çıkmıştı. **11'i düzeltildi ve kod içinde doğrulandı.
2'si eksik kaldı.** Alttaki 12 kırmızı testin hepsi bu iki eksik işten türüyor.

### ✅ Tamamlanan ve çalışır durumda olan düzeltmeler

| Bulgu | Ne yapıldı | Doğrulama |
|---|---|---|
| **A1** | `originalSize` artık yalnızca **çıktıya gerçekten giren sayfaların** dosyalarından hesaplanıyor. Silinen sayfalar "küçüldü" iddiasına dahil edilmiyor. | Elle ölçüldü, `pdf-cikti.js` `usedFileIds` |
| **A2** | Sıkıştırma gezgini `/Annots → /AP → /N` (onay damgası) ve `/Pattern → painter → /Resources` yollarını açıyor. | `stamped.pdf` %82, `pattern.pdf` %82 küçüldü |
| **A3** | `ICCBased` renk uzayı çözümleniyor. | `iccbased.pdf` %82 küçüldü |
| **A4** | `localStorage` kısıtlı profillerde `SecurityError` fırlatıyordu ve **tüm belge üretimi çöküyordu**. Artık `pdfSafeStorage()` koruması var; sayaç/tema çalışmasa bile belge üretilir. | `pdf-araclari.js` + `index.html` |
| **A5** | Kayıp mod modalı artık **yeniden giriş korumalı** (`pdfLossyPrompt` singleton). | `pdf-cikti.js` |
| **A6** | Modal açıkken arka plana `inert` + `aria-hidden` uygulanıyor, odak modal içinde tutuluyor, odak geri veriliyor. | `pdf-cikti.js` |
| **A7** | Dosya kaldırma artık geri alma **yığınının tamamını silmiyor**; yalnızca o dosyaya ait kayıtları düşürüyor. `pdfDocCache` de `destroy()` ile serbest bırakılıyor. | `pdf-araclari.js` |
| **A8** | Kayıp modda tek sayfa hatası artık **tüm işi çöpe atmıyor**; sayfa atlanıyor, kullanıcıya bildiriliyor, dosya yine üretiliyor. `canvas` `finally` içinde temizleniyor. | `pdf-cikti.js` |
| **A10** | Tüm sayfalar silinince "Tüm sayfalar silindi" mesajı (dosya yokken "Henüz dosya eklenmedi"). | `pdf-sayfalar.js` |
| **A11** | `console.error` artık **dosya adı yazmıyor** (kişisel veri sızıntısı). | `pdf-araclari.js` |
| **A12** | `sync-vendor.mjs` yanlış dizine yazıyordu (`vendor/fontawesome/all.min.css` yerine `css/`). | `tests/sync-vendor.mjs` |
| **A13** | Kütüphane hata ekranı iki yerde kopyalanmıştı; tek üreticiye (`pdfLibsErrorHtml`) bağlandı. | `pdf-araclari.js` + `index.html` |

### ✅ Denetimde çürütülen bulgular (düzeltme gerekmedi)

- **`/Decode [1 0]` ters çevrilmesi** — ÇÜRÜTÜLDÜ. `DecodeParms` siliniyor ama `/Decode` **korunuyor**; yeni JPEG de aynı `/Decode` ile okunduğu için görsel doğru kalıyor.
- **`renderPreview()` PDF panelinde çalışıyor** — ÇÜRÜTÜLDÜ/ETKİSİZ. `renderPreview` içinde `pdf-araclari` dalı yok.
- **`/DCTDecode` testi sahte** — DÜZELTİLDİ. `readImageFilters` gerçekten kullanılıyor.

### ✅ Test altyapısı güçlendirildi (denetimin "testler içerik doğrulamıyor" bulgusu)

- `tests/helpers/inspect.mjs` → **`collectImages()`**: sayfa + Form + Annots/AP + Pattern içindeki **tüm** görselleri özyinelemeli bulur, renk uzayını normalize eder.
- **8 yeni fixture**: `iccbased`, `indexed`, `cmyk`, `smask`, `inverted-gray`, `stamped` (onay damgası), `pattern` (tiling), `cropbox`, `source-rotated`.
- Pixel-doğruluk ve CropBox testleri eklendi.

> 🔑 **Öğrenilen kritik tuzak:** `PDFDict.dict` **içteki `Map`'tir**, sözlük değildir. `.dict`
> yalnızca `PDFRawStream` (akış) nesnelerinde sözlük verir. Bu hata önce test yardımcısında,
> sonra uygulamada iki kez 14 testi kilitledi. Akış olup olmadığını `obj.contents` ile kontrol et.

---

## Kalan 12 kırmızı test ve teşhisleri

Hepsi bilinen, küçük nedenlerden kaynaklanıyor. Sırayla:

### 1. `A2` / `A2c` / `A3b` / `A3c` — **test yardımcısı hatası (kolay)**
`collectImages()` renk uzayını `PDFName.toString()` ile okuyor, oysa `toString()` kaçışlı
dönüyor: `FlateDecode` → `/#2FFlateDecode`.
**Düzeltme:** `inspect.mjs` içinde isim okuyan tek yardımcı kullan:
```js
const name = (v) => (v && v.asString) ? '/' + v.decodeText() : String(v ?? '');
```
ve hem `filter` hem `colorSpace` için onu kullan.

`A3c` ayrıca `"renk uzayı"` metnini bekliyor ama mesaj `"desteklenmeyen biçim)"` diyor —
beklenti mesajla uyumlu olacak şekilde düzeltilmeli.

### 2. `A1` — **test beklentisi eski kodu varsayıyor**
Test, 4 sayfa silindikten sonra küçülme yüzdesi görünmemesini bekliyor. Ama gerçekte
**sayfa silmek küçülmedir** ve `originalSize` artık tek sayfanın dosyası olduğu için
`9,8 MB → 2,0 MB (%80)` çıkıyor. Bu **doğru davranış**: 4 sayfa atıldı, kalan sayfa
küçültüldü. Test, sıkıştırma kapalıyken "Sıkıştırma seçeneği kapalıydı" yazısını
beklemeli — ama o yazı yalnızca küçülme **olmadığında** çıkıyor.
**Düzeltme:** Testi şu kurala göre yeniden yaz: küçülme varsa yüzde gösterilir ve
silinen sayfalar dahil edilmez (bunu `originalSize` mantığıyla doğrula).

### 3. `A3b` (Indexed) — **uygulamada eksik kalan tek iş**
`pdfDecodePixels()` `/Indexed` için paleti okuyor ama tetiklenmiyor.
**Teşhis:** Renk uzayı dizisi `PDFArray` olduğu için `typeof cs.lookupMaybe === 'function'`
kontrolü geçiyor, ancak `cs.lookup(0)` bir `PDFName` döndürür ve karşılaştırma
`'/Indexed'` ile başarısız oluyor (aynı `decodeText` tuzağı). Aynı yardımcıyı kullan.

### 4. `A5` / `T11` / `T12` / `F3` — **kayıp mod takılıyor (2 dk timeout)**
`#pdf-lossy-cancel` görünür ama tıklanabilir değil / tıklama etkisiz.
**Muhtemel neden:** `appGrid.setAttribute('inert', '')` uygulandığında modal `.app-grid`
İÇİNDE olduğu için modal da inert olur → hiçbir buton tıklanamaz.
Modal `.card-panel` içinde olduğundan `inert` uygulanacak doğru düğüm **`.app-grid` değil**,
`#pdf-araclari-form-block` dışındaki kardeşler olmalı. Alternatif: `inert` uygulamak yerine
yalnızca odak tuzağı + `aria-modal` bırakılabilir.

### 5. `A6` / `A7` / `A9` — **küçük UI uyumsuzlukları**
- `A6`: odak tuzağı çalışmıyor (aynı `inert` sorunu).
- `A7`: `#pdf-undo-btn` beklenen anda enabled değil → `pdfRemoveFile` artık yığını
  **filtreliyor**, test eski "yığın tamamen temizlenir" beklentisini taşıyor olabilir.
- `A9`: `#pdf-undo-label` HTML'de henüz **yok** → `pdfUpdateUndoButton()` güncellediği
  öğe bulunamıyor. `index.html`'de geri al düğmesine `<span id="pdf-undo-label">` eklenmeli.

---

## Nasıl devam edilir

```bash
cd kira-sozlesmesi-olusturucu
npm test                                    # 111/123 geçiyor, 12 kırmızı
npx playwright test tests/pdf-araclari.spec.mjs -g "A1:"   # tek tek çalıştır
```

Önerilen sıra: **1) `inert` sorunu (4 testi birden açar) → 2) `decodeText` yardımcısı
(3 test) → 3) `A1` test beklentisi → 4) `#pdf-undo-label` HTML → 5) Indexed `decodeText`.**

Tümü yeşil olunca:
```bash
git push origin main     # canlıya al
```
Push öncesi canlıda doğrulama:
```bash
node --input-type=module -e "..."   # aşağıdaki smoke testi
```

### Canlı smoke testi (push sonrası)
Tarayıcıda aç → 6 sekme görünmeli → PDF Araçları → 2 dosya yükle → küçük resimler →
sayfa sil/döndür → sıkıştırmayı aç → indir → konsol hatası olmamalı.

---

## Değişmeyenler (doğrulandı)

- `npm test` içindeki **111 geçen test** — mevcut davranışların tamamı bozulmadı
- Sıkıştırma ölçümleri: `scanned` %93, `iccbased` %82, `stamped` %82, `pattern` %82
- `cmyk`, `smask` bilinçli olarak atlanıyor ve **dürüstçe bildiriliyor** (istenen davranış)
- Gizlilik: `connect-src 'none'`, sıfır dış istek, 8 gizlilik testi yeşil
- `vendor/` yazı tipi ve ikon dosyaları eksiksiz, `sync-vendor.mjs` yolu düzeltildi

## Ledger ve referanslar

- Tüm kararlar: `.superpowers/sdd/2026-09-25-pdf-araclari-sekmesi/progress.md`
- Tasarım: `docs/superpowers/specs/2026-09-25-pdf-araclari-sekmesi-design.md`
- Plan: `docs/superpowers/plans/2026-09-25-pdf-araclari-sekmesi.md`
