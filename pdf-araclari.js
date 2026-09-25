/* =============================================================================
 * pdf-araclari.js — PDF Araçları sekmesi: durum, olay veriyolu ve yükleme
 *
 * Kütüphaneler (pdf-lib, pdf.js) bu dosyada tanımlanan sözleşmeleri kullanır.
 * Kütüphaneler statik <script> etiketi olarak değil, çalışma anında DOM'a
 * enjekte edilerek yüklenir: PDF aracını kullanmayan ziyaretçi ~710 KB
 * indirmez.
 * ========================================================================== */

'use strict';

// --- Kütüphane yükleme ------------------------------------------------------

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-pdf-src="${src}"]`);
        if (existing && existing.dataset.pdfLoaded === '1') return resolve();
        const s = document.createElement('script');
        s.src = src;
        s.dataset.pdfSrc = src;
        s.onload = () => { s.dataset.pdfLoaded = '1'; resolve(); };
        s.onerror = () => reject(new Error('Yükleme hatası: ' + src));
        document.head.appendChild(s);
    });
}

async function loadPdfLibs() {
    if (pdfState.libsLoaded) return;
    if (pdfState.libsLoading) return pdfState.libsLoading;

    pdfState.libsLoading = (async () => {
        await loadScript('pdf-lib.min.js');
        await loadScript('pdf.min.js');
        pdfState.libsLoaded = true;
        pdfBus.emit('libs');
    })();

    try {
        await pdfState.libsLoading;
    } catch (err) {
        pdfState.libsLoading = null; // tekrar denenebilir olsun
        throw err;
    }
}

// --- Durum ------------------------------------------------------------------
// `const` ile tanımlanan adlar klasik script'te window'a yazılmaz (yalnızca
// `function` ve `var` yazar). Testlerin ve hata ayıklamanın erişebilmesi için
// bunlar açıkça window'a atanır.

const pdfState = {
    files: [],        // {id, name, bytes, doc, pageCount, error}
    pages: [],        // {uid, fileId, srcIndex, rotation, thumbUrl, thumbError}
    output: { a4: true, compress: false, quality: 0.7, lossy: false },
    undoStack: [],
    busy: false,
    libsLoaded: false,
    libsLoading: null,
    nextUid: 1,
    nextFileId: 1
};
window.pdfState = pdfState;

const pdfBus = (() => {
    const handlers = {};
    return {
        on(event, handler) {
            (handlers[event] = handlers[event] || []).push(handler);
        },
        emit(event, payload) {
            for (const handler of handlers[event] || []) handler(payload);
        }
    };
})();
window.pdfBus = pdfBus;

// --- Sekme açılışı ----------------------------------------------------------

(function initPdfTab() {
    const pick = () => {
        const input = document.getElementById('pdf-file-input');
        if (input) input.click();
    };
    document.getElementById('pdf-file-pick-btn')?.addEventListener('click', pick);
})();
