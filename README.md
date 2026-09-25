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

Kütüphaneler (`pdf-lib.min.js`, `pdf.min.js`, `pdf.worker.min.js`) depoda
bulunur ve ilk kullanımda tarayıcıya indirilir. İnternet bağlantısı olmadan da
her şey çalışır.

---

## 🧪 Geliştirici

Uygulamanın çalışma zamanı bağımlılığı yoktur. Aşağıdakiler yalnızca
**testler** içindir ve dağıtıma dahil edilmez:

```bash
npm install                      # geliştirme bağımlılıkları
npx playwright install chromium  # test tarayıcısı
npm run fixtures                 # test verilerini üret (tests/fixtures/*.pdf)
npm test                         # 73 test
```

Kütüphane dosyalarını `node_modules`'ten depoya yeniden kopyalamak için:

```bash
npm run sync-libs
```

> **Sürüm kısıtı:** PDF kütüphanesi **pdf.js 3.11.174** ile sabitlenmiştir.
> Bu, UMD derlemesi yayınlayan son sürümdür. Daha yeni sürümler yalnızca ESM
> modülü sunar ve `file://` üzerinden açıldığında tarayıcı tarafından engellenir;
> yukarıdaki "çift tıklayarak açın" kullanımı bozulur.

---

## 📜 Lisans

Bu proje **MIT Lisansı** ile lisanslanmıştır. Dilediğiniz gibi kullanabilir, özelleştirebilir veya büronuza uyarlayabilirsiniz.

Developed with ❤️ for Legal Tech Community.
