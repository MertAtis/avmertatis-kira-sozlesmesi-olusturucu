# Durum — PDF Araçları Sekmesi

**Son güncelleme:** 26 Eylül 2026
**Durum:** 7 / 9 görev tamamlandı. Sonraki adım: Task 8.
**Branch:** `feature/pdf-araclari-sekmesi` (henüz `main`'e birleştirilmedi, henüz push edilmedi)

---

## Tek cümlelik özet

Mevcut tek dosyalık kira sözleşmesi jeneratörüne 6. sekme (`PDF Araçları`) eklendi:
birleştirme, sayfa silme/sıralama/döndürme, A4'e sığdırma, iki modlu boyut küçültme.
62 otomatik test yeşil. Canlıya alma için 2 görev kaldı.

---

## Yapılanlar

| # | Görev | Durum | Commit |
|---|---|---|---|
| 1 | Test altyapısı + 16 test fixture'ı | ✅ | `28a09b0` |
| 2 | Kütüphane vendor'ı, CSP, sekme iskeleti | ✅ | `c07df5f` |
| 3 | Dosya yükleme, durum, hata yönetimi | ✅ | `4b255da` |
| 4 | Küçük resim ızgarası, düzenleme, geri alma | ✅ | `ff6e830` |
| 5 | Çıktı üretimi, birleştirme, A4 normalize | ✅ | `3f25997` |
| 6 | Sıkıştırma mod 1 — görsel yeniden kodlama | ✅ | `c292fd3` |
| 7 | Sıkıştırma mod 2 — görsele çevirme + onay | ✅ | `f692254` |
| 8 | Tema, duyarlılık, regresyon taraması | ⬜ | — |
| 9 | README, sıfırdan doğrulama, canlıya alma | ⬜ | — |

### Mevcut test durumu

```
npx playwright test   →   62 passed
```

Test kapsamı: 16 fixture'ın üretimi, 6 kütüphane/sekme kabuğu testi, 11 dosya
yükleme ve hata yönetimi testi, 10 sayfa düzenleme testi, 9 çıktı/A4 testi,
6 sıkıştırma mod 1 testi, 4 kayıp mod testi, 5 A4 dönüşüm matematiği testi.

---

## Doğrulanmış çalışma ölçümleri

Bunlar tahmin değil, tarayıcıda ölçülmüş değerlerdir.

**Sıkıştırma mod 1 (metin korunur)** — 9.81 MB, 5 sayfalık taranmış belge:

| Kalite | Çıktı | Küçülme | Süre |
|---|---|---|---|
| 0.5 | 0.37 MB | %96 | 0.2 sn |
| 0.7 | 0.67 MB | %93 | 0.2 sn |
| 0.85 | 1.39 MB | %86 | 0.2 sn |

**Sıkıştırma mod 2 (görsele çevirme, metin kaybolur)** — aynı belge, 150 DPI:
9.81 MB → 3.53 MB, **%64** küçülme, metin tamamen kayboldu, 5 sayfa korundu.

> Not: spec'te mod 2 için "%85-95" yazıyordu. Gerçek ölçüm %64 çıktı ve spec
> düzeltildi. Fixture yüksek gürültülü sentetik bir görüntü — gerçek taranmış
> sözleşmelerde oran daha yüksek olacaktır. Kullanıcıya abartılı vaat verilmemeli.

---

## Nasıl çalıştırılır

```bash
cd kira-sozlesmesi-olusturucu
npm install                    # zaten kurulu
npx playwright install chromium # zaten kurulu
npm test                       # 62 test
```

Uygulamayı elle denemek için: `open index.html` → `PDF Araçları` sekmesi.

---

## Kalan işler

### Task 8 — Tema, duyarlılık, regresyon (yoksa yaklaşık 40 dakika)

Yazılacak testler:

| Test | Ne doğruluyor |
|---|---|
| T19 | Mevcut 5 sekme bozulmamış: sekmeye tıkla, form doldur, `#printable-area` değişsin, `handlePrint()` çalışsın |
| T21 | `data-theme="dark"` altında PDF paneli okunabilir (`--background` = `rgb(13, 17, 23)`) |
| T23 | 390 px genişlikte yatay kaydırma çubuğu yok |

Sonra `npx playwright test` ile tam koşu.

### Task 9 — README + canlıya alma (yoksa yaklaşık 30 dakika)

1. `README.md`: yeni özellik maddesi, geliştirici bölümü (`npm install && npx playwright install chromium && npm test`, `npm run sync-libs`).
2. Sıfırdan doğrulama: `rm -rf node_modules tests/fixtures/*.pdf` → `npm install` → `npm run sync-libs` → `npm test`. Depoya bağlı olduğunu kanıtlar.
3. `file://` ile elle doğrulama.
4. **Canlıya alma:** GitHub Pages bu depoyu `main` branch'inden, kökten servis ediyor (`.github/workflows` yok, "Deploy from a branch" modu).

   ```bash
   git checkout main
   git merge feature/pdf-araclari-sekmesi
   git push origin main
   ```

   ~1 dakika sonra `https://mertatis.github.io/avmertatis-kira-sozlesmesi-olusturucu/` güncellenir.
   Ek yapılandırma gerekmez. **Push yetkisi olup olmadığı henüz test edilmedi.**

5. Canlı doğrulama raporu: `Cmd+Shift+R` ile aç, 6 sekmeyi ve PDF aracını doğrula.

---

## Push yetkisi hakkında not

`gh` (GitHub CLI) bu makinede **kurulu değil** ve push kimlik bilgisi hiç
denenmedi. `git push` başarısız olursa tek yapılacak şey kimlik bilgisi
sağlamaktır — kod tarafında hiçbir engel yok.

---

## Dikkat edilmesi gereken kararlar

Bunlar tasarım sırasında verildi, kodda böyle. Birden fazla yerde geçiyor,
değiştirirsen tutarlılık bozulur.

| Konu | Karar | Neden |
|---|---|---|
| pdf.js sürümü | **3.11.174** (son UMD) | v4+ ESM-only; `file://` altında `<script type="module">` CORS ile engellenir ve README'deki "çift tıkla aç" yolu bozulur |
| CSP | Tek ekleme: `worker-src 'self' blob:;` | pdf.js gerçek worker'ı `blob:` URL ile oluşturuyor |
| A4 dönüşümü | `drawPage` + tekdüze `xScale`/`yScale` + açık `rotate` | Elle kurulan `cm` zinciri gerçek okuyucularda içeriği tamamen kaybettiriyordu |
| A4 dönüşümünde `/Rotate` | **Yazılmaz**, döndürme dönüşüme gömülür | Yazılsaydı içerik iki kez dönerdi |
| Sıkıştırma öncesi | `await doc.flush()` şart | Flush olmadan `PDFRef`'ler çözülemiyor, sıkıştırma sessizce hiçbir şey yapmıyordu |
| Sıkıştırma kapsamı | Form XObject'lerin **içi** de gezilir | A4 normalizasyonu her görseli Form içine gömer; aksi halde sıkıştırma hiçbir şey bulamaz |
| `getDocument` argümanı | `file.data.slice()` | pdf.js bayt dizisini transfer edip **ayırıyor**; ham dizi ikinci kullanımda bozuluyordu |
| Durum | `pdfState` ve `pdfBus` `window`'a açıkça atanıyor | Klasik script'te `const` window'a yazılmıyor |

---

## Kritik uyarılar

1. **Sıkıştırma mod 1, A4 normalizasyonu ile birlikte çalışır.** İkisi ayrı
   özellikler; A4 açıkken bile sıkıştırma %93 küçülme sağlıyor (A4 tek başına
   boyut nötrdür, 10.288.345 → 10.291.018 bayt). Bu, Task 5'te keşfedildi ve
   Form XObject içinde gezinmeyle çözüldü.

2. **Kayıp mod metni tamamen yok eder.** Hukuki belge için kullanılmamalı.
   Uygulama işlem başlamadan önce onay modalı gösteriyor ve iptal edilirse
   hiçbir dosya üretilmiyor.

3. **50 MB dosya sınırı** ayrıştırmadan önce uygulanıyor (60 MB dosya
   ayrıştırmak dakikalar sürüyor ve tarayıcıyı kilitliyor). Toplam sınır
   150 MB.

4. **Şifreli PDF'ler reddediliyor.** Parola kırma kapsam dışı (yasal risk).
   Mesayla kullanıcıya "Yazdır → PDF olarak kaydet" yolu gösteriliyor.

---

## Ledger

Uygulama sırasında verilen kararların tamamı, maliyetleriyle birlikte:
`.superpowers/sdd/2026-09-25-pdf-araclari-sekmesi/progress.md`

Bu dosya `.gitignore`'da (sscratch), commit geçmişinde yok. **Sonraki oturumda
kararları okumak için gerekirse silinip yeniden oluşturulabilir**; ancak en
önemli olanlar yukarıdaki tabloda özetlendi.

## Tasarım ve plan

- Spec: `docs/superpowers/specs/2026-09-25-pdf-araclari-sekmesi-design.md`
- Plan: `docs/superpowers/plans/2026-09-25-pdf-araclari-sekmesi.md`
