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
 * Sayfanın GÖRÜNÜR kutusu: CropBox ∩ MediaBox (CropBox yoksa MediaBox).
 *
 * A1.4: `getSize()` yalnızca MediaBox'ı kullanır; CropBox varsa (ör. tarama
 * sırasında kırpılmış kenarlar) gizli kenarlar A4'e taşınırken YENİDEN
 * görünür hale gelir ve ölçek yanlış hesaplanır (kırpılan alan da dahil
 * edildiği için içerik gereğinden küçük basılır).
 *
 * Dönüş: {left, bottom, right, top} — pdf-lib `embedPage` boundingBox biçimi.
 */
function pdfVisibleBox(page) {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const left = Math.max(media.x, crop.x);
    const bottom = Math.max(media.y, crop.y);
    const right = Math.min(media.x + media.width, crop.x + crop.width);
    const top = Math.min(media.y + media.height, crop.y + crop.height);
    // Bozuk/dejenere CropBox (MediaBox ile kesişmiyor): MediaBox'a düş.
    if (!(right > left) || !(top > bottom)) {
        return { left: media.x, bottom: media.y, right: media.x + media.width, top: media.y + media.height };
    }
    return { left, bottom, right, top };
}

/**
 * Kaynak sayfayı A4'e ölçekleyip ortalanarak yerleştirir; içerik kırpılmaz.
 *
 * Ölçek/konum, sayfanın GÖRÜNÜR kutusundan (CropBox ∩ MediaBox) hesaplanır
 * (bkz. `pdfVisibleBox`) — yalnızca MediaBox'tan DEĞİL.
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
 *
 * 1.7: `landscape` açıksa VE döndürme sonrası GÖRÜNÜR kutu yataysa (genişlik
 * > yükseklik), hedef A4 de YATAY alınır (841.89x595.28) — dikey A4'e
 * sığdırıp sayfanın çoğunu boş bırakmak yerine, yatay içerik yatay kağıda
 * ölçek ~%41 daha büyük basılır. Kapalıyken ya da içerik zaten dikeyken
 * davranış DEĞİŞMEZ (her zaman dikey A4).
 */
async function pdfPlaceOnA4(targetDoc, srcPage, rotation, landscape = false) {
    const box = pdfVisibleBox(srcPage);
    const w = box.right - box.left;
    const h = box.top - box.bottom;

    const quarterTurn = rotation === 90 || rotation === 270;
    const boxW = quarterTurn ? h : w;
    const boxH = quarterTurn ? w : h;
    const useLandscape = landscape && boxW > boxH;
    const targetW = useLandscape ? A4_HEIGHT : A4_WIDTH;
    const targetH = useLandscape ? A4_WIDTH : A4_HEIGHT;
    const target = targetDoc.addPage([targetW, targetH]);

    // Bozuk PDF'lerde MediaBox sıfır ya da geçersiz olabilir; ölçek NaN olur
    // ve bozuk çıktı yazılır. Böyle sayfalar boş A4 olarak bırakılır.
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 1 || h <= 1) {
        return target;
    }

    const scale = Math.min(targetW / boxW, targetH / boxH);

    const dx = (targetW - boxW * scale) / 2;
    const dy = (targetH - boxH * scale) / 2;

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

    // `box` verilerek yalnızca GÖRÜNÜR kutu Form XObject'in /BBox'ı olur;
    // CropBox dışındaki içerik (ör. tarama kenarındaki gürültü) çıktıda
    // görünmez kalır.
    const embedded = await targetDoc.embedPage(srcPage, box);
    target.drawPage(embedded, {
        x: dx - minX,
        y: dy - minY,
        xScale: scale,
        yScale: scale,
        rotate: PDFLib.radians((-rotation * Math.PI) / 180)
    });
    return target;
}

// --- Annotation gömme (A4 modu) ---------------------------------------------

// PDF 32000-1:2008 Tablo 165 — /F bayrak bitleri.
const ANNOT_FLAG_HIDDEN = 2;
const ANNOT_FLAG_NOVIEW = 32;
const ANNOT_FLAG_PRINT = 4;

/** Bir sayıyı içerik akışında güvenli biçimde yazar (bilimsel gösterim yok). */
function pdfNum(n) {
    if (!Number.isFinite(n)) return '0';
    return Number(n.toFixed(4)).toString();
}

/**
 * PDF 32000-1:2008 §12.5.5 — bir görünüm akışının (/AP /N) /BBox'ını
 * /Matrix ile dönüştürüp eksen hizalı KAPSAYAN kutuyu ("transformed
 * appearance box") hesaplar, sonra bu kutuyu annotation'ın /Rect'ine
 * eşleyen A matrisini döndürür. İçerik akışına `A cm` yazılıp ardından
 * Form XObject `Do` edilirse, AP'nin kendi /Matrix'iyle birlikte tam
 * /Rect'e oturur.
 */
function pdfAnnotAppearanceMatrix(bbox, matrix, rect) {
    const [bx0, by0, bx1, by1] = bbox;
    const [ma, mb, mc, md, me, mf] = matrix;
    const corners = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]
        .map(([x, y]) => [ma * x + mc * y + me, mb * x + md * y + mf]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const tx0 = Math.min(...xs), tx1 = Math.max(...xs);
    const ty0 = Math.min(...ys), ty1 = Math.max(...ys);
    const tw = (tx1 - tx0) || 1;
    const th = (ty1 - ty0) || 1;

    let [rx0, ry0, rx1, ry1] = rect;
    if (rx0 > rx1) { const t = rx0; rx0 = rx1; rx1 = t; }
    if (ry0 > ry1) { const t = ry0; ry0 = ry1; ry1 = t; }

    const sx = (rx1 - rx0) / tw;
    const sy = (ry1 - ry0) / th;
    return [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
}

/** Bir PDFObject bir AKIŞ mı (Form XObject vb.)? `.dict` VE `.contents` varsa evet. */
function pdfIsStream(obj) {
    return !!(obj && obj.dict && obj.contents !== undefined);
}

/**
 * Bir annotation'ın NORMAL (/AP /N) görünüm akışını çözer. /AS ile seçilen
 * DURUM (checkbox on/off vb.) da desteklenir. Akış dolaylı değilse (gömülü
 * sözlükse) dolaylı hale getirilir — içerikte /XObject girdisi olarak
 * referans vermek için bir PDFRef gerekir.
 * Dönüş: {ref, stream} ya da görünüm yoksa null.
 */
function pdfResolveAnnotAppearance(doc, annotDict) {
    const { PDFName, PDFDict } = PDFLib;
    const apDict = annotDict.lookupMaybe(PDFName.of('AP'), PDFDict);
    if (!apDict) return null;
    let ref = apDict.get(PDFName.of('N'));
    if (!ref) return null;
    let val = doc.context.lookup(ref);
    if (!val) return null;

    if (!pdfIsStream(val)) {
        // Durum sözlüğü (ör. /Off, /Yes): /AS ile hangisinin aktif olduğu seçilir.
        if (!(val instanceof PDFDict)) return null;
        const asName = annotDict.get(PDFName.of('AS'));
        if (!asName) return null;
        ref = val.get(asName);
        if (!ref) return null;
        val = doc.context.lookup(ref);
        if (!pdfIsStream(val)) return null;
    }

    if (!(ref && ref.tag)) ref = doc.context.register(val);
    return { ref, stream: val };
}

/**
 * Sayfaya ÖZEL (paylaşılmayan) bir Resources sözlüğü kurar ve döner.
 * Kaynaklar (/Resources) miras/paylaşımlı olabilir: A1.1'in toplu
 * copyPages() çağrısı, PAYLAŞILAN bir /Resources sözlüğünü birden fazla
 * sayfaya AYNI referansla kopyalar (ortak font/logo tekilleştirme kazancı
 * için istenen davranış budur). Bu yüzden buraya /XObject eklemeden ÖNCE
 * sığ bir kopya alınır; paylaşılan sözlük MUTASYONA UĞRATILMAZ (aksi halde
 * başka sayfaları da bozar).
 */
function pdfPrivatePageResources(doc, page) {
    const { PDFName, PDFDict } = PDFLib;
    const node = page.node;
    const shared = node.Resources();

    const ownResources = doc.context.obj({});
    if (shared) {
        for (const [key, value] of shared.entries()) ownResources.set(key, value);
    }
    const sharedXObject = shared?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const ownXObject = doc.context.obj({});
    if (sharedXObject) {
        for (const [key, value] of sharedXObject.entries()) ownXObject.set(key, value);
    }
    ownResources.set(PDFName.of('XObject'), ownXObject);
    node.set(PDFName.of('Resources'), ownResources);
    return { resources: ownResources, xObject: ownXObject };
}

/** Akış içeriğini (filtre çözülmüş olarak) Uint8Array döndürür. */
function pdfDecodeStreamBytes(stream) {
    const { PDFRawStream, PDFContentStream, decodePDFRawStream } = PDFLib;
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
    return new Uint8Array(0);
}

/** Birden fazla Uint8Array'i TEK diziye birleştirir (string'e çevirmeden; ikili güvenli). */
function pdfConcatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
}

/**
 * R1: /Contents dizisindeki BİRDEN FAZLA akış parçasını, aralarına ayraç
 * KOYARAK birleştirir. PDF içerik akışı bir TOKEN dizisidir; parçaların
 * baştaki/sondaki boşluğu garanti değildir. Ayraç konulmazsa komşu tokenlar
 * birleşip geçersiz bir operatöre dönüşebilir (ör. "...ET" + "BT..." ->
 * "...ETBT..."), bu da o sınırdaki içeriğin bozulmasına yol açar.
 */
function pdfJoinContentParts(parts) {
    if (parts.length <= 1) return pdfConcatBytes(parts);
    const nl = new TextEncoder().encode('\n');
    const withSeparators = [];
    parts.forEach((p, i) => {
        if (i > 0) withSeparators.push(nl);
        withSeparators.push(p);
    });
    return pdfConcatBytes(withSeparators);
}

/**
 * A4 modunda embedPage yalnızca sayfanın içerik akışını Form XObject'e
 * çevirir; /Annots (form alanı görünümü, damga, not) SONUÇTA KAYBOLUR
 * (ölçüm: form alanı 1 -> 0). Bu yüzden embedPage ÇAĞRILMADAN ÖNCE her
 * annotation'ın normal görünüm akışı (/AP /N) sayfanın İÇERİĞİNE gömülür
 * (PDF 32000-1:2008 §12.5.5).
 *
 * Atlanan annotation'lar: Hidden (/F biti 2) veya NoView (/F biti 32),
 * /Subtype /Popup, ve görünümü olmayan diğer türler (/Link vb., sessizce).
 * Görünümü OLMASI beklenen ama /AP'si EKSİK bir /Widget varsa SAYILIR —
 * kullanıcı dürüstçe uyarılmalı (bu alan A4 çıktısında görünmeyecek).
 *
 * Yalnızca YENİDEN ÖLÇEKLENEN sayfalarda (embedPage'e giren) çağrılır; tam
 * A4 sayfa /Annots'unu olduğu gibi korur (bkz. pdfBuildOutput).
 *
 * R3: sayfanın /Contents'i HİÇ YOKSA (tamamen boş sayfa) eskiden burada
 * erken çıkılıyordu; embedPage de içeriksiz sayfayı boş A4 bırakıyordu ve
 * annotation'lar SESSİZCE kayboluyordu. Artık /Contents yokluğu erken
 * çıkış NEDENİ değildir — annotation'lar varsa yalnızca ONLARIN çizimiyle
 * yeni bir içerik akışı KURULUR (aşağıda `streams` boş dizi olur).
 *
 * Dönüş: görünümü olmayan (/AP'siz) widget sayısı.
 */
function pdfBakeAnnotationsForA4(doc, page) {
    const { PDFName, PDFDict, PDFArray } = PDFLib;
    const node = page.node;
    const annots = node.Annots();
    if (!annots || annots.size() === 0) return 0;     // annotation yok: gömülecek bir şey yok

    let noAppearance = 0;
    const drawOps = [];
    let xObjectDict = null;
    let counter = 0;

    for (let i = 0; i < annots.size(); i++) {
        const annotDict = doc.context.lookupMaybe(annots.get(i), PDFDict);
        if (!annotDict) continue;

        const subtype = String(annotDict.lookup(PDFName.of('Subtype')) ?? '');
        if (subtype === '/Popup') continue;

        const flags = Number(annotDict.lookup(PDFName.of('F')) ?? 0);
        if ((flags & ANNOT_FLAG_HIDDEN) || (flags & ANNOT_FLAG_NOVIEW)) continue;
        // A4 çıktısı baskıya uygun kopyadır: orijinal yazdırıldığında kâğıda
        // ÇIKMAYAN (Print bayrağı kapalı) inceleme notu gömülürse belgeye
        // içerik EKLENMİŞ olur. Yalnızca yazdırılan annotation gömülür.
        if (!(flags & ANNOT_FLAG_PRINT)) continue;

        const appearance = pdfResolveAnnotAppearance(doc, annotDict);
        if (!appearance) {
            if (subtype === '/Widget') noAppearance++;
            continue;                                  // /Link vb.: sessizce atla
        }

        const rectArr = annotDict.lookupMaybe(PDFName.of('Rect'), PDFArray);
        if (!rectArr || rectArr.size() !== 4) continue;
        const rect = [0, 1, 2, 3].map((k) => Number(rectArr.lookup(k)));

        const apDict = appearance.stream.dict;
        const bboxArr = apDict.lookupMaybe(PDFName.of('BBox'), PDFArray);
        const bbox = bboxArr ? [0, 1, 2, 3].map((k) => Number(bboxArr.lookup(k))) : rect;
        const matrixArr = apDict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
        const matrix = matrixArr ? [0, 1, 2, 3, 4, 5].map((k) => Number(matrixArr.lookup(k))) : [1, 0, 0, 1, 0, 0];

        // AP akışında /Type /XObject /Subtype /Form yoksa ekle (spec'e göre
        // zorunludur, ama bazı üreticiler eksik bırakır).
        if (!apDict.has(PDFName.of('Type'))) apDict.set(PDFName.of('Type'), PDFName.of('XObject'));
        if (!apDict.has(PDFName.of('Subtype'))) apDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
        if (!apDict.has(PDFName.of('BBox'))) apDict.set(PDFName.of('BBox'), doc.context.obj(bbox));

        const A = pdfAnnotAppearanceMatrix(bbox, matrix, rect);

        if (!xObjectDict) xObjectDict = pdfPrivatePageResources(doc, page).xObject;
        const key = PDFName.of(`FlatN${counter++}`);
        xObjectDict.set(key, appearance.ref);

        const keyText = key.asString ? key.decodeText() : String(key).replace(/^\//, '');
        drawOps.push(`q ${A.map(pdfNum).join(' ')} cm /${keyText} Do Q`);
    }

    if (drawOps.length === 0) return noAppearance;

    // Orijinal içeriği q...Q ile sar (grafik durumu annotation çizimine
    // SIZMASIN), annotation çizimlerini SONA ekle. R3: /Contents YOKSA
    // (`contents` undefined) orijinal parça listesi BOŞ kalır — yalnızca
    // annotation çizimlerinden oluşan bir sayfa kurulur.
    const contents = node.Contents();
    const streams = !contents
        ? []
        : (contents instanceof PDFArray
            ? Array.from({ length: contents.size() }, (_, i) => doc.context.lookup(contents.get(i)))
            : [contents]);
    // R1: parçalar arasına AYRAÇ konulmadan birleştirilirse komşu tokenlar
    // birleşip geçersiz bir operatöre dönüşebilir (ör. "ET" + "BT" ->
    // "ETBT"); bu yüzden pdfConcatBytes YERİNE pdfJoinContentParts kullanılır.
    const originalBytes = pdfJoinContentParts(streams.filter(Boolean).map(pdfDecodeStreamBytes));
    const enc = new TextEncoder();
    const combined = pdfConcatBytes([
        enc.encode('q\n'),
        originalBytes,
        enc.encode('\nQ\n' + drawOps.join('\n') + '\n')
    ]);

    const newRef = doc.context.register(doc.context.flateStream(combined, {}));
    node.set(PDFName.of('Contents'), newRef);

    return noAppearance;
}

// --- Çıktı kurulumu ---------------------------------------------------------

/**
 * Kaynak sayfanın kendi /Rotate değeri ile kullanıcının eklediği döndürmeyi
 * toplar. İkisi ÜSTÜNE yazılmaz, toplanır: /Rotate 90 olan bir sayfaya bir kez
 * daha basıldığında sonuç 180 olmalıdır, 90 değil.
 *
 * Bu değer atlanırsa çıktı yanlış yönde basılır: küçük resimde pdf.js kaynak
 * /Rotate'u uygular (doğru görünür), çıktıda ise sayfa dik çıkar.
 */
function pdfEffectiveRotation(entry, file) {
    // A1.3: pdf-sayfalar.js içindeki pdfSourceRotation ile AYNI (miras
    // /Rotate'i okuyan) mantık kullanılır; iki dosya ayrı ayrı yanlış
    // (yalnızca doğrudan sözlük) okuma yapmasın diye tek yardımcıya indirildi.
    const source = pdfSourceRotation(file, entry.srcIndex);
    return (source + (entry.rotation || 0)) % 360;
}

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
        let losslessReport = null;

        // Kayıp mod ÖNCE kontrol edilir: rasterizasyon kaynak PDF'leri doğrudan
        // okur, vektör kopyasına gerek yoktur. Aksi halde 300 sayfalık belgede
        // hem vektör kopya hem JPEG'ler hem ikinci belge bellekte tutulur.
        if (pdfState.output.lossy) {
            const { bytes, rasterFailures } = await pdfRasterizeToOutput(entries, pdfState.output.quality, pdfState.output.landscape);
            return { bytes, originalSize, outputSize: bytes.length, rasterFailures };
        }

        const doc = await PDFLib.PDFDocument.create();
        let count = 0;
        // I12: kayıp mod dışı yolda da tek sayfanın hatası TÜM işi çöpe
        // atmamalı. 300 sayfalık belgede 250. sayfa okunamazsa kullanıcı
        // 10 dakikalık emeğini kaybetmemeli; sayfa atlanır ve haber verilir.
        const copyFailures = [];
        // A1.2: A4 modunda yeniden ölçeklenen sayfalarda görünümü OLMAYAN
        // (/AP'siz) form alanı widget'larının toplam sayısı.
        let annotWarnings = 0;
        // R2: annotation gömme (pdfBakeAnnotationsForA4) bir sayfada hata
        // verirse (ör. desteklenmeyen bir filtreyle kodlanmış içerik akışı)
        // eskiden hata dış try/catch'e sızıp TÜM SAYFA atlanıyordu. Artık
        // yalnızca gömme atlanır, sayfanın kendisi (annotation'sız) yine de
        // eklenir; bu sayaç kullanıcıya dürüstçe bildirmek için tutulur.
        let bakeFailures = 0;

        // A1.1: sayfa başına AYRI copyPages([i]) çağrısı her seferinde yeni
        // bir PDFObjectCopier açar; ortak font/logo her sayfada YENİDEN
        // kopyalanır (ölçüm: 58 KB -> 559 KB). Dosya başına TEK toplu
        // copyPages(indices) çağrısı TEK bir kopyalayıcı kullanır; paylaşılan
        // dolaylı nesneler (ör. gömülü görsel) yalnızca BİR kez kopyalanıp
        // sonraki kullanımlarda aynı hedef referansa yönlendirilir (bkz.
        // PDFObjectCopier.copyPDFIndirectObject önbelleği). Aynı srcIndex
        // birden fazla kez kullanılıyorsa (indices dizisinde tekrar), pdf-lib
        // sayfanın kendisi için HER ZAMAN ayrı bir klon üretir
        // (copyPDFPage önbelleğe bakmaz) — bu yüzden çıktıda aynı PDFPage
        // nesnesi iki kez eklenmiş olmaz, sıra da korunur.
        const copiedByEntry = new Map();
        const groupsByFile = new Map(); // fileId -> {file, entries: []}
        for (const entry of entries) {
            const file = pdfState.files.find((f) => f.id === entry.fileId);
            if (!file || !file.doc) continue;
            let group = groupsByFile.get(entry.fileId);
            if (!group) { group = { file, entries: [] }; groupsByFile.set(entry.fileId, group); }
            group.entries.push(entry);
        }

        for (const group of groupsByFile.values()) {
            const { file, entries: groupEntries } = group;
            const indices = groupEntries.map((e) => e.srcIndex);
            try {
                const copied = await doc.copyPages(file.doc, indices);
                groupEntries.forEach((entry, i) => copiedByEntry.set(entry, copied[i]));
            } catch (err) {
                // Toplu kopya başarısız oldu: eski sayfa-başı yola geri dön;
                // tek sayfanın hatası bu dosyanın DİĞER sayfalarını etkilemesin.
                for (const entry of groupEntries) {
                    try {
                        const [single] = await doc.copyPages(file.doc, [entry.srcIndex]);
                        copiedByEntry.set(entry, single);
                    } catch (innerErr) {
                        // Dosya adı yazılmaz (kişisel veri sızıntısı olur).
                        console.warn('Sayfa çıktıya eklenemedi, atlandı:', innerErr);
                        copyFailures.push(entry.srcIndex + 1);
                    }
                }
            }
        }

        for (const entry of entries) {
            const file = pdfState.files.find((f) => f.id === entry.fileId);
            if (!file || !file.doc) continue;
            const copied = copiedByEntry.get(entry);
            if (!copied) continue; // yukarıda zaten copyFailures'a eklendi

            try {
            // pdf-lib copyPages /Rotate'u korur; A4 dönüşümü kendi matrisinde
            // uygulayacağı için burada temizlenir, yoksa çift döner.
            const rotation = pdfEffectiveRotation(entry, file);
            copied.node.delete(PDFLib.PDFName.of('Rotate'));

            if (pdfState.output.a4) {
                // A1.4: yalnızca MediaBox A4 boyutunda olması YETMEZ — CropBox
                // MediaBox'tan küçükse gerçek görünür alan A4 DEĞİLDİR ve
                // yeniden ölçeklenmesi gerekir. `isExactA4`, GÖRÜNÜR kutunun
                // A4 boyutunda VE MediaBox'IN görünür kutuyla AYNI (kırpma
                // yok) olmasını ister.
                const visible = pdfVisibleBox(copied);
                const visibleW = visible.right - visible.left;
                const visibleH = visible.top - visible.bottom;
                const media = copied.getMediaBox();
                const isExactA4 = !rotation
                    && Math.abs(visibleW - A4_WIDTH) < 1
                    && Math.abs(visibleH - A4_HEIGHT) < 1
                    && Math.abs(media.width - visibleW) < 1
                    && Math.abs(media.height - visibleH) < 1;
                // 1.7: `landscape` açıkken tam YATAY A4 (841.89x595.28,
                // döndürülmemiş) sayfa da doğrudan eklenir — dikey A4'e
                // sığdırılıp gereksiz yere küçültülmemeli.
                const isExactLandscapeA4 = pdfState.output.landscape && !rotation
                    && Math.abs(visibleW - A4_HEIGHT) < 1
                    && Math.abs(visibleH - A4_WIDTH) < 1
                    && Math.abs(media.width - visibleW) < 1
                    && Math.abs(media.height - visibleH) < 1;
                if (isExactA4 || isExactLandscapeA4) {
                    // Zaten tam (dikey ya da yatay) A4 ve döndürülmemiş:
                    // gereksiz yeniden ölçekleme yapma.
                    doc.addPage(copied);
                } else {
                    // A1.2: embedPage YALNIZCA içerik akışını Form XObject
                    // yapar; /Annots düşer. embedPage ÇAĞRILMADAN ÖNCE
                    // annotation görünümleri içeriğe gömülür. Tam A4 (yukarıdaki
                    // dal) buna gerek duymaz: /Annots olduğu gibi kalır.
                    //
                    // R2: bu çağrı AYRICA sarmalanır — gömme başarısız
                    // olursa (ör. desteklenmeyen filtre) sayfanın TAMAMI
                    // atlanmamalı; yalnızca annotation'sız, İÇERİĞİ KORUNMUŞ
                    // olarak yerleştirilir (aşağıdaki pdfPlaceOnA4 çağrısı
                    // yine de çalışır).
                    try {
                        annotWarnings += pdfBakeAnnotationsForA4(doc, copied);
                    } catch (bakeErr) {
                        console.warn('Not/damga gömülemedi, sayfa içerik korunarak eklendi:', bakeErr);
                        bakeFailures++;
                    }
                    // A4 modunda döndürme dönüşüme gömülür; /Rotate yazılmaz.
                    // Yazılsaydı içerik iki kez dönerdi.
                    await pdfPlaceOnA4(doc, copied, rotation, pdfState.output.landscape);
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
            } catch (err) {
                // Dosya adı yazılmaz (kişisel veri sızıntısı olur).
                console.warn('Sayfa çıktıya eklenemedi, atlandı:', err);
                copyFailures.push(entry.srcIndex + 1);
            }
        }

        if (count === 0) throw new Error(RESULT_TEXT.noPages);

        // 1.8: belge başlığı, indirilen dosya adıyla (uzantısız) eşleşir —
        // sabit bir metin yerine kullanıcının gördüğü gerçek dosya adı.
        doc.setTitle(pdfOutputFileName().replace(/\.pdf$/i, ''));
        doc.setProducer('PDF Araçları (kira-sozlesmesi-olusturucu)');

        // flush() nesneleri context'e kaydeder. Bu olmadan sayfa
        // kaynaklarındaki PDFRef'ler çözülemiyor ve aşağıdaki adımlar
        // hiçbir görseli bulamadan sessizce başarısız oluyor.
        await doc.flush();

        // 1.5: tekilleştirme + budama HER ÇIKTIDA çalışır (sıkıştırma
        // açık/kapalı fark etmez) — piksellere dokunmaz, yalnızca aynı
        // içeriği (bayt + sözlük) paylaşan nesneleri tek referansa indirir.
        const dedupe = pdfDedupeStreams(doc);

        // Sıkıştırma modu 1: gömülü görselleri JPEG olarak yeniden kodlar,
        // metin ve vektör içerik olduğu gibi kalır.
        if (pdfState.output.compress && pdfState.output.compressMode === 'lossless') {
            // KAYIPSIZ: piksellere dokunulmaz. Üst veri silme ve 1-bit
            // dönüşümü YALNIZCA burada (kullanıcı kayıpsızı AÇIKÇA seçtiyse)
            // çalışır; rapor metni de yalnızca bu dalda gösterilir.
            const metadataStripped = pdfStripMetadata(doc);
            const oneBit = await pdfConvertExactOneBit(doc);
            const pruned = pdfPruneUnusedObjects(doc);
            losslessReport = {
                deduped: dedupe.deduped, dedupedBytes: dedupe.dedupedBytes,
                metadataStripped, oneBit, pruned
            };
        } else if (pdfState.output.compress) {
            pdfPruneUnusedObjects(doc);
            const { replaced, skipped } = await pdfCompressImages(doc, pdfState.output.quality);
            pdfShowProgress(entries.length, entries.length,
                `${replaced} görsel yeniden kodlandı`);
            compressReport = { replaced, skipped };
        } else {
            // Sıkıştırma kapalı: yalnızca dedupe'un açtığı öksüz nesneler
            // budanır; rapor GÖSTERİLMEZ (kullanıcı "sıkıştırma yapıldı"
            // sanmasın).
            pdfPruneUnusedObjects(doc);
        }

        const bytes = await doc.save({ useObjectStreams: true });
        return {
            bytes,
            originalSize,
            outputSize: bytes.length,
            compressReport,
            losslessReport,
            copyFailures: copyFailures.length
                ? { count: copyFailures.length, pages: copyFailures.slice(0, 10), more: copyFailures.length > 10 }
                : null,
            annotWarnings,
            bakeFailures
        };
    } catch (err) {
        console.error('Çıktı üretilemedi', err);
        throw err;
    } finally {
        pdfSetBusy(false);
        pdfHideProgress();
    }
}

// --- İndirme ---------------------------------------------------------------

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
function pdfDefaultOutputFileName() {
    const names = pdfState.files.filter((f) => f.doc);
    // Görselden gelen dosyanın adı .jpg/.png/.tif olabilir; çıktı her zaman .pdf.
    if (names.length === 1) return pdfSafeFileName(names[0].name.replace(/\.(jpe?g|png|tiff?)$/i, '.pdf'));
    return 'birlesmis-belge.pdf';
}

/**
 * Kullanıcı "Dosya adı" kutusuna bir ad yazdıysa o kullanılır (güvenli hale
 * getirilir, `.pdf` uzantısı garanti edilir); boşsa varsayılan ad.
 */
function pdfOutputFileName() {
    const typed = document.getElementById('pdf-output-name')?.value?.trim();
    if (!typed) return pdfDefaultOutputFileName();
    // Esas numarası gibi '/' içeren adlar (2026/123) kırpılmasın: yol
    // ayırıcısı '-' olur. pdfSafeFileName aksi halde yalnız son parçayı alır.
    const flat = typed.replace(/[\\/]+/g, '-');
    const withExt = /\.pdf$/i.test(flat) ? flat : `${flat}.pdf`;
    const safe = pdfSafeFileName(withExt);
    return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
}

/** Varsayılan ad, boş kutuda yer tutucu olarak görünür. */
function pdfSyncOutputNamePlaceholder() {
    const input = document.getElementById('pdf-output-name');
    if (input) input.placeholder = pdfDefaultOutputFileName();
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
    // Sekme bölgesi `.app-grid` DIŞINDA; belge ve araç grupları `.tab-row`
    // içinde. Tek `.tab-container` seçilirse Araçlar grubu erişilebilir kalır.
    const tabBar = document.querySelector('.tab-row');
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

/**
 * İki düğme:
 *  - 'plain' (Birleştir / Kaydet): Gelişmiş ayarlar neyse o. Varsayılanda
 *    sıkıştırma KAPALI — görünüm birebir aynı (mahkeme/UYAP).
 *  - 'small' (Birleştir ve Küçült): görseller, Gelişmiş'teki kalite
 *    seviyesiyle (varsayılan Orta) yeniden kodlanır; metin seçilebilir kalır.
 * Ayar her tıklamada sayfadan YENİDEN okunur: 'small' geçersiz kılması
 * sonraki 'plain' çıktıya sızmaz.
 */
async function pdfOnBuildClick(kind = 'plain') {
    // Çift tıklama iki çıktı üretmesin.
    if (pdfState.busy || pdfBuildLock) return;
    if (pdfState.pages.length === 0) {
        pdfShowResult(RESULT_TEXT.noPages, 'warning');
        return;
    }

    pdfReadOutputState();
    if (kind === 'small') {
        pdfState.output = { ...pdfState.output, compress: true, compressMode: 'quality', lossy: false };
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
        const { bytes, originalSize, outputSize, compressReport, losslessReport, rasterFailures, copyFailures, annotWarnings, bakeFailures } = await pdfBuildOutput();
        pdfTriggerDownload(bytes, pdfOutputFileName());

        // A1.2: görünümü olmayan (/AP'siz) form alanı widget'ları vardı;
        // bu alanlar A4 çıktısında görünmeyebilir. Kullanıcı sessizce
        // aldatılmasın diye bu uyarı, aşağıdaki HANGİ dal çalışırsa çalışsın
        // (EKLENEREK) mesajın sonuna eklenir — mevcut mesaj mantığı bozulmaz.
        const annotNote = annotWarnings
            ? ` ${annotWarnings} form alanının görünümü yok; A4'e sığdırmada bu alanlar `
                + `çıktıda görünmeyebilir. A4 seçeneğini kapatarak deneyin.`
            : '';
        // R2: baking başarısız olduysa (desteklenmeyen içerik biçimi) sayfa
        // korunur ama annotation'ları gömülemez — kullanıcı dürüstçe uyarılır.
        const bakeNote = bakeFailures
            ? ` ${bakeFailures} sayfada not/imza görünümü gömülemedi (desteklenmeyen `
                + `içerik biçimi); sayfa içeriği KORUNARAK eklendi.`
            : '';
        const showResult = (msg, kind) => pdfShowResult(
            msg + annotNote + bakeNote,
            kind || ((annotNote || bakeNote) ? 'warning' : undefined)
        );

        const head = `Orijinal ${pdfFormatBytes(originalSize)} → Çıktı ${pdfFormatBytes(outputSize)}`;
        // Sıkıştırma kapalıyken küçülme de olsa bu ipucu gösterilir: A4'e
        // sığdırma tek başına küçülme yaratabilir ve kullanıcı bunu
        // sıkıştırmanın işi sanmasın.
        const compressOffNote = pdfState.output.compress
            ? ''
            : ' Sıkıştırma seçeneği kapalıydı; e-posta için daha küçük dosya '
                + 'gerekirse "Küçült" düğmesini kullanın.';
        // A8: kayıp modda atlanan sayfaların haberi. Bu not OLMADAN çıktı
        // eksik sayfalarla üretilmiş olur ve kullanıcı bunu fark etmez.
        const rasterNote = rasterFailures
            ? ` ${rasterFailures.count} sayfa görsele çevrilemedi ve atlandı `
                + `(sayfa ${rasterFailures.pages.join(', ')}${rasterFailures.more ? '…' : ''}).`
            : '';
        // I12: vektör yolda atlanan sayfalar da aynı şekilde bildirilir.
        const copyNote = copyFailures
            ? ` ${copyFailures.count} sayfa çıktıya eklenemedi ve atlandı `
                + `(sayfa ${copyFailures.pages.join(', ')}${copyFailures.more ? '…' : ''}).`
            : '';
        const failedNote = rasterNote || copyNote;
        // I14: "%0 küçüldü" bir küçülme iddiası değil, gürültüdür. Yüzde
        // en az 1 olmalı; altındaysa küçülme yok sayılır ve neden açıklanır.
        const saved = outputSize < originalSize
            ? Math.round((1 - outputSize / originalSize) * 100)
            : 0;
        const shrunk = saved >= 1;
        const message = failedNote + head + (shrunk
            ? ` (%${saved} küçüldü)` + (pdfState.output.lossy ? ' — Metin seçilemez.' : '')
            : '.');

        // KAYIPSIZ YÖNTEM raporu: ne yapıldığını ve neden az küçüldüğünü yaz.
        if (pdfState.output.compress && losslessReport) {
            const parts = [];
            if (losslessReport.deduped > 0) {
                parts.push(`${losslessReport.deduped} yinelenen görsel tekilleştirildi `
                    + `(${pdfFormatBytes(losslessReport.dedupedBytes)} tasarruf edildi)`);
            }
            if (losslessReport.oneBit > 0) {
                // 1.8: "sayfa" yanıltıcıydı — sayaç SAYFA değil GÖRSEL sayar
                // (bir sayfada birden fazla saf siyah-beyaz görsel olabilir).
                parts.push(`${losslessReport.oneBit} görsel 1-bit'e çevrildi`);
            }
            if (losslessReport.metadataStripped > 0) {
                parts.push(`${losslessReport.metadataStripped} gereksiz belge bilgisi atıldı`);
            }
            const done = parts.length
                ? parts.join(', ') + '.'
                : 'Kayıpsız sıkıştırma için elde edilebilir bir tasarruf bulunamadı.';
            const nothingToDo = parts.length === 0
                ? ' Görseller zaten sıkıştırılmış; resmî belgede görünümü '
                  + 'bozmadan daha fazla küçültme kayıpsız olarak mümkün değil.'
                : '';
            showResult(
                `${failedNote}${head}. Kayıpsız yöntem: ${done}${nothingToDo}`,
                parts.length === 0 ? 'warning' : undefined
            );
            return;
        }

        if (shrunk) {
            showResult(
                message
                + pdfSkipNote(compressReport)
                + compressOffNote,
                failedNote ? 'warning' : undefined
            );
            return;
        }

        // Küçülme olmadı. NEDENİ dürüstçe söylemek zorundayız; "zaten optimize"
        // demek, görsellerin atlanmış olduğu durumlarda yanlış bilgidir.
        if (!pdfState.output.compress) {
            showResult(`${failedNote}${head}.${compressOffNote}`, 'warning');
        } else if (compressReport && compressReport.skipped.length > 0) {
            // Nedenleri tek tek yaz: "desteklenmeyen biçim" genel bir ifadedir,
            // kullanıcı hangi biçimin eksik olduğunu göremez.
            const reasons = [...new Set(compressReport.skipped.map((s) => s.reason))];
            showResult(
                `${failedNote}${head}. ${compressReport.replaced} görsel yeniden kodlandı, `
                + `ancak ${compressReport.skipped.length} görsel küçültülemedi `
                + `(${reasons.join(', ')}).`,
                'warning'
            );
        } else {
            // I9: `replaced > 0` iken "büyük görsel bulunamadı" demek yanlıştır.
            // Yeniden kodlama yapıldı ama dosya yine de büyüdüyse bu yazılır.
            const replaced = compressReport?.replaced || 0;
            showResult(
                replaced > 0
                    ? `${failedNote}${head}. ${replaced} görsel yeniden kodlandı ancak dosya `
                      + 'yine de büyüdü; kalite ayarını düşürmeyi deneyebilirsiniz.'
                    : 'Bu belgede sıkıştırılacak büyük görsel bulunamadı. Dosya zaten optimize durumda.',
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

// Kaliteli küçültmede görselin uzun kenarı için üst sınır (piksel): A4'ün
// uzun kenarı (11,69 inç) x hedef DPI. Telefon fotoğrafları çoğu zaman
// 400+ DPI'dır; asıl kazanç bu çözünürlük düşürmesinden gelir.
//   Düşük 150 DPI, Orta 200 DPI, Yüksek 300 DPI.
const RECODE_MAX_EDGE = { 0.5: 1754, 0.7: 2339, 0.85: 3508 };

// Yeniden kodlanan görsel en az bu oranda küçülmüyorsa orijinal korunur
// (kazanç yokken kaliteyi boşuna düşürmemek için).
const RECODE_MIN_GAIN = 0.95;

function pdfRecodeMaxEdge(quality) {
    return RECODE_MAX_EDGE[quality] || RECODE_MAX_EDGE[0.7];
}
// 1-bit dönüşümü için üst sınır: 40 MP üzeri görsel bellekte pahalıdır.
const MAX_ONEBIT_PIXELS = 40 * 1000 * 1000;

// 1.6: 1-bit dönüşümü öncesi görsel sözlüğü BU beyaz listedeki anahtarlarla
// SINIRLI olmalıdır. Başka bir anahtar varsa (özellikle /Decode, /Mask,
// /DecodeParms, /SMask, dizi filtre, /Intent…) dönüşüm YENİ sözlükte o
// anahtarı KAYBEDER — ör. /Decode [1 0] taşıyan saf siyah-beyaz bir görsel
// ters çevrilerek 1-bit'e paketlenirse, yeni görselde /Decode olmadığı için
// görünüm TERS ÇEVRİLMİŞ olur. Bu yüzden beyaz liste dışı anahtar taşıyan
// görsel ATLANIR (dönüştürülmez).
const ONEBIT_ALLOWED_KEYS = new Set([
    'Type', 'Subtype', 'Width', 'Height', 'BitsPerComponent',
    'ColorSpace', 'Filter', 'Length', 'Interpolate'
]);

// --- Kayıpsız sıkıştırma (varsayılan yöntem) -------------------------------

/**
 * FNV-1a 32-bit. `crypto.subtle` `file://` üzerinde güvenli bağlam olmadığı
 * için kullanılamaz; saf JS gerekiyor. Çakışma ihtimali önemsizdir: eşitlik
 * kararı verilmeden önce bayt bayt da doğrulanır.
 */
function pdfHashBytes(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/**
 * 1.5: aynı İÇERİĞE sahip yinelenen akışları (görseller, yazı tipi
 * dosyaları, ICC profilleri, Form XObject'ler vb.) tekilleştirir. HİÇBİR
 * piksel değişmez.
 *
 * Eşitlik = içerik BAYTLARI birebir aynı VE sözlüğün (`dict.toString()`)
 * BİREBİR aynı olması. Yalnızca baytlar karşılaştırılırsa, aynı bayt + farklı
 * /Decode ya da /ColorSpace taşıyan iki görsel yanlışlıkla BİRLEŞTİRİLİR ve
 * biri BOZULUR (bkz. 1.5 fixture'ı `same-bytes-diff-decode.pdf`).
 *
 * Katalog ve sayfa düğümleri zaten AKIŞ değildir (yalnızca sözlüktür), o
 * yüzden bu taramaya hiç girmezler; /Metadata AÇIKÇA hariç tutulur.
 *
 * HER ÇIKTIDA (sıkıştırma açık/kapalı fark etmez) çağrılır — piksellere
 * dokunulmaz, yalnızca aynı içeriği paylaşan nesneler tek referansa iner.
 *
 * Dönüş: {deduped, dedupedBytes}
 */
function pdfDedupeStreams(doc) {
    const { PDFName, PDFDict, PDFArray } = PDFLib;
    let deduped = 0;
    let dedupedBytes = 0;

    // 1) Akışları içerik hash'iyle eşle. Önce kayıt, sonra referansları
    //    değiştirme: hash çakışmaları ve eksik nesneler yanlışlıkla
    //    birleştirilmesin diye baytlar VE sözlük de karşılaştırılır.
    const objects = doc.context.enumerateIndirectObjects();
    const byHash = new Map();
    const keeperByRef = new Map();   // yinelenen PDFRef -> tutan PDFRef
    // enumerateIndirectObjects() [PDFRef, nesne] ÇİFTLERİ verir.
    for (const [ref, obj] of objects) {
        if (!obj || !obj.contents || !obj.dict) continue;   // yalnızca AKIŞLAR
        const type = String(obj.dict.lookup(PDFName.of('Type')) ?? '');
        if (type === '/Metadata') continue;                 // /Metadata hariç

        const hash = pdfHashBytes(obj.contents);
        const dictKey = obj.dict.toString();
        const bucket = byHash.get(hash);
        if (bucket) {
            const same = bucket.find((k) => {
                if (k.dictKey !== dictKey) return false;     // A1.5: sözlük de eşleşmeli
                const other = doc.context.lookup(k.ref);
                const a = other.contents;
                const b = obj.contents;
                if (a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
                return true;
            });
            if (same) {
                keeperByRef.set(ref.toString(), same.ref);
                deduped++;
                dedupedBytes += obj.contents.length;
                continue;
            }
            bucket.push({ ref, dictKey });
        } else {
            byHash.set(hash, [{ ref, dictKey }]);
        }
    }

    if (keeperByRef.size > 0) {
        // 2) Nesne AĞACINI özyinelemeli gez ve yinelenen referansları tutana
        //    yönlendir. Yalnızca üst düzey sözlükler taranırsa işe yaramaz:
        //    A4 normalizasyonundan sonra her sayfanın görseli kendi Form
        //    XObject'inin RESOURCES sözlüğünde, o sözlük de çoğu zaman
        //    dolaylı (indirect) değil, gömülü durumdadır.
        const swap = (value) => keeperByRef.get(value?.toString?.()) || value;
        const seen = new Set();
        const walk = (value, depth) => {
            if (!value || depth > 32) return;
            if (value instanceof PDFArray) {
                for (let i = 0; i < value.size(); i++) {
                    const current = value.get(i);
                    const next = swap(current);
                    if (next !== current) value.set(i, next);
                    else walk(next, depth + 1);
                }
                return;
            }
            if (value instanceof PDFDict) {
                if (seen.has(value)) return;
                seen.add(value);
                for (const [key, current] of [...value.entries()]) {
                    const next = swap(current);
                    if (next !== current) value.set(key, next);
                    else walk(next, depth + 1);
                }
            }
        };
        for (const [, obj] of objects) {
            // Akışların sözlüğü de gezilir (Form XObject kaynakları burada).
            if (obj instanceof PDFDict) walk(obj, 0);
            else if (obj && obj.contents && obj.dict) walk(obj.dict, 0);
        }
    }

    return { deduped, dedupedBytes };
}

/**
 * Görünüme etkisi olmayan, yalnızca boyuta katkısı olan üst veri girdilerini
 * atar (XMP Metadata, sayfa PieceInfo, belge Thumb). Yalnızca KULLANICI
 * kayıpsız sıkıştırmayı AÇIKÇA seçtiğinde çağrılır (bkz. pdfBuildOutput) —
 * sıkıştırma kapalıyken belge üst verisine dokunulmaz.
 * Dönüş: silinen anahtar sayısı.
 */
function pdfStripMetadata(doc) {
    const { PDFName } = PDFLib;
    let metadataStripped = 0;
    const catalog = doc.catalog;
    for (const key of ['Metadata', 'PieceInfo', 'Requirements']) {
        if (catalog.has(PDFName.of(key))) {
            catalog.delete(PDFName.of(key));
            metadataStripped++;
        }
    }
    for (const page of doc.getPages()) {
        for (const key of ['PieceInfo', 'Thumb']) {
            if (page.node.has(PDFName.of(key))) {
                page.node.delete(PDFName.of(key));
                metadataStripped++;
            }
        }
    }
    return metadataStripped;
}

/**
 * Kayıpsız yöntemin TAMAMI: tekilleştirme + üst veri temizliği + 1-bit
 * dönüşümü + kullanılmayan nesne budaması. HİÇBİR piksel değişmez.
 *
 * Kurgusal belge (imza, dilekçe) için "görünüm aynı kalsın" şartı: bu yüzden
 * burada yalnızca bayt bayt kayıpsız işlemler yapılır.
 *
 * Dönüş: {deduped, dedupedBytes, metadataStripped, oneBit, pruned}
 */
async function pdfLosslessOptimize(doc) {
    const dedupe = pdfDedupeStreams(doc);
    const metadataStripped = pdfStripMetadata(doc);

    // 1-bit dönüşümü — YALNIZCA birebir kayıpsızsa. Görsel çözülür; pikselin
    // TAMAMI 0 ya da 255 ise (ara ton sıfır) 1-bit olarak paketlenir.
    // Fotoğraf veya kenar yumuşatma içeren tarama bu testi geçmez; geçse
    // bile birebir aynı görünür.
    const oneBit = await pdfConvertExactOneBit(doc);

    // Kullanılmayan nesneleri at. pdf-lib `save()` context'teki TÜM dolaylı
    // nesneleri serileştirir; tekilleştirilen ya da 1-bit'e çevrilen
    // görsellerin ESKİ kopyaları dosyada kalır ve tasarruf tamamen boşa
    // gider. Katalogdan ulaşılabilir olanlar tutulur.
    const pruned = pdfPruneUnusedObjects(doc);

    return { deduped: dedupe.deduped, dedupedBytes: dedupe.dedupedBytes, metadataStripped, oneBit, pruned };
}


/**
 * Katalogdan ulaşılamayan dolaylı nesneleri siler.
 * pdf-lib `save()` tüm context'i yazdığı için, referanssız kalan nesneler
 * (tekilleştirme ve 1-bit dönüşümünden sonra eski görseller) dosyada kalır.
 * Dönüş: silinen nesne sayısı.
 */
function pdfPruneUnusedObjects(doc) {
    const { PDFArray, PDFDict, PDFName } = PDFLib;
    const context = doc.context;
    const reachable = new Set();
    const queue = [];

    // KÖK: bir PDFRef görülürse kuyruğa alınır; nesne BFS ile çözülür.
    // (Yalnızca "köklerde geçen ref'ler" tutulursa hiçbir şey ulaşılamaz.)
    const visitValue = (value, depth) => {
        if (!value || depth > 64) return;
        if (value.tag) {                                   // PDFRef
            const key = value.toString();
            if (reachable.has(key)) return;
            reachable.add(key);
            queue.push(value);
            return;
        }
        if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i++) visitValue(value.get(i), depth + 1);
            return;
        }
        if (value instanceof PDFDict) {
            for (const [, v] of value.entries()) visitValue(v, depth + 1);
            return;
        }
        // AKIŞ: Form XObject'in kaynak sözlüğü akışın İÇİNDEDİR ve PDFStream
        // PDFDict DEĞİLDİR. Bu dal olmadan o sözlük ulaşılamaz sayılır.
        if (value && value.contents && value.dict) visitValue(value.dict, depth + 1);
    };

    for (const [key, value] of Object.entries(context.trailerInfo || {})) {
        if (key === 'ID') continue;                        // bayt dizisi, referans değil
        visitValue(value, 0);
    }
    visitValue(doc.catalog, 0);
    for (const page of doc.getPages()) visitValue(page.node, 0);

    while (queue.length > 0) {
        const ref = queue.pop();
        visitValue(context.lookup(ref), 0);
    }

    let removed = 0;
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
        if (reachable.has(ref.toString())) continue;
        // Savunma: bir şüpheli durumda (sayfa düğümü vb.) silme.
        const type = obj?.dict?.lookup ? String(obj.dict.lookup(PDFName.of('Type'))) : '';
        const objType = obj instanceof PDFDict ? String(obj.lookup(PDFName.of('Type'))) : '';
        if (type.includes('/Page') || objType.includes('/Page')) continue;
        if (obj instanceof PDFArray || obj instanceof PDFDict) {
            // Yapıda gerçekten kullanılmayan sözlük/ dizi: silinir.
        } else if (obj && obj.contents) {
            // Akış (görsel/form): silinir.
        } else {
            continue;                                      // bilinmeyen tür: dokunma
        }
        context.delete(ref);
        removed++;
    }
    return removed;
}

/** Bir görselin pikselleri tamamen 0/255 ise 1-bit + Flate'e çevirir. */
async function pdfConvertExactOneBit(doc) {
    const { PDFName, PDFRawStream } = PDFLib;
    let converted = 0;

    const images = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!obj || !obj.contents || !obj.dict) continue;
        const subtype = obj.dict.lookup(PDFName.of('Subtype'));
        const isImage = subtype && subtype.asString
            ? `/${subtype.decodeText()}` === '/Image'
            : String(subtype) === '/Image';
        if (isImage) images.push([ref, obj]);
    }

    const replacement = new Map();
    for (const [ref, obj] of images) {
        const dict = obj.dict;
        if (Number(dict.lookup(PDFName.of('BitsPerComponent'))) !== 8) continue;
        const w = Number(dict.lookup(PDFName.of('Width')));
        const h = Number(dict.lookup(PDFName.of('Height')));
        if (!w || !h || w * h > MAX_ONEBIT_PIXELS) continue;
        if (dict.has(PDFName.of('SMask'))) continue;

        // 1.6: sözlük BEYAZ LİSTE dışı bir anahtar taşıyorsa atla — yeni
        // 1-bit görsel yalnızca beyaz listedeki anahtarlarla yazılır, başka
        // bir anahtar (ör. /Decode) sessizce KAYBOLUR ve görünüm bozulabilir.
        let hasForeignKey = false;
        for (const [key] of dict.entries()) {
            const keyText = key.asString ? key.decodeText() : String(key).replace(/^\//, '');
            if (!ONEBIT_ALLOWED_KEYS.has(keyText)) { hasForeignKey = true; break; }
        }
        if (hasForeignKey) continue;
        // Filtre yalnızca TEKİL /FlateDecode olmalı (dizi filtre ya da
        // DCTDecode/CCITTFaxDecode gibi başka bir kodlama desteklenmez).
        const filterVal = dict.lookup(PDFName.of('Filter'));
        if (filterVal !== undefined && String(filterVal) !== '/FlateDecode') continue;

        let rgba = null;
        try {
            ({ pixels: rgba } = await pdfDecodePixels(obj, 8, w, h));
        } catch (err) {
            rgba = null;   // çözülemedi: dokunma
        }
        if (!rgba) continue;

        let pure = true;
        for (let i = 0; i < rgba.length; i += 4) {
            const v = rgba[i];
            if (v !== 0 && v !== 255) { pure = false; break; }
            if (rgba[i + 1] !== v || rgba[i + 2] !== v) { pure = false; break; }
        }
        if (!pure) continue;

        // 1-bit paketleme (MSBFirst, her satırda tam bayt).
        const stride = Math.ceil(w / 8);
        const packed = new Uint8Array(stride * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (rgba[(y * w + x) * 4] === 255) {
                    packed[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
                }
            }
        }
        const deflated = await pdfDeflate(packed);
        if (!deflated || deflated.length >= obj.contents.length) continue;

        const newDict = doc.context.obj({
            Type: 'XObject', Subtype: 'Image',
            Width: w, Height: h, BitsPerComponent: 1,
            // context.obj() dizeyi PDFName.of() ile ada çevirir; baştaki '/'
            // KONULMAZ, yoksa ad '/#2FDeviceGray' olur, görüntüleyici görseli
            // hiç çizmez ve sayfa BOŞ görünür.
            ColorSpace: 'DeviceGray', Filter: 'FlateDecode'
        });
        const newRef = doc.context.register(PDFRawStream.of(newDict, deflated));
        replacement.set(ref.toString(), newRef);
        converted++;
    }

    if (replacement.size > 0) {
        const swap = (value) => replacement.get(value?.toString?.()) || value;
        const seen = new Set();
        const walk = (value, depth) => {
            if (!value || depth > 32) return;
            if (value instanceof PDFLib.PDFArray) {
                for (let i = 0; i < value.size(); i++) {
                    const current = value.get(i);
                    const next = swap(current);
                    if (next !== current) value.set(i, next); else walk(next, depth + 1);
                }
                return;
            }
            if (value instanceof PDFLib.PDFDict) {
                if (seen.has(value)) return;
                seen.add(value);
                for (const [key, current] of [...value.entries()]) {
                    const next = swap(current);
                    if (next !== current) value.set(key, next); else walk(next, depth + 1);
                }
            }
        };
        for (const [, obj] of doc.context.enumerateIndirectObjects()) {
            if (obj instanceof PDFLib.PDFDict) walk(obj, 0);
            else if (obj && obj.contents && obj.dict) walk(obj.dict, 0);
        }
    }
    return converted;
}

/** zlib (deflate) SIKIŞTIRIR (DecompressionStream'in tersi). */
async function pdfDeflate(data) {
    if (typeof CompressionStream !== 'function') return null;
    try {
        const stream = new Blob([data]).stream()
            .pipeThrough(new CompressionStream('deflate'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
        return null;
    }
}

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
// --- Kayıplı sıkıştırma: gömülü görselleri JPEG olarak yeniden kodla --------
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
    if (filter && String(filter) === '/DCTDecode') return pdfRecodeJpeg(xobj, quality);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return 'geçersiz ölçü';
    }
    // Şeffaflık maskesi olan görseller atlanır: alfa kanalı yeniden kodlamayla
    // bozulabilir. Bu bilinçli bir sınırdır, kullanıcıya bildirilir.
    if (dict.has(PDFName.of('SMask'))) return 'şeffaflık maskesi olan görsel';

    // PNG/TIFF PREDICTOR: satırlar fark alınarak saklanmıştır. Bu çözümleyici
    // predictor'ı TERSİNE ÇEVİRMEZ; inflate edilen baytlar doğrudan piksel
    // sanılırsa görsel gürültüye döner. "Bozuk ama başarılı görünen" çıktı,
    // görseli hiç yeniden kodlamaktan kötüdür → atlanır.
    const parms = dict.lookup(PDFName.of('DecodeParms'));
    if (parms) {
        const parmDict = parms.contents ? parms.dict : parms;
        const predictor = Number(parmDict.lookup(PDFName.of('Predictor')));
        if (Number.isFinite(predictor) && predictor !== 1) return 'PNG predictor kodlanmış görsel';
    }

    const raw = xobj.contents;
    if (!raw || raw.length < MIN_RECODE_BYTES) return 'çok küçük';

    try {
        const { pixels, channels } = await pdfDecodePixels(xobj, bits, width, height);
        if (!pixels) return 'renk uzayı desteklenmiyor';

        // /Decode [1 0] ters çevirme belirtir. Yeniden kodlanan görsel de aynı
        // /Decode ile yazıldığı için görünüm korunur; pikselleri ters çevirmiyoruz.
        const { jpeg, width: outW, height: outH } = await pdfEncodeJpeg(pixels, width, height, quality);
        xobj.contents = jpeg;
        dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        dict.set(PDFName.of('Width'), PDFLib.PDFNumber.of(outW));
        dict.set(PDFName.of('Height'), PDFLib.PDFNumber.of(outH));
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
            // PDFStream'da `.doc` alanı YOKTUR (pdf-lib 1.17) — önceki kod
            // `xobj.doc?.context` arıyordu, hep `undefined` buluyor ve N her
            // zaman 3 varsayılıyordu. 4 kanallı (CMYK) profiller bu yüzden
            // RGB sanılıp sessizce bozuluyordu. Bağlam `dict.context`'tedir.
            const context = dict.context || xobj.context;
            const profile = context ? context.lookup(cs.lookup(1)) : null;
            const profileDict = profile?.contents ? profile.dict : profile;
            const n = profileDict && typeof profileDict.lookup === 'function'
                ? Number(profileDict.lookup(PDFName.of('N')))
                : NaN;
            // Profil okunamıyorsa ya da 4 kanal (CMYK) ise desteklenmiyor.
            if (!Number.isFinite(n) || (n !== 3 && n !== 1)) return { pixels: null };
            channels = n;
            sampleBytes = n;
        } else if (head === '/Indexed') {
            // Paletin taban renk uzayı ya DeviceGray (1) ya DeviceRGB (3)
            // olmalıdır. CMYK tabanlı palet (4) sessizce yanlış renk verir.
            const base = name(cs.lookup(1));
            if (base !== '/DeviceGray' && base !== '/DeviceRGB') return { pixels: null };
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
            // Palet yetersizse indeksler undefined'a düşer ve Uint8ClampedArray
            // onu 0'a çevirir: sessizce SİYAH pikseller. Önceden doğrula.
            if (!Number.isInteger(hival) || hival < 0) return { pixels: null };
            if (bytes.length < (hival + 1) * channels) return { pixels: null };
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

/** Uzun kenarı `maxEdge`'i aşmayacak hedef ölçü (oran korunur). */
function pdfScaledSize(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}

/** Bir çizilebilir kaynağı (canvas / ImageBitmap) hedef ölçüde JPEG'e kodlar. */
async function pdfDrawToJpeg(source, width, height, quality) {
    const canvas = window.OffscreenCanvas
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas bağlamı alınamadı');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    const blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
        : await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * RGBA pikselleri JPEG olarak kodlar; uzun kenar kaliteye göre sınırlanır.
 * Dönüş: {jpeg, width, height} — ölçü küçülmüş olabilir.
 */
async function pdfEncodeJpeg(rgba, width, height, quality) {
    const full = window.OffscreenCanvas
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const context = full.getContext('2d');
    if (!context) throw new Error('Canvas bağlamı alınamadı');
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    const size = pdfScaledSize(width, height, pdfRecodeMaxEdge(quality));
    const jpeg = await pdfDrawToJpeg(full, size.width, size.height, quality);
    return { jpeg, ...size };
}

/**
 * JPEG'den EXIF/APP1 bölümlerini çıkarır. PDF görüntüleyiciler JPEG içindeki
 * EXIF yön etiketini YOK SAYAR; tarayıcı ise çözerken UYGULAR. Etiket
 * çözmeden önce silinmezse yeniden kodlanan görsel yan döner.
 */
function pdfStripJpegApp1(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
    const parts = [bytes.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff) {
        const marker = bytes[i + 1];
        if (marker === 0xda) break;                       // SOS: görüntü verisi başlar
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (len < 2) break;
        if (marker !== 0xe1) parts.push(bytes.subarray(i, i + 2 + len));
        i += 2 + len;
    }
    parts.push(bytes.subarray(i));
    return pdfConcatBytes(parts);
}

/**
 * Gömülü bir JPEG'i (DCTDecode) kaliteli küçültme için yeniden kodlar:
 * uzun kenar kaliteye göre sınırlanır, seçilen kalitede JPEG yazılır.
 * Yalnızca KALİTELİ KÜÇÜLTMEDE çağrılır; "Birleştir" ve kayıpsız yöntem
 * JPEG baytlarına dokunmaz.
 *
 * Güvenli olmayan durumlar ATLANIR (görünüm bozulmasın):
 *  - CMYK / 4 kanallı ICC / Separation: tarayıcı renkleri doğru çözemez
 *  - /Decode, /DecodeParms: yeni sözlükte anlamı korunamaz
 *  - /SMask, /Mask: ölçü değişince maske hizası bozulabilir
 * Kazanç yoksa (RECODE_MIN_GAIN) orijinal korunur.
 */
async function pdfRecodeJpeg(xobj, quality) {
    const { PDFName, PDFNumber } = PDFLib;
    const dict = xobj.dict;
    const raw = xobj.contents;
    if (!raw || raw.length < MIN_RECODE_BYTES) return 'çok küçük';
    if (dict.has(PDFName.of('Decode')) || dict.has(PDFName.of('DecodeParms'))) {
        return 'özel kodlamalı JPEG';
    }
    // Şeffaflık/maske taşıyan görselde ölçü değişirse maske hizası bozulabilir.
    if (dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask'))) {
        return 'şeffaflık maskesi olan görsel';
    }

    const cs = dict.lookup(PDFName.of('ColorSpace'));
    let supported = false;
    if (cs && typeof cs.lookupMaybe === 'function') {
        if (String(cs.lookup(0)) === '/ICCBased') {
            const context = dict.context || xobj.context;
            const profile = context ? context.lookup(cs.lookup(1)) : null;
            const n = Number((profile?.contents ? profile.dict : profile)?.lookup?.(PDFName.of('N')));
            supported = n === 1 || n === 3;
        }
    } else {
        supported = String(cs) === '/DeviceRGB' || String(cs) === '/DeviceGray';
    }
    if (!supported) return 'CMYK/özel renkli JPEG';

    const width = Number(dict.lookup(PDFName.of('Width')));
    const height = Number(dict.lookup(PDFName.of('Height')));
    let bitmap = null;
    try {
        bitmap = await createImageBitmap(new Blob([pdfStripJpegApp1(raw)], { type: 'image/jpeg' }));
        // Sözlük ile JPEG başlığı uyuşmuyorsa dokunma.
        if (bitmap.width !== width || bitmap.height !== height) return 'ölçü uyuşmuyor';

        const size = pdfScaledSize(width, height, pdfRecodeMaxEdge(quality));
        const jpeg = await pdfDrawToJpeg(bitmap, size.width, size.height, quality);
        if (jpeg.length >= raw.length * RECODE_MIN_GAIN) return 'daha fazla küçülmüyor';

        xobj.contents = jpeg;
        dict.set(PDFName.of('Width'), PDFNumber.of(size.width));
        dict.set(PDFName.of('Height'), PDFNumber.of(size.height));
        // Tarayıcı JPEG'i her zaman 3 kanallı (renkli) yazar.
        dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
        dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
        return 'ok';
    } catch (err) {
        console.warn('JPEG yeniden kodlanamadı, atlandı:', err);
        return 'çözülemedi';
    } finally {
        bitmap?.close?.();
    }
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
 *
 * 1.7: `landscape` açıkken YATAY render edilen (genişlik > yükseklik) sayfa
 * da YATAY A4'e basılır — pdfPlaceOnA4 ile AYNI kural (bkz. orada).
 */
async function pdfRasterizeToOutput(entries, quality, landscape = false) {
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
            // 1.7: render edilmiş görsel YATAYSA (genişlik > yükseklik) ve
            // seçenek açıksa, hedef de YATAY A4 alınır.
            const useLandscape = landscape && embedded.width > embedded.height;
            const targetW = useLandscape ? A4_HEIGHT : A4_WIDTH;
            const targetH = useLandscape ? A4_WIDTH : A4_HEIGHT;
            const target = out.addPage([targetW, targetH]);

            // Döndürülmüş sayfa yatay gelir; hedefe tekdüze sığdırıp ortala.
            const ratio = Math.min(targetW / embedded.width, targetH / embedded.height);
            const w = embedded.width * ratio;
            const h = embedded.height * ratio;
            target.drawImage(embedded, {
                x: (targetW - w) / 2,
                y: (targetH - h) / 2,
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

    // A8: kayıp modda atlanan sayfalar KULLANICIYA bildirilir. Ancak mesaj
    // BURADA gösterilmez: pdfOnBuildClick hemen ardından boyut özetini
    // yazar ve mesaj ezilirdi (kullanıcı 4 sayfalık dosyayı "zaten optimize"
    // diye sanıyordu). Bunun yerine çağırana verilir.
    // 1.8: belge başlığı, indirilen dosya adıyla (uzantısız) eşleşir.
    out.setTitle(pdfOutputFileName().replace(/\.pdf$/i, ''));
    out.setProducer('PDF Araçları (kira-sozlesmesi-olusturucu)');
    return {
        bytes: await out.save({ useObjectStreams: true }),
        rasterFailures: failed
            ? { count: failed, pages: failures.slice(0, 10), more: failures.length > 10 }
            : null
    };
}

// --- Bağlantılar -----------------------------------------------------------

function pdfSyncOutputState() {
    const compress = document.getElementById('pdf-opt-compress');
    const options = document.getElementById('pdf-compress-options');
    if (options && compress) options.hidden = !compress.checked;
    // Kalite seçenekleri YALNIZCA kayıplı yöntemde anlamlıdır.
    const mode = document.querySelector('input[name="pdf-compress-mode"]:checked')?.value || 'lossless';
    const qualityBlock = document.getElementById('pdf-quality-block');
    if (qualityBlock) qualityBlock.hidden = mode !== 'quality';
}

function pdfReadOutputState() {
    const lossy = document.getElementById('pdf-opt-lossy');
    const quality = document.querySelector('input[name="pdf-quality"]:checked');
    pdfState.output = {
        a4: document.getElementById('pdf-opt-a4')?.checked ?? true,
        // 1.7: varsayılan AÇIK (sayfadaki checkbox'ın varsayılanıyla aynı).
        landscape: document.getElementById('pdf-opt-landscape')?.checked ?? true,
        compress: document.getElementById('pdf-opt-compress')?.checked ?? false,
        // Varsayılan KAYIPSIZ: piksellere dokunulmaz.
        compressMode: document.querySelector('input[name="pdf-compress-mode"]:checked')?.value || 'lossless',
        lossy: lossy?.checked ?? false,
        quality: quality ? Number(quality.value) : 0.7
    };
    pdfSyncOutputState();
}

function pdfUpdateBuildButton() {
    const bar = document.getElementById('pdf-action-bar');
    const hasPages = pdfState.pages.length > 0;
    // Aksiyon çubuğu yalnızca işlenecek sayfa varken görünür.
    if (bar) bar.hidden = !hasPages;
    for (const id of ['pdf-build-btn', 'pdf-build-small-btn']) {
        const button = document.getElementById(id);
        if (button) button.disabled = !hasPages || pdfState.busy;
    }
    // Tek dosyada "Birleştir" anlamsızdır (sayfa silip/döndürüp kaydetmek).
    const many = pdfState.files.filter((f) => !f.error).length > 1;
    const label = document.getElementById('pdf-build-label');
    const smallLabel = document.getElementById('pdf-build-small-label');
    if (label) label.textContent = many ? 'Birleştir' : 'Kaydet';
    if (smallLabel) smallLabel.textContent = many ? 'Birleştir ve Küçült' : 'Küçültüp Kaydet';
}

(function initPdfOutput() {
    document.getElementById('pdf-opt-compress')?.addEventListener('change', () => {
        pdfReadOutputState();
        pdfSyncOutputState();
    });
    for (const id of ['#pdf-opt-a4', '#pdf-opt-landscape', '#pdf-opt-lossy']) {
        document.querySelector(id)?.addEventListener('change', pdfReadOutputState);
    }
    document.querySelectorAll('input[name="pdf-compress-mode"]').forEach((el) => {
        el.addEventListener('change', () => {
            pdfReadOutputState();
            pdfSyncOutputState();
        });
    });
    document.querySelectorAll('input[name="pdf-quality"]').forEach((el) => {
        el.addEventListener('change', pdfReadOutputState);
    });

    document.getElementById('pdf-build-btn')?.addEventListener('click', () => pdfOnBuildClick('plain'));
    document.getElementById('pdf-build-small-btn')?.addEventListener('click', () => pdfOnBuildClick('small'));
    pdfBus.on('files', pdfSyncOutputNamePlaceholder);
    pdfBus.on('files', pdfUpdateBuildButton);
    pdfSyncOutputNamePlaceholder();
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
// R2 testinde gömme hatasını simüle etmek için (monkeypatch) dışa açılır.
window.pdfBakeAnnotationsForA4 = pdfBakeAnnotationsForA4;
window.pdfLosslessOptimize = pdfLosslessOptimize;
