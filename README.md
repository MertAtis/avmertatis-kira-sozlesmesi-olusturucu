# ⚖️ Hukuki Kira Sözleşmesi & Tahliye Taahhüdü Oluşturucu (Açık Kaynak)

Avukatlar, hukuk büroları ve emlak profesyonelleri için geliştirilmiş, **%100 çevrimdışı (offline)** çalışan, sunucu veya veritabanı gerektirmeyen, **KVKK ve Meslek Sırrı Uyumlu** açık kaynak Kira Sözleşmesi ve Tahliye Taahhüdü jeneratörü.

---

## ✨ Özellikler

- **%100 Çevrimdışı & Güvenli**: Tüm veriler yalnızca tarayıcınızda işlenir. Hiçbir sunucuya veri gönderilmez, mesleki sır saklama yükümlülüğünüze tam uyumludur.
- **Canlı Önizleme**: Form alanlarını doldururken belge sağ tarafta anlık olarak matbu form düzeninde şekillenir.
- **Müteselsil Kefil Entegrasyonu**: Kefil eklendiğinde Yargıtay içtihatlarına uygun kefalet devamı ve müteselsil kefillik maddesi tek parçalı sola dayalı mizanpaj ile otomatik oluşturulur.
- **Dinamik Depozito (Güvence Bedeli)**: Depozito alındığında veya alınmadığında mevzuata uygun yasal maddeler otomatik eklenir.
- **Tahliye Taahhüdü Jeneratörü**: TBK m. 352/1 uyarınca antetsiz, doğrudan imzalatılabilir Tahliye Taahhüdü belgesi üretir.
- **Tek Tıkla PDF / Yazdır**: Tarayıcının yerel yazdırma motoru (`Ctrl+P` / `Cmd+P`) ile doğrudan A4 formatında çıktı almanızı veya PDF olarak kaydetmenizi sağlar.

### 🛠️ PDF Araçları Sekmesi

Uygulamadaki **PDF Araçları** sekmesi, tarayıcıda tamamen çalışan bir PDF
düzenleme setidir. Tüm işlemler yine yalnızca bu cihazda yapılır — dosyalar
hiçbir sunucuya gönderilmez.

| Yetenek | Açıklama |
|---|---|
| **Birleştirme** | Birden fazla PDF'yi tek dosyada birleştirir |
| **Sayfa silme / sıralama** | Küçük resimli ızgarada sürükle-bırak ile yeniden sıralama, tek tıkla silme |
| **Sayfa döndürme** | 90° / 180° / 270° döndürme, tüm sayfaları tek seferde döndürme |
| **A4'e sığdırma** | Her sayfayı **kırpmadan** ölçekleyip A4'e ortalar. A5/A6 belgeler baskıda okunur hale gelir |
| **Boyut küçültme (metin korunur)** | Gömülü görseller JPEG olarak yeniden kodlanır. **Metin seçilebilir ve aranabilir kalır** |
| **Boyut küçültme (görsele çevirme)** | Sayfaları 150 DPI görsele çevirir. En büyük küçülme, ancak **metin seçilemez** — uygulama işlem başlamadan önce onayınızı ister |
| **TIFF → PDF** | CCITT G3/G4, JPEG, LZW, Deflate, PackBits ve sıkıştırmasız TIFF'leri dış kütüphane olmadan PDF'e çevirir; görünüm libtiff ile birebir |
| **Fotoğraf (JPG/PNG) → PDF** | JPEG baytları olduğu gibi, PNG kayıpsız gömülür; EXIF yönü piksellere dokunmadan sayfaya uygulanır |
| **EK-1 / EK-2 bölmeleri** | Seçili sayfaları ayrı bölmelere taşır; çıktıda her bölmenin ilk sayfasına "EK-n" damgası vurulur |
| **Veraset İntikal Beyanname** | Boş beyanname formunu orijinal haliyle **kayıpsız indirir** ve A4 olarak yazdırır |
| **Geri Al** | Sayfa silme, sıralama ve döndürme adımları geri alınabilir (20 adım) |

**Ölçülen küçülme** (9,8 MB'lık 5 sayfalık taranmış bir belge üzerinde):

| Mod | Sonuç |
|---|---|
| Metin koruyan sıkıştırma (kalite 0,5 / 0,7 / 0,85) | %96 / %93 / %86 küçülme |
| Görsele çevirme (150 DPI) | %64 küçülme |

Görsele çevirme oranı belgeye göre değişir; metin ağırlıklı belgelerde
küçülme olmaz. Uygulama bu durumu saklamaz, sonuç kutusunda açıkça belirtir.

**Sınırlar:**

- Şifreli PDF'ler işlenemez. Parola kırma **desteklenmez**; PDF'yi bir okuyucuda
  açıp *Yazdır → PDF olarak kaydet* ile şifresiz kopyasını alıp tekrar deneyin.
- Tek dosya 50 MB, toplam 150 MB sınırı vardır (tarayıcı belleği nedeniyle).
- Çıktı PDF'leri şifrelenmez; parola koruması eklenmez.
- Var olan PDF metnini düzenleme, form doldurma ve dijital imza kapsam dışıdır.

---

## 🚀 Kullanım (Nasıl Çalıştırılır?)

Bu uygulamayı bilgisayarınızda çalıştırmak için **herhangi bir kurulum veya
yazılım (Node.js vb.) gerekmez**:

1. Bu depoyu zip olarak indirin veya git ile klonlayın:
   ```bash
   git clone https://github.com/MertAtis/avmertatis-kira-sozlesmesi-olusturucu.git
   ```
2. Klasör içindeki `index.html` dosyasına çift tıklayarak herhangi bir web
   tarayıcısında (Chrome, Edge, Safari, Firefox vb.) açın.
3. Belge üretmek için formu doldurun ve **Yazdır / PDF İndir** butonuna tıklayın.
4. PDF düzenlemek / birleştirmek / küçültmek için **PDF Araçları** sekmesini
   kullanın.

### 💾 Tek dosya olarak indir (internetsiz kullanım)

Sitede (veya klasörde) üstte **"Bilgisayara İndir (İnternetsiz)"**
düğmesine tıklayın: sitenin tamamını içeren **tek bir `tek-dosya.html`** dosyası
(~6,4 MB) iner. Bu dosyaya çift tıklayarak her aracı — PDF oluşturup
düzenlemekten veraset beyannamesi indirmeye — **internetsiz** çalıştırabilirsiniz.
Dosya kendi kendine yeterlidir: hiçbir kütüphane, yazı tipü veya belge dışarıdan
yüklenmez; gizlilik davranışı (veri gönderilmemesi, CSP) aynıdır.

Ayrıca geliştiriciler dosyayı kendileri üretebilir:

```bash
npm run tek-dosya    # tek-dosya.html yeniden üret (scripts/tek-dosya-olustur.mjs)
```

`tests/tek-dosya.spec.mjs`, üretilmiş dosyanın güncel üretimle AYNI olduğunu
(kayma yasak) ve file:// altında uçtan uca çalıştığını her koşuda doğrular.

Kütüphaneler (`pdf-lib.min.js`, `pdf.min.js`, `pdf.worker.min.js`) depoda
bulunur ve ilk kullanımda tarayıcıya indirilir. İnternet bağlantısı olmadan da
her şey çalışır.

---

## 🧪 Geliştirici

Uygulamanın çalışma zamanı bağımlılığı yoktur. Aşağıdakiler yalnızca
**testler** içindir ve dağıtıma dahil edilmez:

```bash
npm install                      # geliştirme bağımlılıkları (yalnız test)
npx playwright install chromium  # varsayılan test tarayıcısı
npm run fixtures                 # test verilerini üret (tests/fixtures/*.pdf)
npm test                         # tüm test paketi (Chromium)
```

Ek tarayıcı motorları (isteğe bağlı) — varsayılan Chromium'dur:

```bash
npx playwright install firefox webkit
PW_FIREFOX=1 npx playwright test --project=firefox
PW_WEBKIT=1  npx playwright test    # WebKit + iPhone 14
```

Testler gerçek `file://` protokolünü kullanır; yani README'de anlatılan
"`index.html`'e çift tıklayarak aç" yolu her koşuda doğrulanır.

Kütüphane dosyalarını `node_modules`'ten depoya yeniden kopyalamak için:

```bash
npm run sync-libs
```

> **Sürüm kısıtı:** PDF kütüphanesi **pdf.js 3.11.174** ile sabitlenmiştir.
> Bu, UMD derlemesi yayınlayan son sürümdür. Daha yeni sürümler yalnızca ESM
> modülü sunar ve `file://` üzerinden açıldığında tarayıcı tarafından engellenir;
> yukarıdaki "çift tıklayarak açın" kullanımı bozulur.

> **Bağımlılık güvenliği:** Geliştirme bağımlılıkları yalnız test ortamındadır
> ve dağıtılan dosyalara girmez. `package.json` içindeki `overrides`, geçişli
> `tar` sürümünü yamalı bir sürüme sabitler. `pdfjs-dist 3.11.174` bilinçli
> olarak sabittir (yukarıdaki UMD kısıtı); bu sürüme ait `npm audit` uyarısı
> tarayıcıda CSP (`script-src 'self'`, `'unsafe-eval'` yok) ile etkisizdir ve
> dağıtımı etkilemez. Depo ayrıca kök kütüphane ve `vendor/` dosyalarını
> SHA-256 ile sabitler (`tests/dependencies.spec.mjs`).

---

## 📜 Lisans

Bu proje **MIT Lisansı** ile lisanslanmıştır. Dilediğiniz gibi kullanabilir, özelleştirebilir veya büronuza uyarlayabilirsiniz.

Developed with ❤️ for Legal Tech Community.
