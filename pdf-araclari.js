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
        // Başarıyla yüklenmişse tekrar indirilmez.
        if (existing && existing.dataset.pdfLoaded === '1') return resolve();
        // Yarım kalan deneme varsa kaldırılır; aksi halde aynı src için
        // üst üste <script> etiketleri birikir ve yeniden deneme çalışmaz.
        existing?.remove();
        const s = document.createElement('script');
        s.src = src;
        s.dataset.pdfSrc = src;
        s.onload = () => { s.dataset.pdfLoaded = '1'; resolve(); };
        s.onerror = () => { s.remove(); reject(new Error('Yükleme hatası: ' + src)); };
        document.head.appendChild(s);
    });
}

// Kütüphane yüklenemediğinde "Tekrar Dene" çalışır (spec §6).
async function pdfRetryLibs() {
    const status = document.getElementById('pdf-libs-status');
    const showError = () => {
        if (!status) return;
        status.classList.add('is-error');
        status.classList.remove('is-ready');
        status.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> '
            + 'PDF araçları bileşenleri yüklenemedi. '
            + '<button class="btn btn-shadcn-outline" id="pdf-retry-libs-btn" '
            + 'type="button" onclick="pdfRetryLibs()">Tekrar Dene</button>';
    };

    if (status) {
        status.classList.remove('is-error');
        status.classList.remove('is-ready');
        status.innerHTML = '<i class="fa-solid fa-spinner"></i> Araçlar yükleniyor...';
    }
    try {
        await loadPdfLibs();
        if (status) {
            status.classList.add('is-ready');
            status.innerHTML = '<i class="fa-solid fa-circle-check"></i> Araçlar hazır';
        }
        pdfRenderFileList();
    } catch (err) {
        console.error('PDF araçları yüklenemedi', err);
        showError();
    }
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

// pdfState.files kaydı: {id, name, size, data, doc, pageCount, error}
// `data` ham bayt dizisidir (pdf.js küçük resim üretmek için kullanır),
// `size` dosyanın bayt cinsinden uzunluğudur.

// --- Biçimlendirme ve hata ayıklama ----------------------------------------

const MB = 1024 * 1024;
// Testlerin küçük değerlerle sınırı tetikleyebilmesi için window'a açılır.
const pdfLimits = { maxFileBytes: 50 * MB, maxTotalBytes: 150 * MB };
window.pdfLimits = pdfLimits;

const MEMORY_ERROR_PATTERNS = [
    'out of memory',
    'array buffer allocation failed',
    'array buffer too large',
    'cannot allocate memory'
];

function pdfIsMemoryError(message) {
    const text = String(message ?? '').toLowerCase();
    if (!text) return false;
    return MEMORY_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

function pdfFormatBytes(n) {
    if (!Number.isFinite(n)) return '-';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < MB) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
    return `${(n / MB).toFixed(1).replace('.', ',')} MB`;
}

// Yüklenemeyen dosyanın adını HTML'e güvenle yazmak için.
function pdfEscapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

const PDF_ERROR_MESSAGES = {
    encrypted:
        'Bu PDF şifreli. PDF\'yi bir PDF okuyucuda açıp <strong>Yazdır → PDF olarak kaydet</strong> ' +
        'ile şifresiz kopyasını alıp tekrar deneyin. Parola kırma desteklenmiyor.',
    invalid: 'geçerli bir PDF değil veya bozuk.',
    empty: 'içinde sayfa bulunamadı.',
    tooLarge:
        'Tarayıcı belleği sınırı nedeniyle 50 MB üzeri dosyalar işlenemez. ' +
        'Dosyayı bölebilir ya da önce sıkıştırabilirsiniz.',
    totalTooLarge:
        'Yüklenen dosyaların toplamı 150 MB sınırını aşıyor. Bellek sınırı nedeniyle işlem yapılamaz.',
    memory:
        'Tarayıcı belleği tükendi. Daha küçük dosyalarla veya daha az sayfa seçerek deneyin.'
};

// --- Durum ------------------------------------------------------------------
// `const` ile tanımlanan adlar klasik script'te window'a yazılmaz (yalnızca
// `function` ve `var` yazar). Testlerin ve hata ayıklamanın erişebilmesi için
// bunlar açıkça window'a atanır.

const pdfState = {
    files: [],        // {id, name, size, data, doc, pageCount, error}
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

// --- Dosya listesi ----------------------------------------------------------

function pdfRenderFileList() {
    const list = document.getElementById('pdf-file-list');
    if (!list) return;

    const rows = pdfState.files.map((file) => {
        if (file.error) {
            return `<div class="pdf-file-row is-error" data-file-id="${file.id}">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span class="pdf-file-name">${pdfEscapeHtml(file.name)}</span>
                <span class="pdf-file-meta">Yüklenemedi</span>
                <div class="pdf-file-error-msg">${file.error}</div>
            </div>`;
        }
        return `<div class="pdf-file-row" data-file-id="${file.id}">
            <i class="fa-solid fa-file-pdf"></i>
            <span class="pdf-file-name">${pdfEscapeHtml(file.name)}</span>
            <span class="pdf-file-meta">${file.pageCount} sayfa · ${pdfFormatBytes(file.size)}</span>
            <button class="pdf-page-btn" type="button" data-remove-file="${file.id}"
                    title="Dosyayı kaldır" aria-label="Dosyayı kaldır">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`;
    });

    list.innerHTML = rows.join('');
}

function pdfRemoveFile(fileId) {
    const index = pdfState.files.findIndex((f) => f.id === fileId);
    if (index === -1) return;
    pdfState.files.splice(index, 1);
    pdfState.pages = pdfState.pages.filter((p) => p.fileId !== fileId);
    // Geri alma yığını temizlenmeli: eski kayıtlar kaldırılmış dosyanın
    // sayfalarını geri getirir ve "Bilinmeyen dosya" kartları doğar.
    pdfState.undoStack = [];
    pdfBus.emit('files');
    pdfBus.emit('pages');
    pdfBus.emit('undo');
}

// --- Meşgul durumu ----------------------------------------------------------

function pdfSetBusy(isBusy) {
    pdfState.busy = isBusy;
    document.querySelectorAll('#pdf-araclari-form-block button, #pdf-araclari-form-block input')
        .forEach((el) => { el.disabled = isBusy; });
    pdfBus.emit('busy', isBusy);
}

// --- Dosya yükleme ----------------------------------------------------------

async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    // Meşguliyet sırasında yeni dosya kabul edilmez. Aksi halde pdfBuildOutput
    // iterasyon yaptığı dizi mutasyona uğrar ve ikinci bir pdfSetBusy(false)
    // butonları erken etkinleştirir.
    if (pdfState.busy) return;

    pdfSetBusy(true);
    try {
        await loadPdfLibs();

        for (const file of files) {
            const fileId = pdfState.nextFileId++;
            const record = { id: fileId, name: file.name, size: file.size, data: null, doc: null, pageCount: 0, error: null };

            // Boyut denetimi ayrıştırmadan ÖNCE yapılır: 60 MB bir dosyayı
            // ayrıştırmak dakikalar sürer ve tarayıcıyı kilitler.
            if (file.size > pdfLimits.maxFileBytes) {
                record.error = PDF_ERROR_MESSAGES.tooLarge;
                pdfState.files.push(record);
                pdfBus.emit('files');
                continue;
            }

            // Toplam sınır da ayrıştırmadan ÖNCE denetlenir. Yalnızca bu
            // dosya reddedilir; daha önce yüklenenler kullanıcının emeğidir.
            const runningTotal = pdfState.files.reduce((sum, f) => sum + f.size, 0);
            if (runningTotal + file.size > pdfLimits.maxTotalBytes) {
                record.error = PDF_ERROR_MESSAGES.totalTooLarge;
                pdfState.files.push(record);
                pdfBus.emit('files');
                continue;
            }

            try {
                const buffer = new Uint8Array(await file.arrayBuffer());
                const doc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: false });
                record.data = buffer;
                const pageCount = doc.getPageCount();

                if (!Number.isFinite(pageCount) || pageCount === 0) {
                    record.error = PDF_ERROR_MESSAGES.empty;
                } else {
                    record.doc = doc;
                    record.pageCount = pageCount;
                    for (let i = 0; i < pageCount; i++) {
                        pdfState.pages.push({
                            uid: pdfState.nextUid++,
                            fileId,
                            srcIndex: i,
                            rotation: 0,
                            thumbUrl: null,
                            thumbError: false
                        });
                    }
                }
            } catch (err) {
                console.error('PDF yüklenemedi:', file.name, err);
                record.error = /encrypt/i.test(String(err?.message || ''))
                    ? PDF_ERROR_MESSAGES.encrypted
                    : pdfIsMemoryError(err?.message)
                        ? PDF_ERROR_MESSAGES.memory
                        : PDF_ERROR_MESSAGES.invalid;
            }

            pdfState.files.push(record);
            pdfBus.emit('files');
        }

        pdfBus.emit('pages');
    } catch (err) {
        console.error('Dosya yükleme başarısız', err);
        pdfShowError('Yükleme', pdfIsMemoryError(err?.message)
            ? PDF_ERROR_MESSAGES.memory
            : 'Beklenmeyen bir hata oluştu.');
    } finally {
        pdfSetBusy(false);
    }
}

// Panel üstünde gösterilen genel hata kutusu.
function pdfShowError(fileName, message) {
    const list = document.getElementById('pdf-file-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'pdf-file-row is-error';
    row.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
        <span class="pdf-file-name">${pdfEscapeHtml(fileName)}</span>
        <div class="pdf-file-error-msg">${message}</div>`;
    list.prepend(row);
}

// --- Sekme açılışı ----------------------------------------------------------

(function initPdfTab() {
    const input = document.getElementById('pdf-file-input');
    const dropzone = document.getElementById('pdf-dropzone');

    document.getElementById('pdf-file-pick-btn')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', (e) => {
        addFiles(e.target.files);
        e.target.value = ''; // aynı dosya tekrar seçilebilsin
    });

    if (dropzone) {
        for (const type of ['dragenter', 'dragover']) {
            dropzone.addEventListener(type, (e) => {
                e.preventDefault();
                dropzone.classList.add('is-dragover');
            });
        }
        for (const type of ['dragleave', 'drop']) {
            dropzone.addEventListener(type, (e) => {
                e.preventDefault();
                dropzone.classList.remove('is-dragover');
            });
        }
        dropzone.addEventListener('drop', (e) => {
            if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
        });
    }

    // Dosya listesindeki "kaldır" butonları (olay delegasyonu).
    document.getElementById('pdf-file-list')?.addEventListener('click', (e) => {
        const button = e.target.closest('[data-remove-file]');
        if (button) pdfRemoveFile(Number(button.dataset.removeFile));
    });

    pdfBus.on('files', pdfRenderFileList);
    pdfBus.on('libs', () => {
        const status = document.getElementById('pdf-libs-status');
        if (status) {
            status.classList.add('is-ready');
            status.innerHTML = '<i class="fa-solid fa-circle-check"></i> Araçlar hazır';
        }
        pdfRenderFileList();
    });
})();

window.pdfEscapeHtml = pdfEscapeHtml;
window.pdfIsMemoryError = pdfIsMemoryError;
window.pdfFormatBytes = pdfFormatBytes;
window.pdfSetBusy = pdfSetBusy;
window.pdfShowError = pdfShowError;
window.pdfRemoveFile = pdfRemoveFile;
window.pdfRetryLibs = pdfRetryLibs;
window.addFiles = addFiles;
