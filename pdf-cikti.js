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
async function pdfBuildOutput() {
    const entries = pdfState.pages;
    if (entries.length === 0) throw new Error(RESULT_TEXT.noPages);

    pdfSetBusy(true);
    pdfHideResult();

    try {
        const originalSize = pdfState.files.reduce((sum, f) => sum + (f.size || 0), 0);
        const doc = await PDFLib.PDFDocument.create();
        let count = 0;

        for (const entry of entries) {
            const file = pdfState.files.find((f) => f.id === entry.fileId);
            if (!file || !file.doc) continue;

            const [copied] = await doc.copyPages(file.doc, [entry.srcIndex]);

            if (pdfState.output.a4) {
                const isExactA4 = !entry.rotation
                    && Math.abs(copied.getWidth() - A4_WIDTH) < 1
                    && Math.abs(copied.getHeight() - A4_HEIGHT) < 1;
                if (isExactA4) {
                    // Zaten tam A4 ve döndürülmemiş: gereksiz yeniden ölçekleme yapma.
                    doc.addPage(copied);
                } else {
                    // A4 modunda döndürme dönüşüme gömülür; /Rotate yazılmaz.
                    // Yazılsaydı içerik iki kez dönerdi.
                    await pdfPlaceOnA4(doc, copied, entry.rotation);
                }
            } else {
                // Dönüşüm uygulanmadığında /Rotate korunur.
                if (entry.rotation) copied.setRotation(PDFLib.degrees(entry.rotation));
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

        // Sıkıştırma modu 1 (Task 6) pdfCompressImages ile sağlanır; o modül
        // yüklenmemişse sıkıştırma atlanır (çıktı yine de üretilir).
        if (pdfState.output.compress && !pdfState.output.lossy) {
            // flush() nesneleri context'e kaydeder. Bu olmadan sayfa
            // kaynaklarındaki PDFRef'ler çözülemiyor ve sıkıştırma hiçbir
            // görseli bulamadan sessizce başarısız oluyor.
            await doc.flush();
            const replaced = await pdfCompressImages(doc, pdfState.output.quality);
            pdfShowProgress(entries.length, entries.length,
                `${replaced} görsel yeniden kodlandı`);
        }

        const bytes = await doc.save({ useObjectStreams: true });
        return { bytes, originalSize, outputSize: bytes.length };
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
    return base.replace(/[\\:*?"<>|]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '_').trim() || 'belge.pdf';
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

async function pdfOnBuildClick() {
    if (pdfState.pages.length === 0) {
        pdfShowResult(RESULT_TEXT.noPages, 'warning');
        return;
    }
    try {
        const { bytes, originalSize, outputSize } = await pdfBuildOutput();
        pdfTriggerDownload(bytes, pdfOutputFileName());

        if (outputSize >= originalSize) {
            pdfShowResult(
                'Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.',
                'warning'
            );
        } else {
            const saved = Math.round((1 - outputSize / originalSize) * 100);
            pdfShowResult(
                `Orijinal ${pdfFormatBytes(originalSize)} → Çıktı ${pdfFormatBytes(outputSize)} (%${saved} küçüldü)`
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
    const { PDFName, PDFDict } = PDFLib;
    let replaced = 0;

    // PDFDict.get() bir PDFRef döndürür. Bellekteki bir referansı
    // PDFDict.lookup() çözemeyebilir (save() çağrıldıktan sonra çalışır);
    // bu yüzden daima context.lookup() kullanılır.
    const resolve = (value) => (value && value.tag ? doc.context.lookup(value) : value);

    // Form XObject'ler birbirine gömülü olabilir; döngüsel referansları
    // önlemek için işlenmiş nesneler bir Set ile izlenir.
    const visited = new Set();

    const visitResources = async (resources) => {
        const resDict = resolve(resources);
        if (!resDict || typeof resDict.lookupMaybe !== 'function') return;
        const xoDict = resDict.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (!xoDict) return;

        for (const key of xoDict.keys()) {
            const xobj = resolve(xoDict.get(key));
            if (!xobj || !xobj.dict) continue;
            if (visited.has(xobj)) continue;
            visited.add(xobj);

            const subtype = String(xobj.dict.lookup(PDFName.of('Subtype')) ?? '');
            if (subtype === '/Form') {
                await visitResources(resolve(xobj.dict.lookup(PDFName.of('Resources'))));
                continue;
            }
            if (subtype !== '/Image') continue;

            if (await pdfRecodeImage(xobj, quality)) replaced++;
        }
    };

    for (const page of doc.getPages()) {
        await visitResources(resolve(page.node.Resources()));
    }

    return replaced;
}

/** Tek bir görseli yeniden kodlar. Uygun değilse false döner. */
async function pdfRecodeImage(xobj, quality) {
    const { PDFName } = PDFLib;
    const dict = xobj.dict;

    const bits = Number(dict.lookup(PDFName.of('BitsPerComponent')));
    const colorSpace = String(dict.lookup(PDFName.of('ColorSpace')) ?? '');
    const filter = dict.lookup(PDFName.of('Filter'));
    const width = Number(dict.lookup(PDFName.of('Width')));
    const height = Number(dict.lookup(PDFName.of('Height')));

    // spec §5.1: bu beş koşulun hepsi sağlanmalı.
    if (bits !== 8) return false;
    if (colorSpace !== '/DeviceRGB' && colorSpace !== '/DeviceGray') return false;
    if (dict.has(PDFName.of('SMask'))) return false;
    if (filter && String(filter) === '/DCTDecode') return false;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

    const raw = xobj.contents;
    if (!raw || raw.length < MIN_RECODE_BYTES) return false;

    try {
        const jpeg = await pdfRecodeToJpeg(raw, width, height, colorSpace === '/DeviceGray', quality);
        xobj.contents = jpeg;
        dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        dict.delete(PDFName.of('DecodeParms'));
        dict.delete(PDFName.of('SMask'));
        return true;
    } catch (err) {
        // Tek bir görselin çözülememesi işlemi durdurmaz.
        console.warn('Görsel yeniden kodlanamadı, atlandı:', err);
        return false;
    }
}

/** FlateDecode ham pikselleri çözüp JPEG olarak yeniden kodlar. */
async function pdfRecodeToJpeg(compressed, width, height, grayscale, quality) {
    const channels = grayscale ? 1 : 3;
    const raw = await pdfInflate(compressed, width * height * channels);

    const canvas = window.OffscreenCanvas
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas bağlamı alınamadı');

    if (grayscale) {
        // Canvas'a yazarken gri pikselleri üç kanala açıyoruz; renk uzayı
        // DeviceGray olarak kalır, sıkıştırma sonrası doğru görünür.
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0, j = 0; i < width * height; i++) {
            const v = raw[i];
            rgba[j++] = v; rgba[j++] = v; rgba[j++] = v; rgba[j++] = 255;
        }
        context.putImageData(new ImageData(rgba, width, height), 0, 0);
    } else {
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0, j = 0; i < width * height; i++) {
            rgba[j++] = raw[i * 3];
            rgba[j++] = raw[i * 3 + 1];
            rgba[j++] = raw[i * 3 + 2];
            rgba[j++] = 255;
        }
        context.putImageData(new ImageData(rgba, width, height), 0, 0);
    }

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
 */
async function pdfRasterize(bytes, rotations, quality) {
    await pdfEnsureWorker();
    const source = await pdfjsLib.getDocument({ data: bytes }).promise;
    const out = await PDFLib.PDFDocument.create();
    const scale = RASTER_DPI / 72;

    for (let i = 1; i <= source.numPages; i++) {
        const page = await source.getPage(i);
        page.rotate = rotations[i - 1] || 0;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) throw new Error('Görsele çevirme başarısız.');

        const jpeg = new Uint8Array(await blob.arrayBuffer());
        const embedded = await out.embedJpg(jpeg);
        const target = out.addPage([A4_WIDTH, A4_HEIGHT]);
        // Döndürülmüş görsel yatay gelir; A4'e sığdırıp ortala.
        const ratio = Math.min(A4_WIDTH / embedded.width, A4_HEIGHT / embedded.height);
        const w = embedded.width * ratio;
        const h = embedded.height * ratio;
        target.drawImage(embedded, {
            x: (A4_WIDTH - w) / 2,
            y: (A4_HEIGHT - h) / 2,
            width: w,
            height: h
        });

        pdfShowProgress(i, source.numPages, `Sayfa ${i} / ${source.numPages} görsele çevriliyor`);
        if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }

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
    const button = document.getElementById('pdf-build-btn');
    if (!button) return;
    const hasPages = pdfState.pages.length > 0;
    button.disabled = !hasPages || pdfState.busy;
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
})();

window.pdfBuildOutput = pdfBuildOutput;
window.pdfPlaceOnA4 = pdfPlaceOnA4;
window.pdfRasterize = pdfRasterize;
window.pdfCompressImages = pdfCompressImages;
window.pdfTriggerDownload = pdfTriggerDownload;
window.pdfSafeFileName = pdfSafeFileName;
window.pdfShowResult = pdfShowResult;
