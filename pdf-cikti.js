/* =============================================================================
 * pdf-cikti.js — çıktı üretimi: birleştirme, A4 normalizasyonu, sıkıştırma
 *
 * Çıktı yalnızca "PDF Oluştur ve İndir" anında sıfırdan kurulur. Düzenleme
 * sırasında hiçbir pahalı iş yapılmaz; bu yüzden 300 sayfalık bir belgede
 * bile sıralama/döndürme anında tamamlanır.
 * ========================================================================== */

'use strict';

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

const RESULT_TEXT = {
    memory: 'Tarayıcı belleği tükendi. Daha küçük dosyalarla veya daha az sayfa seçerek deneyin.',
    generic: 'Çıktı üretilmedi, girdi dosyalarınız etkilenmedi.',
    noPages: 'İşlenecek sayfa yok. Önce en az bir PDF ekleyin.'
};

function pdfShowProgress(done, total, text) {
    const wrap = document.getElementById('pdf-progress-wrap');
    const bar = document.getElementById('pdf-progress-bar');
    const label = document.getElementById('pdf-progress-text');
    if (!wrap || !bar || !label) return;
    wrap.hidden = false;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    bar.style.width = `${percent}%`;
    label.textContent = text;
}

function pdfHideProgress() {
    const wrap = document.getElementById('pdf-progress-wrap');
    if (wrap) wrap.hidden = true;
}

function pdfShowResult(message, kind = 'info') {
    const box = document.getElementById('pdf-result');
    if (!box) return;
    box.hidden = false;
    box.classList.remove('is-warning', 'is-error');
    if (kind === 'warning') box.classList.add('is-warning');
    if (kind === 'error') box.classList.add('is-error');
    box.textContent = message;
}

function pdfHideResult() {
    const box = document.getElementById('pdf-result');
    if (box) box.hidden = true;
}

// --- A4 yerleştirme ---------------------------------------------------------

/**
 * Kaynak sayfayı A4'e ölçekleyip ortalanarak yerleştirir; içerik kırpılmaz.
 *
 * Döndürme ÖNCE uygulanmış sayfanın sınır kutusu üzerinden hesaplanır:
 * 90/270 derecede genişlik ve yükseklik yer değiştirir. Bu sıra ters
 * çevrilirse çift döndürme veya yanlış ölçek üretir.
 *
 * pdf-lib `drawPage` bir `PDFEmbeddedPage` ister ve `embedPage` asenkrondur.
 * `width`/`height` seçenekleri döndürmeyle birlikte çarpık çıktı üretir
 * (kaynak boyutlarını ayrı ayrı ölçekler), bu yüzden tekdüze `xScale`/`yScale`
 * ve açık `rotate` verilir.
 *
 * Dönüşüm matematiği `tests/verify-a4-rotation.mjs` ile sayısal olarak
 * doğrulanmıştır: dört dönüşme açısında da üç köşe işareti doğru köşeye düşer.
 */
async function pdfPlaceOnA4(targetDoc, srcPage, rotation) {
    const { width: w, height: h } = srcPage.getSize();
    const target = targetDoc.addPage([A4_WIDTH, A4_HEIGHT]);

    // Bozuk PDF'lerde MediaBox sıfır ya da geçersiz olabilir; ölçek NaN olur
    // ve bozuk çıktı yazılır. Böyle sayfalar boş A4 olarak bırakılır.
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 1 || h <= 1) {
        return target;
    }

    const quarterTurn = rotation === 90 || rotation === 270;
    const boxW = quarterTurn ? h : w;
    const boxH = quarterTurn ? w : h;
    const scale = Math.min(A4_WIDTH / boxW, A4_HEIGHT / boxH);

    const dx = (A4_WIDTH - boxW * scale) / 2;
    const dy = (A4_HEIGHT - boxH * scale) / 2;

    // Döndürülmüş içeriğin kapsayıcı kutusunun sol-alt köşesi (ölçekli birimler).
    // Dönen içeriğin YÜKSEKLİĞİ kaynak GENİŞLİĞİNDEN gelir.
    let minX = 0, minY = 0;
    if (rotation === 90) { minX = 0; minY = -w * scale; }
    else if (rotation === 180) { minX = -w * scale; minY = -h * scale; }
    else if (rotation === 270) { minX = -h * scale; minY = 0; }

    // İçerik akışı olmayan (tamamen boş) sayfalar gömülemez — pdf-lib
    // "missing Contents" hatası verir. Böyle sayfalar boş A4 olarak kalır.
    if (!srcPage.node.Contents()) {
        return target;
    }

    const embedded = await targetDoc.embedPage(srcPage);
    target.drawPage(embedded, {
        x: dx - minX,
        y: dy - minY,
        xScale: scale,
        yScale: scale,
        rotate: PDFLib.radians((-rotation * Math.PI) / 180)
    });
    return target;
}

// --- Çıktı kurulumu ---------------------------------------------------------

/**
 * pdfState.pages sırasına göre yeni bir belge kurar.
 * Dönüş: {bytes, originalSize, outputSize}
 */
/**
 * Kaynak sayfanın kendi /Rotate değeri ile kullanıcının eklediği döndürmeyi
 * toplar. İkisi ÜSTÜNE yazılmaz, toplanır: /Rotate 90 olan bir sayfaya bir kez
 * daha basıldığında sonuç 180 olmalıdır, 90 değil.
 *
 * Bu değer atlanırsa çıktı yanlış yönde basılır: küçük resimde pdf.js kaynak
 * /Rotate'u uygular (doğru görünür), çıktıda ise sayfa dik çıkar.
 */
function pdfEffectiveRotation(entry, file) {
    let source = 0;
    if (file?.doc) {
        const raw = file.doc.getPage(entry.srcIndex).node.get(PDFLib.PDFName.of('Rotate'));
        const value = Number(raw?.toString?.() ?? raw);
        if (Number.isFinite(value)) source = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
    }
    return (source + (entry.rotation || 0)) % 360;
}

async function pdfBuildOutput() {
    const entries = pdfState.pages;
    if (entries.length === 0) throw new Error(RESULT_TEXT.noPages);

    pdfSetBusy(true);
    pdfHideResult();

    try {
        // A1: 'Orijinal' boyutu SADECE çıktıya giren sayfaları içeren
        // dosyalardan hesaplanır ve dosya başına ORANLANIR: 5 sayfalık bir
        // dosyadan 1 sayfa çıktıya giriyorsa dosyanın tamamı sayılmaz. Aksi
        // halde kullanıcı sayfaları silmenin yarattığı %80'lik düşüşü
        // "sıkıştırma yaptım" sanar.
        const usedCounts = new Map();
        for (const entry of entries) {
            usedCounts.set(entry.fileId, (usedCounts.get(entry.fileId) || 0) + 1);
        }
        const originalSize = pdfState.files.reduce((sum, f) => {
            const used = usedCounts.get(f.id);
            if (!used) return sum;
            const total = f.pageCount || f.doc?.getPageCount?.() || used;
            return sum + Math.round((f.size || 0) * Math.min(1, used / total));
        }, 0);
        let compressReport = null;

        // Kayıp mod ÖNCE kontrol edilir: rasterizasyon kaynak PDF'leri doğrudan
        // okur, vektör kopyasına gerek yoktur. Aksi halde 300 sayfalık belgede
        // hem vektör kopya hem JPEG'ler hem ikinci belge bellekte tutulur.
        if (pdfState.output.lossy) {
            const bytes = await pdfRasterizeToOutput(entries, pdfState.output.quality);
            return { bytes, originalSize, outputSize: bytes.length };
        }

        const doc = await PDFLib.PDFDocument.create();
        let count = 0;

        for (const entry of entries) {
            const file = pdfState.files.find((f) => f.id === entry.fileId);
            if (!file || !file.doc) continue;

            const [copied] = await doc.copyPages(file.doc, [entry.srcIndex]);
            // pdf-lib copyPages /Rotate'u korur; A4 dönüşümü kendi matrisinde
            // uygulayacağı için burada temizlenir, yoksa çift döner.
            const rotation = pdfEffectiveRotation(entry, file);
            copied.node.delete(PDFLib.PDFName.of('Rotate'));

            if (pdfState.output.a4) {
                const isExactA4 = !rotation
                    && Math.abs(copied.getWidth() - A4_WIDTH) < 1
                    && Math.abs(copied.getHeight() - A4_HEIGHT) < 1;
                if (isExactA4) {
                    // Zaten tam A4 ve döndürülmemiş: gereksiz yeniden ölçekleme yapma.
                    doc.addPage(copied);
                } else {
                    // A4 modunda döndürme dönüşüme gömülür; /Rotate yazılmaz.
                    // Yazılsaydı içerik iki kez dönerdi.
                    await pdfPlaceOnA4(doc, copied, rotation);
                }
            } else {
                // Dönüşüm uygulanmadığında /Rotate yazılır (kaynak + kullanıcı).
                if (rotation) copied.setRotation(PDFLib.degrees(rotation));
                doc.addPage(copied);
            }

            count++;
            pdfShowProgress(count, entries.length, `Sayfa ${count} / ${entries.length}`);
            // Tarayıcının nefes alması için zaman bırak; 300 sayfalık belgede
            // arayüz donmamalı.
            if (count % 4 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        doc.setTitle('PDF Araçları ile oluşturuldu');
        doc.setProducer('PDF Araçları (kira-sozlesmesi-olusturucu)');

        // Sıkıştırma modu 1: gömülü görselleri JPEG olarak yeniden kodlar,
        // metin ve vektör içerik olduğu gibi kalır.
        if (pdfState.output.compress) {
            // flush() nesneleri context'e kaydeder. Bu olmadan sayfa
            // kaynaklarındaki PDFRef'ler çözülemiyor ve sıkıştırma hiçbir
            // görseli bulamadan sessizce başarısız oluyor.
            await doc.flush();
            const { replaced, skipped } = await pdfCompressImages(doc, pdfState.output.quality);
            pdfShowProgress(entries.length, entries.length,
                `${replaced} görsel yeniden kodlandı`);
            compressReport = { replaced, skipped };
        }

        const bytes = await doc.save({ useObjectStreams: true });
        return { bytes, originalSize, outputSize: bytes.length, compressReport };
    } catch (err) {
        console.error('Çıktı üretilemedi', err);
        throw err;
    } finally {
        pdfSetBusy(false);
        pdfHideProgress();
    }
}

// --- İndirme ---------------------------------------------------------------

/** Tarayıcı indirme adında '/' ve yol ayırıcıları geçersizdir. */
/** Tarayici indirme adinda yol ayiraclari ve kontrol karakterleri gecersizdir. */
function pdfSafeFileName(name) {
    const base = String(name || '').split(/[\\/]/).pop();
    const cleaned = base
        .replace(/[\\:*?"<>|]/g, '_')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        // Windows sondaki nokta ve boşluğu sessizce düşürür; uzantı kaybolur.
        .replace(/[. ]+$/, '')
        .trim();
    // Tamamen nokta olan ad ('.', '..') geçerli bir dosya adı değildir.
    if (!cleaned || /^[.]+$/.test(cleaned)) return 'belge.pdf';
    return cleaned;
}

/** Tek dosya indiriliyorsa adi korunur, birden fazlasi birlestirilmis ad alir. */
function pdfOutputFileName() {
    const names = pdfState.files.filter((f) => f.doc);
    if (names.length === 1) return pdfSafeFileName(names[0].name);
    return 'birlesmis-belge.pdf';
}

function pdfTriggerDownload(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = pdfSafeFileName(fileName || pdfOutputFileName());
    document.body.appendChild(link);
    link.click();
    // Baglanti, tiklama ayni gorevde kaldirilirsa Chromium indirmeyi iptal
    // edebiliyor. Bir sonraki goreve birakilip sonra temizlenir.
    setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
    }, 10000);
}

/**
 * Atlanan görsel varsa kısa ve dürüst bir not. Kullanıcı hangi biçimin
 * desteklenmediğini görebilmeli (destek eklenebilsin diye).
 */
function pdfSkipNote(report) {
    if (!report || report.skipped.length === 0) return '';
    const reasons = [...new Set(report.skipped.map((s) => s.reason))];
    return ` Not: ${report.skipped.length} görsel küçültülemedi (${reasons.join(', ')}).`;
}

// --- Kayıp mod onayı --------------------------------------------------------

// Modal bir Promise ile çözülür: onaylanırsa true, vazgeçilirse false.
// Modal açıkken ikinci bir çağrı YENİ soru üretmemeli: mevcut Promise
// döndürülür. Aksi halde tek onay tıklaması birden çok çıktı üretir.
let pdfLossyPrompt = null;

function pdfConfirmLossy() {
    if (pdfLossyPrompt) return pdfLossyPrompt;

    const modal = document.getElementById('pdf-lossy-modal');
    if (!modal) return Promise.resolve(window.confirm('Metin seçilemez hale gelecek. Devam edilsin mi?'));

    const cancel = document.getElementById('pdf-lossy-cancel');
    const confirmBtn = document.getElementById('pdf-lossy-confirm');
    const previouslyFocused = document.activeElement;
    // A6: arka plan odaklanabilir kalmasın. Modal `.app-grid` İÇİNDE olduğu
    // için inert uygulanacak düğüm modalın kendisi değil, onun dışındaki
    // kardeşler + sekme çubuğu olmalıdır; aksi halde modal da inert olur ve
    // hiçbir buton tıklanamaz.
    const background = [];
    const appGrid = modal.closest('.app-grid');
    appGrid?.querySelectorAll(':scope > *').forEach((el) => {
        if (el !== modal && !el.contains(modal)) background.push(el);
    });
    const tabBar = document.querySelector('.tab-bar, .tabs, nav');
    if (tabBar && !modal.contains(tabBar) && !tabBar.contains(modal)) background.push(tabBar);

    modal.hidden = false;
    background.forEach((el) => {
        el.setAttribute('inert', '');
        el.setAttribute('aria-hidden', 'true');
    });
    confirmBtn?.focus();

    pdfLossyPrompt = new Promise((resolve) => {
        const finish = (answer) => {
            modal.hidden = true;
            background.forEach((el) => {
                el.removeAttribute('inert');
                el.removeAttribute('aria-hidden');
            });
            cancel?.removeEventListener('click', onCancel);
            confirmBtn?.removeEventListener('click', onConfirm);
            document.removeEventListener('keydown', onKey);
            pdfLossyPrompt = null;
            if (previouslyFocused?.focus) previouslyFocused.focus();
            resolve(answer);
        };
        const onCancel = () => finish(false);
        const onConfirm = () => finish(true);
        const onKey = (e) => {
            if (e.key === 'Escape') { finish(false); return; }
            // A6: odak tuzağı — Tab yalnızca iki buton arasında döner.
            if (e.key === 'Tab') {
                const first = cancel;
                const last = confirmBtn;
                if (!first || !last) return;
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault(); last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault(); first.focus();
                }
            }
        };
        cancel?.addEventListener('click', onCancel);
        confirmBtn?.addEventListener('click', onConfirm);
        document.addEventListener('keydown', onKey);
    });

    return pdfLossyPrompt;
}

// A5: `pdfState.busy` yalnızca build sırasında doğrudur. Kayıp mod onayı
// beklerken 5 eşzamanlı çağrı busy'ı boş bulup hepsi onaya gider, onay
// çözülünce 5 indirme olurdu. Onayı da kapsayan ayrı bir kilit gerekir.
let pdfBuildLock = false;

async function pdfOnBuildClick() {
    // Çift tıklama iki çıktı üretmesin.
    if (pdfState.busy || pdfBuildLock) return;
    if (pdfState.pages.length === 0) {
        pdfShowResult(RESULT_TEXT.noPages, 'warning');
        return;
    }

    // Kayıp modda her sayfa A4'e çizilir; A4 kapalıysa kullanıcıyı uyar.
    if (pdfState.output.lossy && !pdfState.output.a4) {
        pdfShowResult(
            'Görsele çevirme her zaman A4 sayfası üretir. '
            + 'Lütfen "Her sayfayı A4\'e sığdır" seçeneğini açın.',
            'error'
        );
        return;
    }

    // Metin seçilemez hale geleceği için önce onay alınır.
    if (pdfState.output.lossy) {
        pdfBuildLock = true;
        const ok = await pdfConfirmLossy();
        pdfBuildLock = false;
        if (!ok) return;
    }

    try {
        const { bytes, originalSize, outputSize, compressReport } = await pdfBuildOutput();
        pdfTriggerDownload(bytes, pdfOutputFileName());

        const head = `Orijinal ${pdfFormatBytes(originalSize)} → Çıktı ${pdfFormatBytes(outputSize)}`;
        // Sıkıştırma kapalıyken küçülme de olsa bu ipucu gösterilir: A4'e
        // sığdırma tek başına küçülme yaratabilir ve kullanıcı bunu
        // sıkıştırmanın işi sanmasın.
        const compressOffNote = pdfState.output.compress
            ? ''
            : ' Sıkıştırma seçeneği kapalıydı; görselleri küçültmek için '
                + '"Boyutu küçült" kutusunu işaretleyin.';

        if (outputSize < originalSize) {
            const saved = Math.round((1 - outputSize / originalSize) * 100);
            pdfShowResult(
                `${head} (%${saved} küçüldü)`
                + (pdfState.output.lossy ? ' — Metin seçilemez.' : '')
                + pdfSkipNote(compressReport)
                + compressOffNote
            );
            return;
        }

        // Küçülme olmadı. NEDENİ dürüstçe söylemek zorundayız; "zaten optimize"
        // demek, görsellerin atlanmış olduğu durumlarda yanlış bilgidir.
        if (!pdfState.output.compress) {
            pdfShowResult(`${head}.${compressOffNote}`, 'warning');
        } else if (compressReport && compressReport.skipped.length > 0) {
            // Nedenleri tek tek yaz: "desteklenmeyen biçim" genel bir ifadedir,
            // kullanıcı hangi biçimin eksik olduğunu göremez.
            const reasons = [...new Set(compressReport.skipped.map((s) => s.reason))];
            pdfShowResult(
                `${head}. ${compressReport.replaced} görsel yeniden kodlandı, `
                + `ancak ${compressReport.skipped.length} görsel küçültülemedi `
                + `(${reasons.join(', ')}).`,
                'warning'
            );
        } else {
            pdfShowResult(
                'Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.',
                'warning'
            );
        }
    } catch (err) {
        const message = pdfIsMemoryError(err?.message)
            ? RESULT_TEXT.memory
            : (err?.message === RESULT_TEXT.noPages ? RESULT_TEXT.noPages : RESULT_TEXT.generic);
        pdfShowResult(message, 'error');
    }
}

// --- Sıkıştırma mod 1: gömülü görselleri yeniden kodlama -------------------

// spec §5.1 atlama kuralları. Hepsi sağlanmazsa görsel atlanır.
const MIN_RECODE_BYTES = 20 * 1024;

/**
 * Sayfadaki /Image XObject'lerini JPEG olarak yeniden kodlar.
 * Sayfa içerik akışı ve yazı tipleri olduğu gibi kalır — metin seçilebilir
 * ve aranabilir olmaya devam eder. Dönüş: yeniden kodlanan görsel sayısı.
 *
 * Form XObject'lerin İÇİ de gezilir. Bu zorunludur: A4 normalizasyonu
 * (varsayılan açık) her sayfayı bir Form XObject içine gömer, dolayısıyla
 * yalnızca sayfa düzeyine bakıldığında HİÇBİR görsel bulunamaz ve sıkıştırma
 * sessizce hiçbir iş yapmaz.
 *
 * Doğrulanmış pdf-lib 1.17.1 API notları:
 *  - `page.node.Resources` bir ÖZELLİK değil METOTtur: `page.node.Resources()`
 *  - `/XObject` değeri bir PDFRef'tir; `lookupMaybe(PDFName.of('XObject'), PDFDict)`
 *    ve sonra `lookup(key)` ile çözülür
 *  - `xobj.contents` doğrudan atanabilir; `save()` sırasında serileştirilir,
 *    yeni PDFRef kaydı gerekmez
 *  - `PDFRawStream.of` imzası `(dict, contents)` sırasındadır (burada gerekmiyor)
 */
async function pdfCompressImages(doc, quality) {
    const { PDFName, PDFDict, PDFArray } = PDFLib;
    let replaced = 0;
    const skipped = [];

    // PDFDict.get() bir PDFRef döndürür. Bellekteki bir referansı
    // PDFDict.lookup() çözemeyebilir (flush() sonrası çalışır); bu yüzden
    // daima context.lookup() kullanılır.
    const resolve = (value) => (value && value.tag ? doc.context.lookup(value) : value);

    // DİKKAT: PDFDict'in `.dict` ÖZELLİĞİ içteki Map'tir, sözlük değildir.
    // Yalnızca AKIŞ nesnelerinde (contents'ı vardır) .dict sözlüktür.
    const asDict = (obj) => (obj && obj.contents ? obj.dict : obj);

    // Form XObject'ler birbirine gömülü olabilir; döngüsel referansları
    // önlemek için işlenmiş nesneler bir Set ile izlenir.
    const visited = new Set();

    const visitResources = async (resources, path, host) => {
        const res = asDict(resolve(resources));
        if (!res || typeof res.lookupMaybe !== 'function') return;

        // 1) Doğrudan /XObject ve Form XObject'lerin içi
        // DİKKAT: asDict() bir AKIŞı sözlüğüne çevirir. Çevirdikten sonra
        // `.dict` almak içteki Map'i verir ve `lookup` çalışmaz — bu hata
        // tüm sıkıştırmayı sessizce bozuyordu.
        const xoDict = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (xoDict) {
            for (const key of xoDict.keys()) {
                const stream = resolve(xoDict.get(key));
                if (!stream || !stream.contents) continue;
                if (visited.has(stream)) continue;
                visited.add(stream);
                const dict = stream.dict;

                const subtype = String(dict.lookup(PDFName.of('Subtype')) ?? '');
                if (subtype === '/Form') {
                    await visitResources(dict.lookup(PDFName.of('Resources')), `${path}/${key}`, null);
                } else if (subtype === '/Image') {
                    const outcome = await pdfRecodeImage(stream, quality);
                    if (outcome === 'ok') replaced++;
                    else skipped.push({ path: `${path}/${key}`, reason: outcome });
                }
            }
        }

        // 2) /Annots -> /AP -> /N  (onay damgası, kaşe, imza görselleri)
        // /Annots SAYFA sözlüğünde durur; bu yüzden çağıran, sayfa sözlüğünü
        // `host` olarak verir.
        const hostDict = asDict(resolve(host));
        const annots = hostDict ? hostDict.lookupMaybe(PDFName.of('Annots'), PDFArray) : null;
        if (annots) {
            for (let i = 0; i < annots.size(); i++) {
                const annotDict = asDict(resolve(annots.lookup(i)));
                if (!annotDict || typeof annotDict.lookup !== 'function') continue;
                const ap = asDict(resolve(annotDict.lookup(PDFName.of('AP'))));
                if (!ap || typeof ap.lookup !== 'function') continue;
                // /AP /N bir AKIŞTIR; /Resources onun sözlüğündedir.
                const normal = asDict(resolve(ap.lookup(PDFName.of('N'))));
                if (normal && typeof normal.lookup === 'function') {
                    await visitResources(normal.lookup(PDFName.of('Resources')), `${path}/annot${i}/AP/N`, null);
                }
            }
        }

        // 3) /Pattern -> painter -> /Resources (kaplama desenleri)
        const patterns = res.lookupMaybe(PDFName.of('Pattern'), PDFDict);
        if (patterns) {
            for (const key of patterns.keys()) {
                const patDict = asDict(resolve(patterns.get(key)));
                if (!patDict || typeof patDict.lookup !== 'function') continue;
                const patternType = String(patDict.lookup(PDFName.of('PatternType')) ?? '').replace(/^\//, '');
                if (patternType === '1') {
                    await visitResources(patDict.lookup(PDFName.of('Resources')), `${path}/pattern${key}`, null);
                }
            }
        }
    };

    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
        await visitResources(pages[i].node.Resources(), `p${i + 1}`, pages[i].node);
    }

    return { replaced, skipped };
}

/**
 * Tek bir görseli yeniden kodlar.
 * Dönüş: 'ok' | <atlanma nedeni>. Neden, dürüst kullanıcı mesajı için saklanır.
 */
async function pdfRecodeImage(xobj, quality) {
    const { PDFName, PDFArray } = PDFLib;
    const dict = xobj.dict;

    const bits = Number(dict.lookup(PDFName.of('BitsPerComponent')));
    const filter = dict.lookup(PDFName.of('Filter'));
    const width = Number(dict.lookup(PDFName.of('Width')));
    const height = Number(dict.lookup(PDFName.of('Height')));

    if (bits !== 8) return 'bit derinliği desteklenmiyor';
    if (filter && String(filter) === '/DCTDecode') return 'zaten JPEG';
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return 'geçersiz ölçü';
    }
    // Şeffaflık maskesi olan görseller atlanır: alfa kanalı yeniden kodlamayla
    // bozulabilir. Bu bilinçli bir sınırdır, kullanıcıya bildirilir.
    if (dict.has(PDFName.of('SMask'))) return 'şeffaflık maskesi olan görsel';

    const raw = xobj.contents;
    if (!raw || raw.length < MIN_RECODE_BYTES) return 'çok küçük';

    try {
        const { pixels, channels } = await pdfDecodePixels(xobj, bits, width, height);
        if (!pixels) return 'renk uzayı desteklenmiyor';

        // /Decode [1 0] ters çevirme belirtir. Yeniden kodlanan görsel de aynı
        // /Decode ile yazıldığı için görünüm korunur; pikselleri ters çevirmiyoruz.
        const jpeg = await pdfEncodeJpeg(pixels, width, height, quality);
        xobj.contents = jpeg;
        dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        dict.delete(PDFName.of('DecodeParms'));
        return 'ok';
    } catch (err) {
        console.warn('Görsel yeniden kodlanamadı, atlandı:', err);
        return 'çözülemedi';
    }
}

/**
 * Gömülü pikselleri RGBA'ya çözer.
 * Desteklenen renk uzayları: DeviceRGB, DeviceGray, ICCBased(3/1 kanal),
 * Indexed, DeviceCMYK. Desteklenmeyen durumda null döner.
 */
async function pdfDecodePixels(xobj, bits, width, height) {
    const { PDFName } = PDFLib;
    const dict = xobj.dict;
    const cs = dict.lookup(PDFName.of('ColorSpace'));

    let palette = null;
    let channels = 3;
    // PİKSEL BAŞINA bayt sayısı. Indexed'da ham veri palet İNDİKSİ
    // olduğu için her zaman 1 bayttır; `channels` paletin kaç renkli
    // olduğunu anlatır, ham verinin uzunluğunu değil.
    let sampleBytes = 3;

    const name = (value) => (value && value.asString
        ? '/' + value.decodeText().replace(/^\//, '')
        : String(value ?? ''));

    if (cs && typeof cs.lookupMaybe === 'function') {
        // Dizi biçimli: [/ICCBased N 0 R], [/Indexed base hival palette]
        const head = name(cs.lookup(0));
        if (head === '/ICCBased') {
            const profile = xobj.doc?.context?.lookup(cs.lookup(1));
            const n = profile?.dict ? Number(profile.dict.lookup(PDFName.of('N'))) : 3;
            if (n !== 3 && n !== 1) return { pixels: null };
            channels = n;
            sampleBytes = n;
        } else if (head === '/Indexed') {
            const base = name(cs.lookup(1));
            channels = base === '/DeviceGray' ? 1 : 3;
            sampleBytes = 1;
            const hival = Number(cs.lookup(2));
            // Palet bir akıştır. pdf-lib'de bayt dizisi `asUint8Array()`
            // ile alınır (`asBytes` diye bir metot YOKTUR); ham `contents`
            // alanı da aynı diziyi verir.
            const look = cs.lookup(3);
            const bytes = look
                ? (typeof look.asUint8Array === 'function'
                    ? look.asUint8Array()
                    : (look.contents instanceof Uint8Array ? look.contents : null))
                : null;
            if (!bytes || !bytes.length) return { pixels: null };
            palette = { bytes, hival, channels };
        } else if (head === '/Separation' || head === '/DeviceN') {
            return { pixels: null };
        }
    } else {
        const simple = name(cs);
        if (simple === '/DeviceGray') { channels = 1; sampleBytes = 1; }
        else if (simple === '/DeviceRGB' || simple === '/ICCBased') { channels = 3; sampleBytes = 3; }
        else if (simple === '/DeviceCMYK') return { pixels: null };
        else return { pixels: null };
    }

    const expected = width * height * sampleBytes;
    const raw = await pdfInflate(xobj.contents, expected);
    if (!raw || raw.length < expected) return { pixels: null };

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++) {
        let r, g, b;
        if (palette) {
            const index = raw[i];
            if (index > palette.hival) return { pixels: null };
            const base0 = index * palette.channels;
            if (palette.channels === 1) { r = g = b = palette.bytes[base0]; }
            else { r = palette.bytes[base0]; g = palette.bytes[base0 + 1]; b = palette.bytes[base0 + 2]; }
        } else if (channels === 1) {
            r = g = b = raw[i];
        } else {
            r = raw[i * 3]; g = raw[i * 3 + 1]; b = raw[i * 3 + 2];
        }
        rgba[j++] = r; rgba[j++] = g; rgba[j++] = b; rgba[j++] = 255;
    }
    return { pixels: rgba, channels };
}

/** RGBA pikselleri JPEG olarak kodlar. */
async function pdfEncodeJpeg(rgba, width, height, quality) {
    const canvas = window.OffscreenCanvas
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas bağlamı alınamadı');
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
}

/** zlib (FlateDecode) çözer. Tarayıcıda DecompressionStream kullanılır. */
async function pdfInflate(data, expectedLength) {
    if (typeof DecompressionStream === 'function') {
        const stream = new Blob([data]).stream()
            .pipeThrough(new DecompressionStream('deflate'));
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (expectedLength && out.length !== expectedLength) {
            throw new Error(`Beklenen ${expectedLength} bayt, çözülen ${out.length}`);
        }
        return out;
    }
    // DecompressionStream yoksa (çok eski tarayıcı) çözümleme yapılamaz;
    // görsel atlanır, çıktı yine de üretilir.
    throw new Error('DecompressionStream desteklenmiyor');
}

// --- Kayıp mod: görsele çevirme -------------------------------------------

const RASTER_DPI = 150;

/**
 * Sayfaları 150 DPI çözünürlükte görsele çevirip A4'e basar.
 * Sonuçta metin seçilemez — bu yüzden çağırmadan önce onay alınır.
 *
 * Her sayfa kendi pdf.js belgesinden render edilir; kaynak belgeler
 * bellekte zaten açık olduğu için yeniden açılmaz.
 */
async function pdfRasterizeToOutput(entries, quality) {
    await pdfEnsureWorker();
    const out = await PDFLib.PDFDocument.create();
    const scale = RASTER_DPI / 72;
    let done = 0;

    let failed = 0;
    const failures = [];

    for (const entry of entries) {
        const file = pdfState.files.find((f) => f.id === entry.fileId);
        if (!file || !file.data) continue;

        // A8: tek sayfanın hatası TÜM işi çöpe atmamalı. Kullanıcı 300
        // sayfalık belgede 250. sayfada hata alıp 10 dakikalık emeğini
        // kaybetmemeli.
        let canvas = null;
        try {
            const source = await pdfGetDoc(file);
            const page = await source.getPage(entry.srcIndex + 1);
            // pdf.js 3.x'te `page.rotate` salt okunurdur; döndürme viewport
            // ve render seçenekleriyle verilir.
            const rotation = pdfEffectiveRotation(entry, file);
            const viewport = page.getViewport({ scale, rotation });

            canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context, viewport, rotation }).promise;

            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (!blob) throw new Error('Görsele çevirilemedi');

            const jpeg = new Uint8Array(await blob.arrayBuffer());
            const embedded = await out.embedJpg(jpeg);
            const target = out.addPage([A4_WIDTH, A4_HEIGHT]);

            // Döndürülmüş sayfa yatay gelir; A4'e tekdüze sığdırıp ortala.
            const ratio = Math.min(A4_WIDTH / embedded.width, A4_HEIGHT / embedded.height);
            const w = embedded.width * ratio;
            const h = embedded.height * ratio;
            target.drawImage(embedded, {
                x: (A4_WIDTH - w) / 2,
                y: (A4_HEIGHT - h) / 2,
                width: w,
                height: h
            });

            done++;
            pdfShowProgress(done, entries.length, `Sayfa ${done} / ${entries.length} görsele çevriliyor`);
        } catch (err) {
            // Sayfa atlanır, işlem sürer.
            failed++;
            failures.push(entry.srcIndex + 1);
            console.warn('Sayfa görsele çevrilemedi (atlandı):', err);
        } finally {
            // Canvas belleği serbest bırakılır; hata olsa da.
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            if (done % 2 === 0) await new Promise((r) => setTimeout(r, 0));
        }
    }

    if (done === 0) throw new Error('Hiçbir sayfa görsele çevrilemedi.');

    if (failed > 0) {
        pdfShowResult(
            `${failed} sayfa görsele çevrilemedi ve atlandı `
            + `(sayfa ${failures.slice(0, 10).join(', ')}${failures.length > 10 ? '…' : ''}). `
            + 'Dosya yine de oluşturuldu.',
            'warning'
        );
    }

    out.setTitle('PDF Araçları ile oluşturuldu (görsele çevrilmiş)');
    out.setProducer('PDF Araçları (kira-sozlesmesi-olusturucu)');
    return out.save({ useObjectStreams: true });
}

// --- Bağlantılar -----------------------------------------------------------

function pdfSyncOutputState() {
    const compress = document.getElementById('pdf-opt-compress');
    const options = document.getElementById('pdf-compress-options');
    if (options && compress) options.hidden = !compress.checked;
}

function pdfReadOutputState() {
    const lossy = document.getElementById('pdf-opt-lossy');
    const quality = document.querySelector('input[name="pdf-quality"]:checked');
    pdfState.output = {
        a4: document.getElementById('pdf-opt-a4')?.checked ?? true,
        compress: document.getElementById('pdf-opt-compress')?.checked ?? false,
        lossy: lossy?.checked ?? false,
        quality: quality ? Number(quality.value) : 0.7
    };
    pdfSyncOutputState();
}

function pdfUpdateBuildButton() {
    const bar = document.getElementById('pdf-action-bar');
    const button = document.getElementById('pdf-build-btn');
    const hasPages = pdfState.pages.length > 0;
    // Aksiyon çubuğu yalnızca işlenecek sayfa varken görünür.
    if (bar) bar.hidden = !hasPages;
    if (button) button.disabled = !hasPages || pdfState.busy;
}

(function initPdfOutput() {
    document.getElementById('pdf-opt-compress')?.addEventListener('change', () => {
        pdfReadOutputState();
        pdfSyncOutputState();
    });
    for (const id of ['#pdf-opt-a4', '#pdf-opt-lossy']) {
        document.querySelector(id)?.addEventListener('change', pdfReadOutputState);
    }
    document.querySelectorAll('input[name="pdf-quality"]').forEach((el) => {
        el.addEventListener('change', pdfReadOutputState);
    });

    document.getElementById('pdf-build-btn')?.addEventListener('click', pdfOnBuildClick);
    pdfBus.on('pages', pdfUpdateBuildButton);
    pdfBus.on('busy', pdfUpdateBuildButton);
    pdfReadOutputState();
    pdfUpdateBuildButton();
})();

window.pdfBuildOutput = pdfBuildOutput;
window.pdfPlaceOnA4 = pdfPlaceOnA4;
window.pdfRasterizeToOutput = pdfRasterizeToOutput;
window.pdfCompressImages = pdfCompressImages;
window.pdfTriggerDownload = pdfTriggerDownload;
window.pdfSafeFileName = pdfSafeFileName;
window.pdfShowResult = pdfShowResult;
