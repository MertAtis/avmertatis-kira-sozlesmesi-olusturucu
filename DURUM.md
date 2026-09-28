# Durum — PDF Araçları (denetim + bağımsız inceleme)

**Son güncelleme:** 28 Eylül 2026 (JPEG küçültme — YEREL, push EDİLMEDİ)
**Durum:** 🟢 **`npm test` 290/290 geçti.**
**Canlı site:** `d728751` (iki düğme canlıda).

## "Küçült" artık JPEG'i de küçültür (28 Eylül)

Sorun: "Birleştir ve Küçült" JPEG görselleri "zaten JPEG" diye atlıyordu — telefon/tarayıcı
taramalarının neredeyse hepsi JPEG olduğu için düğme bu belgelerde hiçbir şey yapmıyordu.

Çözüm (`pdfRecodeJpeg`): JPEG çözülür, uzun kenar kaliteye göre sınırlanır (Düşük 150 / Orta 200 /
Yüksek 300 DPI A4 = 1754 / 2339 / 3508 px; Flate görsellere de aynı sınır), seçilen kalitede
yeniden yazılır. %5'ten az küçülürse orijinal korunur. EXIF (APP1) çözmeden önce silinir —
tarayıcı yön etiketini uygular, PDF görüntüleyici uygulamaz; silinmezse görsel yan dönerdi (`K3`).
Atlananlar: CMYK/4 kanallı ICC, /Decode, /DecodeParms, /SMask, /Mask. "Birleştir" ve kayıpsız
yöntem JPEG baytlarına DOKUNMAZ (`K4`, sadakat testine `jpeg-only.pdf` eklendi).
Testler: `K1`–`K4` (`tests/avukat-ux.spec.mjs`).

## İki düğme turu (28 Eylül)

Hızlı ayarlar ("Mahkemeye / UYAP", "E-posta için küçült") kaldırıldı — basınca neredeyse
hiçbir şey değişmiyor, aynı karar iki kez soruluyordu. Yerine İndir bölümünde iki düğme:

| Düğme | Ne yapar |
|---|---|
| **Birleştir** (tek dosyada **Kaydet**) | Gelişmiş ayarlar neyse o; varsayılanda sıkıştırma yok, görünüm birebir |
| **Birleştir ve Küçült** (tek dosyada **Küçültüp Kaydet**) | Görseller Gelişmiş'teki kaliteyle (varsayılan Orta) yeniden kodlanır; metin seçilebilir; altında "mahkemeye sunulacak belgede kullanmayın" notu |

A4, yatay A4, sıkıştırma yöntemi, kalite, görsele çevirme → kapalı **"Gelişmiş ayarlar"** (`#pdf-advanced`).
Ayar her tıklamada sayfadan yeniden okunur; Küçült geçersiz kılması sonraki Birleştir'e sızmaz (`B3`).
Testler: `B1`–`B3` (`tests/avukat-ux.spec.mjs`); test yardımcıları Gelişmiş'i açar.

### Araştırma: görünümü bozmadan küçültme (sonraki tur adayı)
JPEG taramalar görünüm korunarak en fazla ~%5–10 küçülür (Huffman optimizasyonu; saf JS yok, WASM yasak).
Yapılabilir ve anlamlı: **CCITT G4** (siyah-beyaz taramada 1-bit Flate'in 2–4 katı küçük, tüm okuyucular
destekler) ve **PNG predictor + RGB→gri / palet** (ekran görüntüsü, dijital belge: %20–50). Tahmini 2–3 saat.

## Sadakat turu (28 Eylül) — kural: yüklenen belgeye HİÇBİR şey eklenmez/çıkarılmaz

`bce2429` satır satır incelendi. Yeni `tests/sadakat.spec.mjs`: 26 örnek PDF × 4 mod
(olduğu gibi / kayıpsız / A4 / A4+kayıpsız), kaynak ve çıktı pdf.js ile not/damga
dahil çizilip piksel piksel karşılaştırılır (104 test).

| Bulgu | Etki | Düzeltme |
|---|---|---|
| **1-bit dönüşümü görseli SİLİYORDU** | Kayıpsız küçültmede saf siyah-beyaz taranmış sayfa BOŞ çıkıyordu: `ColorSpace: '/DeviceGray'` → pdf-lib `/#2FDeviceGray` (geçersiz ad) | Adlar `/` öneksiz yazılır (`pdf-cikti.js`) |
| Testler bu hatayı gizliyordu | `inspect.mjs` `pdfName()` baştaki fazla `/`'yi siliyordu; örnek dosya üreticisi de aynı hatayla bozuk PDF'ler üretiyordu (`stamped`, `iccbased`, `indexed`…) | Yardımcı sıkılaştırıldı, üretici düzeltildi, örnekler yeniden üretildi |
| **Yazdırılmaz not A4 çıktısına ekleniyordu** | Print bayrağı kapalı inceleme notu baskı kopyasına gömülüyordu | Yalnızca yazdırılan annotation gömülür (`NP1`, `noprint-annot.pdf`) |

İncelemede sorun bulunmayanlar: R1 ayraç, R2/R3, 1.5 tekilleştirme (bayt+sözlük), budama
(her çıktıda — sadakat testiyle doğrulandı), 1.6 beyaz liste, 1.7 yatay A4, 1.8 başlık.
Canlı elle kontrol: 6 sekme, "Dosya adı", "Mahkemeye / UYAP'a sunulacak", "E-posta için küçült", yatay A4 seçeneği görünüyor.

Bilinen ve bilinçli: A4 modunda form alanları düzleşir (etkileşim gider), bağlantılar (/Link) düşer.

## Normal (yerel) oturumda ilk adımlar

1. `git fetch origin && git checkout main && git pull`
2. `npm ci && npx playwright install chromium`
3. `npm run fixtures && npm test` → 175 geçti beklenir
4. **Canlı doğrulama (bulut oturumundan YAPILAMADI — ağ `github.io`'yu engelliyordu):**
   `npx playwright test tests/privacy-live.spec.mjs tests/smoke.spec.mjs`
   Elle: sitede PDF Araçları → Çıktı bölümünde "Dosya adı" kutusu ve "Mahkemeye / UYAP'a sunulacak" düğmesi görünmeli.

## Açık kalan noktalar

- Yalnızca Chromium'da test edildi (Safari/Firefox denenmedi).
- Testler üretilmiş örnek PDF'lerle; gerçek UYAP çıktıları / taranmış evrakla denenmedi.

## Sonraki tur için önerilen sıra

1. Sayfa ayırma / seçili sayfaları ayrı PDF olarak çıkarma
2. Sayfa numarası "Sayfa x / y" ve dosya başına "EK-1, EK-2" etiketi (Helvetica, yalnız ASCII — fontkit yok)
3. Çıktı seçeneklerini sadeleştir: hızlı ayarlar üstte, ayrıntılar "Gelişmiş" altında
4. Karartma (KVKK — kişisel veriyi gerçekten silen, yalnız siyah kutu çizmeyen)
5. Ertelenenler: dosya sıralama (↑/↓), klavyeyle sayfa taşıma, büyük önizleme

Kararlar: e-imza uyarısı kullanıcı isteğiyle yapılmadı. Sıfır dış bağımlılık kuralı sürüyor.

## Avukat turu (plan: `docs/superpowers/plans/2026-09-27-avukat-pdf-mukemmellik.md`)

Her bulgu için önce kırmızı test, sonra düzeltme.

| # | Hata / özellik | Sonuç |
|---|---|---|
| 1.1 | Birleştirmede ortak font/logo her sayfaya kopyalanıyordu (~10× şişme) | Dosya başına tek kopya |
| 1.2 | A4 modunda form alanları / damgalar kayboluyordu | Görünümleri sayfaya gömülür; görünümsüz alan için uyarı |
| 1.3 | Üst düğümden miras `/Rotate` okunmuyordu | `getRotation()` |
| 1.4 | CropBox yok sayılıyordu (gizli kenar görünüyordu) | Görünür kutu = CropBox ∩ MediaBox |
| 1.5 | Kayıpsız tekilleştirme yalnız baytlara bakıyordu | Sözlük de eşit olmalı; her çıktıda çalışır |
| 1.6 | 1-bit dönüşümü `/Decode` vb. özellikleri kaçırıyordu | Beyaz liste |
| 1.7 | Yatay sayfa dikey A4'e sıkışıyordu | Yatay A4 (varsayılan açık seçenek) |
| 1.8 | Temizlik; belge başlığı = çıktı dosya adı | ✓ |
| 2 | Düzenlenebilir dosya adı; "Mahkemeye/UYAP" ve "E-posta için küçült" hızlı ayarları | ✓ (`tests/avukat-ux.spec.mjs`) |
| 3 | CSP `img-src`'den `https:` kaldırıldı; kütüphane/vendor SHA-256 sabitleme (U6); GitHub Actions ile her push'ta test | ✓ |

Ertelenen (sonraki tur): dosya sıralama, klavyeyle sayfa taşıma, büyük önizleme, EK/sayfa no etiketi.
E-imza uyarısı kullanıcı isteğiyle yapılmadı.

---

## Kayıpsız öncelikli sıkıştırma (resmî belge kullanımı)

Belgeler resmî kurumlara sunulduğu için **görünüm bozulmaz** ve **dış bağımlılık
olmaz** kuralıyla sıkıştırma yeniden tasarlandı.

| Yöntem | Ne yapar | Görünüm |
|---|---|---|
| **Kayıpsız** (varsayılan) | Tekrarlanan görselleri tekleştirir, gereksiz belge bilgisini atar, kullanılmayan nesneleri budar, **piksel birebir 0/255 ise** 1-bit'e çevirir | **birebir aynı** (testle kanıtlanır) |
| **Kaliteyi düşürerek küçült** (bilinçli seçim) | Görselleri seçilen kalitede JPEG'e yeniden kodlar | değişir — resmî belge için kullanılmaz |

Gerçekçi sınır: JPEG'li bir taranmış PDF, **görünümü bozmadan** büyük ölçüde
küçültülemez. Araç artık bunu saklamaz: *"Görseller zaten sıkıştırılmış; resmî
belgede görünümü korumak için dokunulmadı."* der. Kazanç yoksa sahte yüzde göstermez.

Dış bağımlılık guard'ı eklendi (`tests/dependencies.spec.mjs`): bir CDN, uzak API,
WASM izni (`wasm-unsafe-eval`) veya sabitlenmemiş sürüm eklenirse **test kırmızıya
döner**. Tasarım: `docs/superpowers/specs/2026-09-27-kayipsiz-oncelikli-sikastirma-design.md`

---

## Önceki turda bulunan ve düzeltilen hatalar (bağımsız inceleme)

Daha önce "düzeltildi" yazan 4 kayıt **gerçekte çalışmıyordu**. Hepsi için önce
kırmızı test yazıldı, sonra düzeltildi.

### Sessizce bozuk çıktı üreten 3 hata

| Bulgu | Gerçek durum | Düzeltme |
|---|---|---|
| **ICCBased 4 kanal** | `xobj.doc` pdf-lib'de **yok**; profilin `N` değeri hiç okunmuyordu, hep 3 varsayılıyordu. CMYK görseller RGB sanılıp bozuluyor, "başarılı" sayılıyordu | `dict.context.lookup(...)`; `N` 4 veya okunamıyorsa **atlanır** (`PX3`) |
| **PNG predictor** | `/DecodeParms` hiç okunmuyordu; delta kodlu satırlar inflate edilip piksel sanılıyordu → gürültü | `Predictor ≠ 1` ise **atlanır** (`PX4`) |
| **Indexed palet** | Palet yetersizse `undefined` → siyaha dönüşüyordu; taban renk uzayı CMYK olabiliyordu | Palet uzunluğu + `hival` + taban doğrulanır |

> Ders: `filter === '/DCTDecode'` olması "başarılı" demek değil. Artık
> **piksel doğruluğu ölçülüyor** (`PX1`, `PX2`): kaynak örnekler Node'da
> bağımsız okunup (zlib) çıktıdaki JPEG ile karşılaştırılıyor.

### Sessiz veri kaybı

- **Geri al, ikinci yüklenen dosyayı çıktıdan siliyordu.** `a.pdf` → döndür →
  `b.pdf` yükle → "Geri Al" = `b.pdf` çıktıdan gitti, dosya satırı hâlâ
  "3 sayfa" diyordu. Artık **dosya ekleme geri alınabilir** bir iş ve geri al
  dosyayı hem listeden hem çıktıdan kaldırıyor (`UD1`).
- **Kayıp modda atlanan sayfaların haberi kullanıcıya ulaşmıyordu.** Mesaj
  hemen eziliyor, 5 sayfalık belgeden 4 sayfa üretilip "dosya zaten optimize"
  deniyordu. Artık hangi sayfaların atlandığı yazılıyor (`A8`).

### Kaynak ve davranış

- `pdf.js` belgeleri `destroy()` **çağrılmıyordu** (yorum "yok eder" diyordu).
- Geri alma kaydı `thumbnailPending` taşıyordu → kart kalıcı "Yükleniyor".
- **60 sayfada tek silme 59 küçük resim** yeniden kodluyordu → 0.
- Vektör yolda tek sayfa hatası tüm işi çöpe atıyordu → sayfa başına koruma.
- `replaced>0` iken "büyük görsel bulunamadı" deniyordu, `%0 küçüldü` mümkündü,
  genel yükleme hatası bir sonraki listede siliniyordu, sekme çubuğu `inert`
  değildi (yanlış seçici) — hepsi düzeltildi.

### Kapanan testler / yeni testler

- `A8` (kayıp mod haberi), `UD1` (geri al + dosya ekleme), `UD2` (thumbnailPending),
  `I15` (kalıcı hata kutusu)
- `PX1`–`PX4` (piksel doğruluğu, CMYK ICC, predictor)
- Yeni fixture'lar: `iccbased-cmyk.pdf`, `predictor.pdf`
- `tests/smoke.spec.mjs`: 6 sekme + uçtan uca + **sıfır ağ isteği** + **sıfır konsol hatası**
- Beklenti güncellenenler: `F2`, `T18b`, `A1` toleransı

---

## Önceki turun özeti (A1–A13 denetimi)

13 bulgunun 11'i önceki turda düzeltildi; kalan iş bu turda kapatıldı.
Tam liste aşağıdaki tabloda.

| Bulgu | Ne yapıldı | Doğrulama |
|---|---|---|
| **A1** | `originalSize` çıktıya giren sayfalara göre **oranlanıyor** | `A1` testi yeşil |
| **A2** | Sıkıştırma gezgini `/Annots → /AP → /N` ve `/Pattern → painter → /Resources` yollarını açıyor | `stamped`/`pattern` küçülüyor |
| **A3** | `ICCBased` ve `Indexed` renk uzayları çözümleniyor | `iccbased`/`indexed` küçülüyor |
| **A4** | `localStorage` `SecurityError` verdiğinde belge üretimi çökmüyordu | `pdfSafeStorage()` koruması |
| **A5** | Kayıp mod modalı yeniden giriş korumalı + build kilidi | `A5` yeşil |
| **A6** | Modal açıkken arka plan `inert` + `aria-hidden`, odak modalde tutuluyor | `A6` yeşil |
| **A7** | Dosya kaldırma geri alma yığınını **kırpar**, `pdfDocCache` `destroy()` ile serbest bırakılır | `A7`/`F2` yeşil |
| **A8** | Kayıp modda tek sayfa hatası işi çöpe atmıyor; sayfa atlanıp bildiriliyor | `T11`/`T12` yeşil |
| **A9** | Geri al düğmesi ne yapılacağını yazıyor (`#pdf-undo-label`) | `A9` yeşil |
| **A10** | Tüm sayfalar silinince doğru mesaj | `A10` yeşil |
| **A11** | `console.error` dosya adı yazmıyor | `A11` yeşil |
| **A12** | `sync-vendor.mjs` yanlış dizine yazıyordu | Düzeltildi |
| **A13** | Kütüphane hata ekranı iki yerde kopyalıydı | Tek üreticiye bağlandı |

### Çürütülen bulgular

- **`/Decode [1 0]` ters çevrilmesi** — ÇÜRÜTÜLDÜ. `DecodeParms` siliniyor, `/Decode` korunuyor.
- **`renderPreview()` PDF panelinde çalışıyor** — ETKİSİZ.
- **`/DCTDecode` testi sahte** — DÜZELTİLDİ, `readImageFilters` gerçekten kullanılıyor.

---

## Nasıl devam edilir

```bash
cd kira-sozlesmesi-olusturucu
npm test        # 123/123 yeşil
```

Kalan tek adım: **push + canlı smoke testi.**

```bash
git push origin main
```

Tarayıcıda aç → 6 sekme görünmeli → PDF Araçları → 2 dosya yükle → küçük resimler →
sayfa sil/döndür → sıkıştırmayı aç → indir → konsol hatası olmamalı.
Ayrıca kayıp mod onayı: 5 kez "Oluştur" → tek onay → **tek** indirme.

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
