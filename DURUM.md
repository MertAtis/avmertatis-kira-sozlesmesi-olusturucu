# Durum — PDF Araçları (son kalite denetimi düzeltmeleri)

**Son güncelleme:** 27 Eylül 2026
**Durum:** 🟢 **Tamamlandı — `npm test` 123/123 geçiyor, 0 kırmızı.**
**Branch:** `main`, commit `a2b31c7` (canlıya **push EDİLMEDİ**)
**Canlı site:** https://mertatis.github.io/avmertatis-kira-sozlesmesi-olusturucu/ → şu an
**`d0f0045`** sürümünü gösteriyor (testleri geçen son sağlam sürüm).

> ⚠️ **Önemli:** Canlıdaki sürüm hâlâ eski. Push öncesi aşağıdaki smoke testi yapılmalı.

---

## Kapanan 12 kırmızı test (27 Eylül 2026)

| Test | Kök neden | Düzeltme |
|---|---|---|
| `T11` `T12` `F3` `A6` | Modal `.app-grid` İÇİNDE olduğu için `inert` modalı da kilitliyordu → hiçbir buton tıklanamıyor, odak tuzağı çalışmıyordu | `inert`/`aria-hidden` artık modalin **dışındaki** kardeşlere + sekme çubuğuna uygulanıyor (`pdf-cikti.js`) |
| `A5` | `pdfState.busy` yalnızca build sırasında doğru; onay beklerken 5 eşzamanlı çağrı hepsi kilitten geçip **5 indirme** üretiyordu | `pdfBuildLock` onay penceresini de kapsıyor → tek onay, tek indirme |
| `A2` | `PDFName.toString()` kaçışlı: `/FlateDecode` → `#2FFlateDecode` | `inspect.mjs`'e `pdfName()` (`decodeText`) yardımcısı |
| `A2c` `A3c` | Kullanıcıya sabit "(desteklenmeyen biçim)" yazılıyordu; gerçek neden (`şeffaflık maskesi`, `renk uzayı desteklenmiyor`) kayboluyordu | Atlanma nedenleri tek tek mesaja yazılıyor |
| `A3b` | **Üç ayrı hata:** (a) fixture paleti geçersiz `PDFDict` olarak yazılıyordu (spec gereği akış), (b) ham veri uzunluğu `channels` ile hesaplanıyordu — Indexed'da piksel başına **1 bayt**, (c) palet `look.asBytes()` ile okunuyordu, pdf-lib'de bu metot **yok** (`asUint8Array()`) | Üçü de düzeltildi; fixture `npm run fixtures` ile yeniden üretildi |
| `A9` | `#pdf-undo-label` span'i `index.html`'de hiç yoktu | Span eklendi |
| `A7` | Geri alma yığınındaki kayıt **tüm sayfaların** anlık görüntüsü olduğu için "o dosyaya ait kayıt" ayrımı imkânsızdı; kayıt düşürülünce diğer dosyaların düzenlemeleri de kayboluyordu | Kayıt **kırpılıyor**: kaldırılan dosyanın sayfaları düşer, kalanlar korunur |
| `A1` | `originalSize` dosyanın **tamamını** sayıyordu: 5 sayfadan 1'i çıktıya girerken "9,8 MB → 2,0 MB (%80 küçüldü)" yazıyordu. Yani **sayfa silmek küçülme gibi gösteriliyordu** | Dosya başına oranlama (kullanılan sayfa / toplam sayfa) + sıkıştırma kapalıyken küçülme olsa bile ipucu gösteriliyor |
| `F2` | "Dosya kaldırılınca geri al **devre dışı** olmalı" beklentisi, `A7`'nin düzelttiği hatanın kendisiydi — iki test çelişiyordu | Test, asıl iddiaya (hayalet kart üretmemeye) göre yeniden yazıldı |

### Rulings (kararlar)

- **A1 ölçümü:** `originalSize` tahmini bir pay olarak gösterilir (çok sayfalı dosyanın
  tek sayfası kullanılıyorsa). Sayfa silmenin küçülme gibi görünmemesi daha önemli.
- **A5:** Eşzamanlı 5 çağrıdan 4'ü düşürülür (tek onay, tek indirme). "Hepsini birleştir"
  alternatifi aynı çıktıyı verir, daha karmaşıktır.
- **F2:** Geri alma düğmesi kaldırma sonrası daha sık aktif; bu istenen davranış.

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
