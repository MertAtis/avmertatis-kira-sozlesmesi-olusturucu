# Tasarım: PDF Araçları — kayıpsız öncelikli sıkıştırma (2026-09-27)

## Problem

Araç "Boyutu küçült" seçeneğini işaretlediğinde, PDF'in içindeki görselleri JPEG'e
yeniden kodlar. Taranmış bir PDF'teki sayfa görselleri zaten JPEG ise ("zaten JPEG")
hiçbir şey yapılmaz ve kullanıcı şu mesajı görür:

> Orijinal 3,0 MB → Çıktı 3,0 MB. 0 görsel yeniden kodlandı, ancak 9 görsel
> küçültülemedi (zaten JPEG).

Araç, en yaygın belge tipinde (taranmış PDF) hiçbir işe yaramıyor; kullanıcı
sayfayı kapattığında hangi kararın alındığını anlamıyor.

## Kısıtlar (kullanıcı kararı)

1. **Görünüm bozulmayacak.** Belgeler resmî kurumlara sunuluyor. Pikseller
   birebir aynı kalmalı; kayıpsız işlemler dışında hiçbir şey yapılmayacak.
2. **Dış bağımlılık olmayacak.** Kütüphaneler ve varlıklar depoda; CDN, WASM
   indirme, uzak API yok. PDF işlevi ileride kendiliğinden bozulmayacak.
3. **Mesajlar dürüst olacak.** Yapılmayan bir şey yapılmış gibi gösterilmeyecek;
   yapılan şey de saklanmayacak.

## Gerçekçi sınır (tasarımın dayandığı kısıt)

JPEG'e gömülü görsel, **piksele dokunmadan** tarayıcıda büyük ölçüde
küçültülemez. Kazanç kaynakları:

| İşlem | Kayıpsız mı? | Tipik kazanç |
|---|---|---|
| Aynı görselin birden çok kez gömülmesini tekilleştirme | Evet | %0-40 (bazen) |
| `/Metadata`, `/Thumb`, `/PieceInfo`, kullanılmayan nesneleri atmak | Evet | %1-5 |
| Nesne akışı (object stream) ile yeniden yazma | Evet | %3-10 |
| 1-bit'e çevirme (yalnız piksel birebir siyah/beyazsa) | Evet | nadir, %50+ |
| JPEG'i mozjpeg ile kayıpsız sıkıştırma | Evet | %2-10, **varsayılan KAPALI** |
| JPEG kalitesini düşürme / DPI düşürme / 1-bit'e çevirme | **Hayır** | %60-85 — **kurumsal kullanımda yasak** |

Bu yüzden aracın iki ayrı, dürüstçe adlandırılmış yolu olacaktır.

## Arayüz

`#pdf-opt-compress` kutusu korunur, yanına bir yöntem seçimi gelir:

- **Kayıpsız (görünüm aynı)** — varsayılan
- **Kaliteyi düşürerek küçült (görünüm değişir)** — bilinçli seçim; altında
  kalite seçenekleri (Düşük/Orta/Yüksek) ve uyarı:
  *"Resmî belge ve sözleşmelerde kullanmayın."*

Görsel kalitesi seçenekleri yalnızca ikinci yöntem seçiliyken görünür.

## Kayıpsız sıkıştırma motoru

Yeni modül `pdf-cikti.js` içinde: `pdfLosslessOptimize(doc)`.

1. **Görsel tekilleştirme.** Tüm görsel XObject'ler içeriğine göre hashlenir
   (FNV-1a — `crypto.subtle` `file://` üzerinde güvenli bağlam olmadığı için
   kullanılamaz). Aynı hash'e sahiplerden biri tutulur, diğerlerinin tüm
   referansları tutana yönlendirilir (`doc.context.enumerateIndirectObjects()`
   ile tüm nesneler gezilir, `PDFRef` değerleri değiştirilir).
2. **Üst veri temizliği.** Katalogdan `/Metadata`, sayfalardan `/PieceInfo`,
   belgeden `/Thumb` silinir. Görünüm etkisi yoktur.
3. **Nesne akışı.** `doc.save({ useObjectStreams: true })` (bugün zaten var).
4. **1-bit dönüşümü — yalnız birebir.** Görsel çözülür (`createImageBitmap`),
   örneklenen tüm pikseller tam olarak 0 ya da 255 ise (ara ton **sıfır**) ve
   küçülme ≥ %50 ise piksel paketlenip 1-bit + Flate olarak yazılır. JPEG kaynak
   neredeyse hiçbir zaman bu testi geçmez; geçerse de kazanç birebir kayıpsızdır.

Her adım "kayıpsız" olduğu kanıtlanabilir: çıktıdaki görsel baytları girdiyle
**bayt bayt aynıdır** (tekilleştirme dışında).

## Kayıplı yol

Bugünkü davranış aynen korunur (görseller JPEG'e yeniden kodlanır), yalnızca
adı, uyarısı ve varsayılanı değişir. `pdfDecodePixels` dışındaki tüm güvenlik
kontrolleri (predictor, 4-kanal ICC, palet uzunluğu, CMYK tabanı) yerinde kalır.

## Raporlama

- Kayıpsız modda ne yapıldığı yazılır: tekilleştirilen görsel sayısı, atılan
  üst veri, varsa 1-bit'e çevrilen sayfa sayısı.
- Hiçbir şey küçültülemediyse: *"Görseller zaten JPEG; resmî belgede görünümü
  korumak için dokunulmadı."* — `0 görsel yeniden kodlandı` gibi belirsiz metin yok.
- Kayıplı modda: kaç görsel yeniden kodlandı, kaçı atlandı ve **nedenleri**.

## Dış bağımlılık koruması

Yeni kural (testle zorlanır):
- Uygulama kodunda ve `vendor/`de `http(s)://` yüklenen kaynak, `fetch`,
  `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `importScripts` yok.
- `index.html` içindeki her `src`/`href` depo içinde bir dosyaya çözümlenir.
- Kütüphane sürümleri `package.json`'da sabittir; üretimde yalnızca `vendor/`
  kullanılır.

## Testler

| Test | Kanıt |
|---|---|
| L1 | Aynı görsel 3 kez gömülü PDF → çıktıda 1 görsel, görüntü aynı, dosya küçük |
| L2 | Kayıpsız modda JPEG/Flate görsellerin **baytları değişmez** |
| L3 | Varsayılan mod Flate görseli JPEG'e çevirmez (düzen değişmedi) |
| L4 | JPEG-only belge → dürüst mesaj, sahte yüzde yok |
| L5 | Dış kaynak/ağ API'si yok (guard) |
| L6 | Kayıplı mod hâlâ çalışır (regresyon) + uyarı görünür |
| L7 | 1-bit dönüşümü yalnız birebir b/w'ye uygulanır; fotoğrafa uygulanmaz |

Var olan `PX1`–`PX4` piksel doğruluk testleri korunur ve kayıplı moda bağlanır.

## Riskler ve azaltma

| Risk | Azaltma |
|---|---|
| Tekilleştirme yanlış referans yazımı → bozuk PDF | Çıktı pdf-lib ile yeniden açılır; görsel sayısı ve piksel eşitliği testte doğrulanır |
| 1-bit dönüşümü fotoğrafı siyah-beye çevirir | Test tam olarak 0/255 şartı; JPEG'lerde fiilen tetiklenmez |
| `crypto.subtle` olmayan bağlamda hash hatası | FNV-1a (saf JS) |
| Kayıpsız modda kazanç beklentisi düşük | Mesaj açıkça ne yapıldığını ve neden azaldığını söyler |
