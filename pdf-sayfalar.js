/* =============================================================================
 * pdf-sayfalar.js — küçük resim ızgarası ve sayfa düzenleme
 *
 * Sayfa nesneleri kopyalanmaz; pdfState.pages yalnızca
 * {uid, fileId, srcIndex, rotation} taşır. Sıralama, silme ve döndürme
 * bu yüzden anında tamamlanır; pahalı iş yalnızca küçük resim üretimindedir.
 * ========================================================================== */

'use strict';

const THUMB_SCALE = 0.25;
const THUMB_QUALITY = 0.7;
const IMMEDIATE_THUMBS = 12;

// fileId -> pdf.js PDFDocumentProxy. Aynı dosya için belge bir kez açılır.
const pdfDocCache = new Map();
let workerReady = null;

function pdfFileFor(fileId) {
    return pdfState.files.find((f) => f.id === fileId) || null;
}

async function pdfEnsureWorker() {
    if (workerReady) return workerReady;
    workerReady = (async () => {
        await loadScript('pdf.worker.min.js');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    })();
    try {
        await workerReady;
    } catch (err) {
        workerReady = null;
        throw err;
    }
}

async function pdfGetDoc(file) {
    if (pdfDocCache.has(file.id)) return pdfDocCache.get(file.id);
    await pdfEnsureWorker();
    // pdf.js veriyi worker'a TRANSFER edip ayırıyor (detach). Aynı baytlar
    // çıktı üretiminde de gerekebildiği için kopya verilir.
    const bytes = file.data.slice();
    const task = pdfjsLib.getDocument({ data: bytes });
    const doc = await task.promise;
    pdfDocCache.set(file.id, doc);
    return doc;
}

/**
 * Kaynak sayfanın kendi /Rotate değeri. Kullanıcının eklediği döndürme bunun
 * ÜSTÜNE değil ÜSTÜNE EKLENİR (pdf-cikti.js ile aynı kural).
 */
function pdfSourceRotation(file, srcIndex) {
    if (!file?.doc) return 0;
    try {
        const raw = file.doc.getPage(srcIndex).node.get(PDFLib.PDFName.of('Rotate'));
        const value = Number(raw?.toString?.() ?? raw);
        if (Number.isFinite(value)) return ((Math.round(value / 90) * 90) % 360 + 360) % 360;
    } catch { /* okunamayan sayfa: döndürme yok sayılır */ }
    return 0;
}

function pdfEffectiveThumbRotation(entry, file) {
    return (pdfSourceRotation(file, entry.srcIndex) + (entry.rotation || 0)) % 360;
}

/** Bir sayfanın küçük resmini üretir. Hata olursa yalnızca o kart işaretlenir. */
async function pdfRenderThumb(entry) {
    const file = pdfFileFor(entry.fileId);
    if (!file || !file.doc) return;
    pdfActiveRenders++;
    try {
        const doc = await pdfGetDoc(file);
        const page = await doc.getPage(entry.srcIndex + 1);
        // Küçük resim döndürmeyi YANSITMALI: kullanıcı ne görüyorsa basılacak
        // odur. pdf.js 3.x'te `page.rotate` SALT OKUNURDUR; döndürme
        // getViewport ve render seçenekleriyle verilir.
        const rotation = pdfEffectiveThumbRotation(entry, file);
        const viewport = page.getViewport({ scale: THUMB_SCALE, rotation });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport, rotation }).promise;
        entry.thumbUrl = canvas.toDataURL('image/jpeg', THUMB_QUALITY);
    } catch (err) {
        console.error('Küçük resim üretilemedi', err);
        entry.thumbError = true;
    } finally {
        pdfActiveRenders--;
        if (pdfActiveRenders === 0 && pdfPendingDestroy.size) {
            for (const doc of pdfPendingDestroy) {
                try { Promise.resolve(doc.destroy()).catch(() => {}); } catch (_) { /* yoksay */ }
            }
            pdfPendingDestroy.clear();
        }
    }
}

// --- Geri alma --------------------------------------------------------------

const UNDO_LIMIT = 20;

/**
 * Yalnızca sayfa dizisi geri alınır; thumbUrl referansları kopyalanmaz.
 * Kaldırılan dosya adlarının kaydı tutulur: pdfRemoveFile yalnızca o
 * kayıtları düşürür, kullanıcının diğer düzenlemeleri geri alınabilir kalır.
 *
 * `files` kimlik listesi de saklanır. Dosya EKLEME işlemi de geri
 * alınabilir olmalıdır: aksi halde "yükle → geri al" sırası, sonradan
 * yüklenen dosyanın sayfalarını çıktıdan sessizce siler (dosya satırı
 * "3 sayfa" derken çıktıda 3 sayfa bulunmaz).
 *
 * `thumbnailPending` KOPYALANMAZ: kopyalanırsa geri alınan sayfa
 * "üretiliyor" görünür ama yeniden planlanmaz ve kart kalıcı olarak
 * "Yükleniyor..." ekranında takılır.
 */
function pdfRecordUndo(label) {
    pdfState.undoStack.push({
        label,
        pages: pdfState.pages.map((p) => {
            const { thumbnailPending, ...rest } = p;
            return { ...rest };
        }),
        files: pdfState.files.map((f) => f.id)
    });
    while (pdfState.undoStack.length > UNDO_LIMIT) pdfState.undoStack.shift();
    pdfUpdateUndoButton();
}

function pdfUndo() {
    const entry = pdfState.undoStack.pop();
    if (!entry) return;
    pdfState.pages = entry.pages;

    // Kayıttan SONRA eklenen dosyalar geri almanın bir parçasıdır: geri al
    // onları hem listeden hem çıktıdan kaldırır. Böylece dosya satırı ile
    // çıktıdaki sayfa sayısı birbirini tutar.
    if (Array.isArray(entry.files)) {
        const known = new Set(entry.files);
        for (const file of [...pdfState.files]) {
            if (!known.has(file.id)) pdfRemoveFile(file.id);
        }
    }

    pdfUpdateUndoButton();
    pdfBus.emit('pages');
}

function pdfUpdateUndoButton() {
    const button = document.getElementById('pdf-undo-btn');
    if (!button) return;
    const last = pdfState.undoStack[pdfState.undoStack.length - 1];
    button.disabled = !last;
    // Kullanıcı neyi geri alacağını görsün.
    const label = document.getElementById('pdf-undo-label');
    if (label) label.textContent = last ? last.label : '';
}

// --- Düzenleme işlemleri ----------------------------------------------------

function pdfRotatePage(uid) {
    const page = pdfState.pages.find((p) => p.uid === uid);
    if (!page) return;
    pdfRecordUndo('Döndürme');
    page.rotation = (page.rotation + 90) % 360;
    pdfBus.emit('pages');
}

function pdfRotateAll() {
    if (pdfState.pages.length === 0) return;
    pdfRecordUndo('Tümünü döndür');
    for (const page of pdfState.pages) page.rotation = (page.rotation + 90) % 360;
    pdfBus.emit('pages');
}

function pdfDeletePage(uid) {
    const index = pdfState.pages.findIndex((p) => p.uid === uid);
    if (index === -1) return;
    pdfRecordUndo('Silme');
    pdfState.pages.splice(index, 1);
    pdfBus.emit('pages');
}

function pdfResetEdits() {
    if (pdfState.pages.length === 0) return;
    pdfRecordUndo('Sıfırlama');
    pdfState.pages.sort((a, b) => a.fileId - b.fileId || a.srcIndex - b.srcIndex);
    for (const page of pdfState.pages) page.rotation = 0;
    pdfBus.emit('pages');
}

/** Kartı hedef konuma taşır. */
function pdfMovePage(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= pdfState.pages.length) return;
    if (toIndex < 0 || toIndex >= pdfState.pages.length) return;
    pdfRecordUndo('Sıralama');
    const [moved] = pdfState.pages.splice(fromIndex, 1);
    pdfState.pages.splice(toIndex, 0, moved);
    pdfBus.emit('pages');
}

// --- Izgara render'ı -------------------------------------------------------

const idle = (fn) => (window.requestIdleCallback
    ? window.requestIdleCallback(fn, { timeout: 500 })
    : setTimeout(fn, 0));

function pdfRenderGrid() {
    const grid = document.getElementById('pdf-page-grid');
    if (!grid) return;

    if (pdfState.pages.length === 0) {
        // Dosyalar yüklü ama tüm sayfalar silinmiş olabilir; iki durum
        // farklı mesaj ister.
        grid.innerHTML = pdfState.files.some((f) => f.doc)
            ? '<p class="pdf-page-label">Tüm sayfalar silindi. '
              + 'Yeni bir çıktı üretmek için "Geri Al" düğmesini kullanabilir '
              + 'veya yeni dosya ekleyebilirsiniz.</p>'
            : '<p class="pdf-page-label">Henüz dosya eklenmedi.</p>';
        return;
    }

    // Yalnizca degisiklik yapilan kartlar yeniden cizilir. 300 sayfada her
    // turda 300 <img> yeniden kurmak her tiklamada yuzlerce JPEG kodlamasi
    // demek ve arayuzu dondurur.
    const previous = new Map(
        [...grid.querySelectorAll('.pdf-page-card')].map((el) => [Number(el.dataset.uid), el])
    );
    // `rerender`: kartın HTML'i değişmeli (konumu, rozeti, etiketi).
    // `rethumb`: küçük resim yeniden ÜRETİLMELİ. Sıra değişikliği ikisini
    // gerektirmez: sayfa görseli aynıdır, yalnızca sıra numarası değişir.
    // Önceden tek `changed` kümesi ikisini birden tetikliyordu; 60 sayfada tek
    // bir SİLME 59 küçük resmi yeniden kodluyordu.
    const rerender = new Set();
    const rethumb = new Set();
    pdfState.pages.forEach((page, index) => {
        const el = previous.get(page.uid);
        if (!el) { rerender.add(page.uid); return; }
        const shownIndex = Number(el.dataset.index);
        const shownRotation = Number(el.dataset.rotation || 0);
        if (shownIndex !== index || shownRotation !== (page.rotation || 0)) {
            rerender.add(page.uid);
        }
        if (shownRotation !== (page.rotation || 0)) rethumb.add(page.uid);
    });

    const cards = pdfState.pages.map((page, index) => {
        if (previous.has(page.uid) && !rerender.has(page.uid)) {
            return previous.get(page.uid).outerHTML;
        }
        // Donduyse kucuk resim yeniden uretilmeli. Siralamadan dolayi degisen
        // kartlarda gerek yok.
        if (rethumb.has(page.uid) && previous.has(page.uid)) {
            page.thumbUrl = null;
            page.thumbError = false;
        }
        const file = pdfFileFor(page.fileId);
        const fileName = file ? file.name : 'Bilinmeyen dosya';
        const pageNo = file && file.doc ? page.srcIndex + 1 : '?';
        const total = file ? file.pageCount : '?';
        const effective = pdfEffectiveThumbRotation(page, file);
        const rotationBadge = effective
            ? `<span class="pdf-page-badge">${effective}&deg;</span>`
            : '';
        const thumb = page.thumbUrl
            ? `<img class="pdf-page-thumb" src="${page.thumbUrl}" alt="Sayfa ${pageNo} önizlemesi">`
            : page.thumbError
                ? '<div class="pdf-page-thumb-placeholder">Önizlenemedi</div>'
                : '<div class="pdf-page-thumb-placeholder">Yükleniyor...</div>';

        return `<div class="pdf-page-card" draggable="true" data-uid="${page.uid}" data-index="${index}" data-rotation="${page.rotation || 0}">
            <div class="pdf-page-actions">
                <button class="pdf-page-btn" type="button" data-action="rotate" data-uid="${page.uid}"
                        title="90&deg; döndür" aria-label="Sayfayı döndür"><i class="fa-solid fa-rotate-right"></i></button>
                <button class="pdf-page-btn" type="button" data-action="delete" data-uid="${page.uid}"
                        title="Sayfayı sil" aria-label="Sayfayı sil"><i class="fa-solid fa-trash"></i></button>
            </div>
            ${thumb}
            ${rotationBadge}
            <div class="pdf-page-label">Sayfa ${pageNo}/${total}<br>${pdfEscapeHtml(fileName)}</div>
        </div>`;
    });

    grid.innerHTML = cards.join('');

    // Küçük resimleri üret: ilk sayfalar hemen, kalanlar boşta.
    // thumbnailPending olan sayfalar ZATEN üretiliyor; yeniden planlanmaz.
    const pending = pdfState.pages.filter(
        (p) => !p.thumbUrl && !p.thumbError && !p.thumbnailPending);
    const immediate = pending.slice(0, IMMEDIATE_THUMBS);
    const deferred = pending.slice(IMMEDIATE_THUMBS);

    const schedule = (entry) => {
        entry.thumbnailPending = true;
        pdfRenderThumb(entry).then(() => {
            entry.thumbnailPending = false;
            if (!pdfState.pages.includes(entry)) return;
            // Yalnizca gorseli yerinde degistir; kartin geri kalani korunur.
            const card = document.querySelector(`.pdf-page-card[data-uid="${entry.uid}"]`);
            if (!card) return;
            const old = card.querySelector('.pdf-page-thumb, .pdf-page-thumb-placeholder');
            const holder = document.createElement('div');
            holder.innerHTML = entry.thumbUrl
                ? `<img class="pdf-page-thumb" src="${entry.thumbUrl}" alt="Sayfa önizlemesi">`
                : '<div class="pdf-page-thumb-placeholder">Önizlenemedi</div>';
            if (old) old.replaceWith(holder.firstElementChild);
        });
    };

    for (const entry of immediate) schedule(entry);
    for (const entry of deferred) idle(() => schedule(entry));
}

function pdfInitPageGrid() {
    const grid = document.getElementById('pdf-page-grid');
    if (!grid) return;

    pdfBus.on('pages', pdfRenderGrid);

    grid.addEventListener('click', (e) => {
        const button = e.target.closest('[data-action]');
        if (!button) return;
        e.preventDefault();
        e.stopPropagation();
        const uid = Number(button.dataset.uid);
        if (button.dataset.action === 'rotate') pdfRotatePage(uid);
        if (button.dataset.action === 'delete') pdfDeletePage(uid);
    });

    let dragFrom = null;

    grid.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.pdf-page-card');
        if (!card) return;
        dragFrom = Number(card.dataset.index);
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Chromium sürükleme başlatmak için veri aktarımı ister.
        try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch { /* yoksay */ }
    });

    grid.addEventListener('dragend', () => {
        dragFrom = null;
        grid.querySelectorAll('.is-dragging, .is-drop-target')
            .forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
    });

    grid.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const card = e.target.closest('.pdf-page-card');
        grid.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        if (card && dragFrom !== null) card.classList.add('is-drop-target');
    });

    grid.addEventListener('drop', (e) => {
        e.preventDefault();
        const card = e.target.closest('.pdf-page-card');
        const from = dragFrom;
        dragFrom = null;
        grid.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        if (!card || from === null) return;
        pdfMovePage(from, Number(card.dataset.index));
    });

    // Meşgul durumu bittiğinde geri-al butonu yeniden değerlendirilir:
    // pdfSetBusy tüm butonları yeniden etkinleştirir.
    pdfBus.on('busy', (isBusy) => { if (!isBusy) pdfUpdateUndoButton(); });
    pdfBus.on('undo', pdfUpdateUndoButton);

    document.getElementById('pdf-undo-btn')?.addEventListener('click', pdfUndo);
    document.getElementById('pdf-rotate-all-btn')?.addEventListener('click', pdfRotateAll);
    document.getElementById('pdf-reset-edits-btn')?.addEventListener('click', pdfResetEdits);

    pdfRenderGrid();
    pdfUpdateUndoButton();
}

pdfInitPageGrid();

window.pdfRotatePage = pdfRotatePage;
window.pdfRotateAll = pdfRotateAll;
window.pdfDeletePage = pdfDeletePage;
window.pdfResetEdits = pdfResetEdits;
window.pdfUndo = pdfUndo;
window.pdfMovePage = pdfMovePage;
// pdf-araclari.js, girdi silindiğinde önbellekteki pdf.js belgesini yok eder.
// `destroy()` YALNIZCA ÇALIŞAN İŞ YOKKEN çağrılabilir; çağırma sırasında bir
// render beklemede olabilir ve bu durumda render hata verir. Bu yüzden önce
// bekleyen render sayısı sıfırlanır, iş bittikten sonra destroy edilir.
let pdfActiveRenders = 0;
let pdfPendingDestroy = new Set();

function pdfDestroyDocWhenIdle(doc) {
    if (pdfActiveRenders === 0) {
        // destroy() bir Promise döndürür; reddederse belge zaten yok demektir.
        try { Promise.resolve(doc.destroy()).catch(() => {}); } catch (_) { /* yoksay */ }
        return;
    }
    pdfPendingDestroy.add(doc);
}

window.pdfDocCacheForRelease = (fileId) => {
    const doc = pdfDocCache.get(fileId);
    pdfDocCache.delete(fileId);
    if (doc) pdfDestroyDocWhenIdle(doc);
    return doc;
};

window.pdfRenderThumb = pdfRenderThumb;
