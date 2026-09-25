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

/** Bir sayfanın küçük resmini üretir. Hata olursa yalnızca o kart işaretlenir. */
async function pdfRenderThumb(entry) {
    const file = pdfFileFor(entry.fileId);
    if (!file || !file.doc) return;
    try {
        const doc = await pdfGetDoc(file);
        const page = await doc.getPage(entry.srcIndex + 1);
        const viewport = page.getViewport({ scale: THUMB_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        entry.thumbUrl = canvas.toDataURL('image/jpeg', THUMB_QUALITY);
    } catch (err) {
        console.error('Küçük resim üretilemedi', err);
        entry.thumbError = true;
    }
}

// --- Geri alma --------------------------------------------------------------

const UNDO_LIMIT = 20;

// Yalnızca sayfa dizisi geri alınır; thumbUrl referansları kopyalanmaz.
function pdfRecordUndo(label) {
    pdfState.undoStack.push({
        label,
        pages: pdfState.pages.map((p) => ({ ...p }))
    });
    while (pdfState.undoStack.length > UNDO_LIMIT) pdfState.undoStack.shift();
    pdfUpdateUndoButton();
}

function pdfUndo() {
    const entry = pdfState.undoStack.pop();
    if (!entry) return;
    pdfState.pages = entry.pages;
    pdfUpdateUndoButton();
    pdfBus.emit('pages');
}

function pdfUpdateUndoButton() {
    const button = document.getElementById('pdf-undo-btn');
    if (button) button.disabled = pdfState.undoStack.length === 0;
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
        grid.innerHTML = '<p class="pdf-page-label">Henüz dosya eklenmedi.</p>';
        return;
    }

    const cards = pdfState.pages.map((page, index) => {
        const file = pdfFileFor(page.fileId);
        const fileName = file ? file.name : 'Bilinmeyen dosya';
        const pageNo = file && file.doc ? page.srcIndex + 1 : '?';
        const total = file ? file.pageCount : '?';
        const rotationBadge = page.rotation
            ? `<span class="pdf-page-badge">${page.rotation}&deg;</span>`
            : '';
        const thumb = page.thumbUrl
            ? `<img class="pdf-page-thumb" src="${page.thumbUrl}" alt="Sayfa ${pageNo} önizlemesi">`
            : page.thumbError
                ? '<div class="pdf-page-thumb-placeholder">Önizlenemedi</div>'
                : '<div class="pdf-page-thumb-placeholder">Yükleniyor...</div>';

        return `<div class="pdf-page-card" draggable="true" data-uid="${page.uid}" data-index="${index}">
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
    const pending = pdfState.pages.filter((p) => !p.thumbUrl && !p.thumbError);
    const immediate = pending.slice(0, IMMEDIATE_THUMBS);
    const deferred = pending.slice(IMMEDIATE_THUMBS);

    const schedule = (entry) => {
        pdfRenderThumb(entry).then(() => {
            if (pdfState.pages.includes(entry)) {
                const card = document.querySelector(`[data-uid="${entry.uid}"]`);
                if (card) {
                    card.querySelector('.pdf-page-thumb, .pdf-page-thumb-placeholder')
                        ?.remove();
                    const holder = document.createElement('div');
                    holder.innerHTML = entry.thumbUrl
                        ? `<img class="pdf-page-thumb" src="${entry.thumbUrl}" alt="Sayfa önizlemesi">`
                        : '<div class="pdf-page-thumb-placeholder">Önizlenemedi</div>';
                    card.insertBefore(holder.firstElementChild, card.querySelector('.pdf-page-badge, .pdf-page-label'));
                }
            }
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
window.pdfRenderThumb = pdfRenderThumb;
