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
// Hata ekranı index.html içinde de üretiliyordu; iki kopya birbirinden
// ayrışıyordu. Tek bir üretici kullanılır (A13).
function pdfLibsErrorHtml() {
    return '<i class="fa-solid fa-triangle-exclamation"></i> '
        + 'PDF araçları bileşenleri yüklenemedi. '
        + '<button class="btn btn-shadcn-outline" id="pdf-retry-libs-btn" '
        + 'type="button" onclick="pdfRetryLibs()">Tekrar Dene</button>';
}

async function pdfRetryLibs() {
    const status = document.getElementById('pdf-libs-status');
    const showError = () => {
        if (!status) return;
        status.classList.add('is-error');
        status.classList.remove('is-ready');
        status.innerHTML = pdfLibsErrorHtml();
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
        'Tarayıcı belleği tükendi. Daha küçük dosyalarla veya daha az sayfa seçerek deneyin.',
    heic:
        'iPhone fotoğrafı (HEIC) bu tarayıcıda açılamıyor. iPhone\'da <strong>Ayarlar → Kamera → '
        + 'Biçimler → En Uyumlu</strong> seçip fotoğrafı yeniden çekin ya da JPG olarak paylaşın.',
    image: 'görsel okunamadı (desteklenenler: PDF, JPG, PNG, TIFF).',
    tiff: (reason) => `Bu TIFF türü desteklenmiyor (${reason}). `
        + 'Dosyayı bir görüntüleyicide açıp <strong>PDF olarak kaydedin</strong> ve onu yükleyin.'
};

// --- Fotoğraftan PDF ----------------------------------------------------------

/** Dosyanın gerçek türü (uzantıya değil, ilk baytlara bakılır). */
function pdfSniffType(bytes) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if ((bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0)
        || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 0x2a || bytes[3] === 0x2b))) return 'tiff';
    const brand = String.fromCharCode(...bytes.subarray(4, 12));
    if (/^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand)) return 'heic';
    return 'pdf';   // bilinmeyen: PDF olarak denenir, olmazsa "geçerli PDF değil" hatası
}

/**
 * JPEG'in EXIF yön etiketini okur (1-8). Yoksa ya da okunamazsa 1.
 * Telefon pikselleri sensör yönünde kaydeder, doğru yönü bu etikete yazar.
 */
function pdfJpegOrientation(bytes) {
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff) {
        const marker = bytes[i + 1];
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker === 0xda || len < 2) break;
        if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'Exif') {
            const t = i + 10;                                   // TIFF başlığı
            const le = bytes[t] === 0x49;                       // 'II' küçük uçlu
            const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
            const u32 = (o) => (le
                ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
                : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
            const ifd = t + u32(t + 4);
            if (ifd + 2 > bytes.length) return 1;
            const count = u16(ifd);
            for (let k = 0; k < count; k++) {
                const e = ifd + 2 + k * 12;
                if (e + 12 > bytes.length) return 1;
                if (u16(e) === 0x0112) {
                    const v = u16(e + 8);
                    return v >= 1 && v <= 8 ? v : 1;
                }
            }
            return 1;
        }
        i += 2 + len;
    }
    return 1;
}

// EXIF yönü -> sayfa /Rotate (saat yönünde). Aynalı yönler (2, 4, 5, 7)
// telefonlarda pratikte görülmez; en yakın döndürmeyle gösterilir.
const EXIF_TO_ROTATE = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/**
 * Fotoğrafı tek sayfalık bir PDF'e çevirir. Görsel BOZULMAZ:
 *  - JPEG baytları olduğu gibi gömülür (yeniden sıkıştırma YOK)
 *  - PNG kayıpsız (Flate) gömülür
 *  - EXIF yönü piksellere dokunmadan sayfa döndürmesine (/Rotate) çevrilir
 * Sayfa, fotoğrafın oranındadır; uzun kenarı A4'ün uzun kenarı kadardır.
 * "A4'e sığdır" açıkken (varsayılan) çıktıda A4'e yerleşir.
 */
async function pdfImageToPdf(bytes, kind) {
    const doc = await PDFLib.PDFDocument.create();
    const image = kind === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const A4_LONG = 841.89;
    const scale = A4_LONG / Math.max(image.width, image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    const page = doc.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    const rotate = kind === 'jpeg' ? EXIF_TO_ROTATE[pdfJpegOrientation(bytes)] : 0;
    if (rotate) page.setRotation(PDFLib.degrees(rotate));
    return new Uint8Array(await doc.save());
}

// --- Durum ------------------------------------------------------------------
// `const` ile tanımlanan adlar klasik script'te window'a yazılmaz (yalnızca
// `function` ve `var` yazar). Testlerin ve hata ayıklamanın erişebilmesi için
// bunlar açıkça window'a atanır.

const pdfState = {
    files: [],        // {id, name, size, data, doc, pageCount, error}
    loadError: null,  // son genel yükleme hatası (kalıcı)
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
            // Kaldırma düğmesi YOKTU: reddedilen dosya satırı kalıcı olarak
            // ekranda kalıyor ve kullanıcı onu temizleyemiyordu. Şimdi hem
            // elle kapatılabiliyor hem de birkaç saniye sonra kendiliğinden
            // kayboluyor (bkz. pdfDismissFileError).
            return `<div class="pdf-file-row is-error" data-file-id="${file.id}">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span class="pdf-file-name">${pdfEscapeHtml(file.name)}</span>
                <span class="pdf-file-meta">Yüklenemedi</span>
                <div class="pdf-file-error-msg">${file.error}</div>
                <button class="pdf-page-btn" type="button" data-dismiss-error="${file.id}"
                        title="Uyarıyı kapat" aria-label="Uyarıyı kapat">
                    <i class="fa-solid fa-xmark"></i>
                </button>
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

    // I15: genel yükleme hatası kalıcıdır; liste yeniden kurulduğunda da
    // görünür kalır.
    if (pdfState.loadError) {
        rows.unshift(`<div class="pdf-file-row is-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span class="pdf-file-name">${pdfEscapeHtml(pdfState.loadError.fileName)}</span>
            <div class="pdf-file-error-msg">${pdfEscapeHtml(pdfState.loadError.message)}</div>
        </div>`);
    }

    list.innerHTML = rows.join('');
}

// Reddedilen dosya uyarısı 3 saniye sonra kendiliğinden kaybolur. Kaldırma
// düğmesi olmayan bir hata satırı kalıcı kalırsa liste kapatılamayan uyarılarla
// dolar ve kullanıcı temizleyemez. Elle kapatma düğmesi de var
// (data-dismiss-error).
const ERROR_DISMISS_MS = 3000;

function pdfDismissFileError(fileId) {
    const index = pdfState.files.findIndex((f) => f.id === fileId);
    if (index === -1) return;
    // Yalnızca HATA kaydı temizlenir; yüklenmiş belgeler kullanıcının emeğidir.
    if (!pdfState.files[index].error) return;
    pdfState.files.splice(index, 1);
    pdfBus.emit('files');
}

function pdfScheduleErrorDismiss(fileId) {
    setTimeout(() => pdfDismissFileError(fileId), ERROR_DISMISS_MS);
}

function pdfRemoveFile(fileId) {
    const index = pdfState.files.findIndex((f) => f.id === fileId);
    if (index === -1) return;
    pdfState.files.splice(index, 1);
    pdfState.pages = pdfState.pages.filter((p) => p.fileId !== fileId);
    // Geri alma yığını TÜMÜYLE silinmemeli: kullanıcının diğer dosyalardaki
    // düzenlemeleri geri alınabilir kalmalı. Her kayıt TÜM sayfaların anlık
    // görüntüsü olduğu için, kaldırılan dosyanın sayfaları kayıttan da
    // düşürülür (aksi halde geri alınca "Bilinmeyen dosya" kartları doğar);
    // kalan dosyaların düzenlemeleri korunur.
    pdfState.undoStack = pdfState.undoStack
        .map((entry) => ({ ...entry, pages: entry.pages.filter((p) => p.fileId !== fileId) }))
        .filter((entry) => entry.pages.length > 0);

    // pdf.js belgesi yok edilir; yoksa worker belleği tekrarlanan
    // yükle/kaldır döngüsünde sürekli büyür.
    window.pdfDocCacheForRelease?.(fileId);

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
                pdfScheduleErrorDismiss(record.id);
                continue;
            }

            // Toplam sınır da ayrıştırmadan ÖNCE denetlenir. Yalnızca bu
            // dosya reddedilir; daha önce yüklenenler kullanıcının emeğidir.
            const runningTotal = pdfState.files.reduce((sum, f) => sum + f.size, 0);
            if (runningTotal + file.size > pdfLimits.maxTotalBytes) {
                record.error = PDF_ERROR_MESSAGES.totalTooLarge;
                pdfState.files.push(record);
                pdfBus.emit('files');
                pdfScheduleErrorDismiss(record.id);
                continue;
            }

            try {
                let buffer = new Uint8Array(await file.arrayBuffer());
                const kind = pdfSniffType(buffer);
                if (kind === 'heic') throw new Error('HEIC');
                if (kind === 'tiff') {
                    try {
                        buffer = await pdfTiffToPdf(buffer);
                    } catch (tiffErr) {
                        if (tiffErr?.name === 'PdfTiffUnsupported') throw new Error('TIFFU:' + tiffErr.message);
                        throw new Error('IMAGE: ' + (tiffErr?.message || ''));
                    }
                }
                if (kind === 'jpeg' || kind === 'png') {
                    try {
                        buffer = await pdfImageToPdf(buffer, kind);
                    } catch (imageErr) {
                        throw new Error('IMAGE: ' + (imageErr?.message || ''));
                    }
                }
                const doc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: false });
                record.data = buffer;
                const pageCount = doc.getPageCount();

                if (!Number.isFinite(pageCount) || pageCount === 0) {
                    record.error = PDF_ERROR_MESSAGES.empty;
                } else {
                    // Dosya eklemek de geri alınabilir bir işlemdir; kayıt
                    // sayfalar EKLENMEDEN alınır (pdf-sayfalar.js).
                    pdfRecordUndo('Dosya eklendi: ' + record.name);
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
                // Dosya adı yazılmaz: kişisel veri (evrak/sözleşme adı)
                // konsola sızmasın. Dosyanın KENDİSİ zaten hata satırında görünür.
                console.error('Bir dosya yüklenemedi (' + pdfFormatBytes(record.size) + '):', err);
                const msg = String(err?.message || '');
                record.error = msg === 'HEIC'
                    ? PDF_ERROR_MESSAGES.heic
                    : msg.startsWith('TIFFU:')
                    ? PDF_ERROR_MESSAGES.tiff(pdfEscapeHtml(msg.slice(6)))
                    : msg.startsWith('IMAGE:')
                    ? PDF_ERROR_MESSAGES.image
                    : /encrypt/i.test(msg)
                    ? PDF_ERROR_MESSAGES.encrypted
                    : pdfIsMemoryError(err?.message)
                        ? PDF_ERROR_MESSAGES.memory
                        : PDF_ERROR_MESSAGES.invalid;
            }

            pdfState.files.push(record);
            pdfBus.emit('files');
            if (record.error) pdfScheduleErrorDismiss(record.id);
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
// I15: bu kutu bir sonraki `files` render'ında SİLİNİYORDU (liste içeriği
// baştan kuruluyor). Hata, durumda tutulur ve liste render'ında yeniden basılır.
function pdfShowError(fileName, message) {
    const list = document.getElementById('pdf-file-list');
    if (!list) return;
    pdfState.loadError = { fileName, message };
    pdfRenderFileList();
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
        if (button) {
            pdfRemoveFile(Number(button.dataset.removeFile));
            return;
        }
        const dismiss = e.target.closest('[data-dismiss-error]');
        if (dismiss) {
            pdfDismissFileError(Number(dismiss.dataset.dismissError));
            return;
        }
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
window.pdfDismissFileError = pdfDismissFileError;
window.pdfShowError = pdfShowError;   // test edilebilirlik: kalıcılık sözleşmesi
window.pdfRetryLibs = pdfRetryLibs;
window.pdfLibsErrorHtml = pdfLibsErrorHtml;
window.addFiles = addFiles;
