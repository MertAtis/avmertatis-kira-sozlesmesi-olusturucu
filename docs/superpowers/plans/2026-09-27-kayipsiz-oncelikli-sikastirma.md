# Plan: Kayıpsız öncelikli sıkıştırma (2026-09-27)

Tasarım: `docs/superpowers/specs/2026-09-27-kayipsiz-oncelikli-sikastirma-design.md`
Yürütme: inline (executing-plans). TDD her adımda: kırmızı test → düzeltme → yeşil.

## Adım 1 — Kayıpsız motor (tekilleştirme + üst veri temizliği)

Dosyalar: `pdf-cikti.js`, `tests/pdf-araclari.spec.mjs`, `tests/fixtures/build-fixtures.mjs`

1. Fixture: `duplicate-images.pdf` — aynı görsel 3 kez gömülü (3 sayfa).
   Test `L1`: varsayılan modda çıktıda **1** görsel XObject, sayfa sayısı 3,
   dosya girdiden küçük, `collectImages` ile piksel/örnek doğrulanır.
2. `pdfLosslessOptimize(doc)`:
   - `pdfCollectImageXObjects(doc)` → içerik hash'i (FNV-1a) ile Map
   - yinelenenler için `doc.context.enumerateIndirectObjects()` gezilir; her
     `PDFDict` girdisi kontrol edilir, tutan `PDFRef` ile değiştirilir
   - katalogdan `/Metadata`, belgeden `/Thumb`, sayfalardan `/PieceInfo` silinir
3. Test `L2`: JPEG'li ve Flate'li fixture'larda kayıpsız mod çıktısındaki görsel
   baytları girdiyle **aydır** (helper: `readRawImageSamples`/bytes karşılaştırma).
4. Test `L3`: varsayılan mod `flated` görseli JPEG'e çevirmez (`filter` kalır).

## Adım 2 — Arayüz: iki yöntem

Dosyalar: `index.html`, `pdf-cikti.js`, `pdf-araclari.js`

1. `pdf-compress-options` içine yöntem seçimi (`select#pdf-compress-mode`):
   `lossless` (varsayılan) | `quality`.
2. Kalite seçenekleri yalnız `quality` seçiliyken görünür; `lossless`'ta gizli.
3. `pdfReadOutputState()` → `compressMode` okunur.
4. Uyarı metni: "Resmî belge ve sözleşmelerde kullanmayın."

## Adım 3 — Kayıplı yolun ayrılması ve dürüst raporlama

Dosyalar: `pdf-cikti.js`

1. `lossless` → `pdfLosslessOptimize` + `{ deduped, metadataStripped, oneBit }`.
2. `quality` → mevcut `pdfCompressImages` (dokunulmaz).
3. Rapor:
   - lossless: kaç görsel tekilleştirildi, kaç bayt atıldı; küçülme yoksa
     *"Görseller zaten JPEG; resmî belgede görünümü korumak için dokunulmadı."*
   - quality: mevcut dürüst sayaçlar.
4. Test `L4`: JPEG-only belge → mesajda sahte yüzde yok, dürüst metin var.
5. Test `L6`: `PX1`–`PX4` ve `A2`/`A3`/`A3b` sıkıştırma testleri `quality`
   moduna geçer; `PX1`–`PX4` korunur.

## Adım 4 — 1-bit dönüşümü (yalnız birebir)

Dosyalar: `pdf-cikti.js`

1. Fixture `pure-bw.pdf` (tam siyah/beyaz, 1-bit olabilen) ve `photo.pdf`
   (gri tonlu fotoğraf).
2. Test `L7a`: saf b/w → 1-bit + Flate, piksel birebir aynı, ≥%50 küçülme.
3. Test `L7b`: fotoğraf → 1-bit DÖNÜŞMEZ, JPEG olarak kalır.
4. Uygulama: `createImageBitmap` ile çöz, örnekle (en çok 50k piksel), ara ton
   sayısı 0 değilse çık; paketle (`MSBFirst`, `/ImageMask` değil — 1-bit gri
   `/DeviceGray` + `BitsPerComponent 1`), `CompressionStream('deflate')`.

## Adım 5 — Dış bağımlılık guard'ı ve kapanış

Dosyalar: `tests/dependencies.spec.mjs`, `DURUM.md`, ledger

1. Test: uygulama + `vendor/` içinde yüklenen `http(s)://` kaynak yok.
2. Test: `index.html` `src`/`href`'leri depo içinde var.
3. Test: ağ API'si (`fetch`/`XHR`/`WebSocket`/`sendBeacon`) yok.
4. `npm test` tam yeşil; `DURUM.md` + ledger güncellenir; commit + push.

## Doğrulama kapısı

Her adım: ilgili test önce **kırmızı**, düzeltmeden sonra **yeşil**.
Son adımda `npm test` tam yeşil olmadan iş bitmiş sayılmaz.
