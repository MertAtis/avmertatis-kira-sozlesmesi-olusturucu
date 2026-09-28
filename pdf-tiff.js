// TIFF'ten PDF. Resmî evrakın görünümü BİREBİR korunur:
//  - tek şeritli CCITT G3/G4 (faks) ve JPEG: sıkıştırılmış baytlar OLDUĞU GİBİ
//    PDF'e aktarılır (yeniden kodlama yok)
//  - çok şeritli CCITT / JPEG: şeritler pdf.js ile çizilip (1:1) kayıpsız
//    Flate olarak yazılır — PDF'te bağımsız şeritler tek akışta birleşemez
//  - LZW / Deflate / PackBits / sıkıştırmasız: çözülüp kayıpsız Flate
//  - sayfa boyutu TIFF'in kendi çözünürlüğünden (DPI) hesaplanır
//  - Orientation etiketi piksellere dokunmadan sayfa /Rotate'una çevrilir
// Desteklenmeyen tür (döşemeli, alfa kanallı, 16 bit, BigTIFF...) açık
// bir nedenle REDDEDİLİR; tahminle bozuk çıktı üretilmez.

class PdfTiffUnsupported extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'PdfTiffUnsupported';
    }
}

const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// Orientation (274) -> sayfa /Rotate (saat yönünde). Aynalı yönler (2, 4, 5, 7)
// pratikte görülmez; en yakın döndürmeyle gösterilir.
const TIFF_ORIENT_TO_ROTATE = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

const TIFF_BIT_REVERSE = new Uint8Array(256).map((_, b) => {
    let r = 0;
    for (let k = 0; k < 8; k++) if (b & (1 << k)) r |= 0x80 >> k;
    return r;
});

// --- Ayrıştırma -------------------------------------------------------------

/** Tüm IFD'leri (sayfaları) etiket haritası olarak döndürür. */
function tiffParse(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = bytes[0] === 0x49;
    const u16 = (o) => dv.getUint16(o, le);
    const u32 = (o) => dv.getUint32(o, le);
    if (u16(2) === 43) throw new PdfTiffUnsupported('BigTIFF');
    if (u16(2) !== 42) throw new Error('TIFF başlığı geçersiz');

    const ifds = [];
    const seen = new Set();
    let ifd = u32(4);
    while (ifd && !seen.has(ifd) && ifds.length < 5000) {
        seen.add(ifd);
        if (ifd + 2 > bytes.length) throw new Error('TIFF dizini dosya dışında');
        const n = u16(ifd);
        const tags = new Map();
        for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (e + 12 > bytes.length) throw new Error('TIFF dizini kesik');
            const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
            const size = TIFF_TYPE_SIZE[type];
            if (!size) continue;
            const total = size * count;
            const at = total <= 4 ? e + 8 : u32(e + 8);
            if (at + total > bytes.length) continue;              // bozuk etiket: yok say
            if (type === 7 || type === 2) {                        // UNDEFINED / ASCII: ham bayt
                tags.set(tag, bytes.subarray(at, at + total));
                continue;
            }
            const values = new Array(count);
            for (let k = 0; k < count; k++) {
                const o = at + k * size;
                switch (type) {
                    case 1: case 6: values[k] = bytes[o]; break;
                    case 3: case 8: values[k] = u16(o); break;
                    case 4: case 9: values[k] = u32(o); break;
                    case 5: case 10: { const d = u32(o + 4); values[k] = d ? u32(o) / d : 0; break; }
                    default: values[k] = 0;
                }
            }
            tags.set(tag, values);
        }
        ifds.push(tags);
        ifd = u32(ifd + 2 + n * 12);
    }
    return ifds;
}

/** Sayfa bilgisini okur ve desteklenmeyen türü AÇIK nedenle reddeder. */
function tiffPageInfo(tags) {
    const first = (tag, def) => (tags.get(tag)?.[0] ?? def);
    const width = first(256, 0);
    const height = first(257, 0);
    const bpsAll = tags.get(258) || [1];
    const bps = bpsAll[0];
    const spp = first(277, 1);
    const compression = first(259, 1);
    const photometric = first(262, bps === 1 ? 0 : 1);
    const offsets = tags.get(273);
    const counts = tags.get(279);

    if (!width || !height) throw new Error('TIFF ölçüsü yok');
    if (tags.has(322) || tags.has(324)) throw new PdfTiffUnsupported('döşemeli TIFF');
    if (!offsets || !counts || offsets.length !== counts.length) throw new Error('TIFF şerit bilgisi yok');
    if (tags.has(338)) throw new PdfTiffUnsupported('şeffaflık kanalı');
    if (first(284, 1) === 2 && spp > 1) throw new PdfTiffUnsupported('düzlemsel renk düzeni');
    if (bpsAll.some((b) => b !== bps)) throw new PdfTiffUnsupported('karışık bit derinliği');
    if (![1, 3, 4, 5, 7, 8, 32946, 32773].includes(compression)) {
        throw new PdfTiffUnsupported(`sıkıştırma türü ${compression}`);
    }
    if (![0, 1, 2, 3, 5, 6].includes(photometric)) throw new PdfTiffUnsupported(`renk türü ${photometric}`);
    if (photometric === 6 && compression !== 7) throw new PdfTiffUnsupported('sıkıştırmasız YCbCr');
    if (photometric === 5 && (spp !== 4 || first(332, 1) !== 1)) throw new PdfTiffUnsupported('CMYK dışı mürekkep seti');
    if ((photometric === 2 || photometric === 6) && spp !== 3) throw new PdfTiffUnsupported('renk kanalı sayısı');
    if ((photometric <= 1 || photometric === 3) && spp !== 1) throw new PdfTiffUnsupported('kanal sayısı');
    if (![1, 2, 4, 8].includes(bps)) throw new PdfTiffUnsupported(`${bps} bit derinlik`);
    if ((photometric === 2 || photometric === 5 || compression === 7) && bps !== 8) {
        throw new PdfTiffUnsupported(`${bps} bit renkli görsel`);
    }
    if ((compression === 3 || compression === 4) && (bps !== 1 || photometric > 1)) {
        throw new PdfTiffUnsupported('faks sıkıştırması siyah-beyaz olmayan görselde');
    }
    const predictor = first(317, 1);
    if (predictor !== 1 && !(predictor === 2 && bps === 8)) throw new PdfTiffUnsupported(`tahminleyici ${predictor}`);

    const rowsPerStrip = Math.min(first(278, height) || height, height);
    const stripCount = Math.ceil(height / rowsPerStrip);
    if (offsets.length < stripCount) throw new Error('TIFF şeritleri eksik');

    // Çözünürlük: birim 2 = inç, 3 = cm, 1 = birimsiz (yalnızca en-boy oranı).
    let xdpi = first(282, 0), ydpi = first(283, 0);
    const unit = first(296, 2);
    if (unit === 3) { xdpi *= 2.54; ydpi *= 2.54; }
    if (!(xdpi > 0 && ydpi > 0)) { xdpi = ydpi = 200; }
    else if (unit === 1) { ydpi = 200 * ydpi / xdpi; xdpi = 200; }

    return {
        width, height, bps, spp, compression, photometric,
        fillOrder: first(266, 1), predictor, rowsPerStrip, stripCount,
        offsets, counts,
        t4Options: first(292, 0),
        colorMap: tags.get(320),
        jpegTables: tags.get(347),
        rotate: TIFF_ORIENT_TO_ROTATE[first(274, 1)] || 0,
        widthPt: width * 72 / xdpi,
        heightPt: height * 72 / ydpi
    };
}

// --- Çözücüler ---------------------------------------------------------------

/** TIFF LZW (MSB önce, erken kod genişliği değişimi). */
function tiffLzwDecode(src, expected) {
    if (src[0] === 0 && (src[1] & 1)) throw new PdfTiffUnsupported('eski tip LZW');
    const out = new Uint8Array(expected);
    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const length = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; length[i] = 1; }
    let next = 258, width = 9, prev = -1, bitPos = 0, op = 0;
    const totalBits = src.length * 8;

    const firstChar = (code) => { while (prefix[code] >= 0) code = prefix[code]; return suffix[code]; };
    const emit = (code) => {
        const len = length[code];
        let p = op + len - 1;
        for (let c = code; c >= 0; c = prefix[c], p--) if (p < expected) out[p] = suffix[c];
        op += len;
    };
    const add = (p, c) => {
        if (next >= 4096) return;
        prefix[next] = p; suffix[next] = c; length[next] = length[p] + 1;
        next++;
        if (next === 511) width = 10; else if (next === 1023) width = 11; else if (next === 2047) width = 12;
    };

    while (op < expected && bitPos + width <= totalBits) {
        const byte = bitPos >> 3;
        const v = (src[byte] << 16) | ((src[byte + 1] || 0) << 8) | (src[byte + 2] || 0);
        const code = (v >> (24 - (bitPos & 7) - width)) & ((1 << width) - 1);
        bitPos += width;
        if (code === 257) break;
        if (code === 256) { next = 258; width = 9; prev = -1; continue; }
        if (prev === -1) { emit(code); prev = code; continue; }
        if (code < next) {
            emit(code);
            add(prev, firstChar(code));
        } else {
            add(prev, firstChar(prev));
            emit(next - 1);
        }
        prev = code;
    }
    return out;
}

function tiffPackBitsDecode(src, expected) {
    const out = new Uint8Array(expected);
    let i = 0, op = 0;
    while (i < src.length && op < expected) {
        const n = src[i++];
        if (n < 128) {
            for (let k = 0; k <= n && op < expected; k++) out[op++] = src[i++];
        } else if (n > 128) {
            const b = src[i++];
            for (let k = 0; k < 257 - n && op < expected; k++) out[op++] = b;
        }
    }
    return out;
}

async function tiffInflate(src) {
    const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function tiffStripBytes(bytes, info, i) {
    const o = info.offsets[i], c = info.counts[i];
    if (o + c > bytes.length) throw new Error('TIFF şeridi dosya dışında');
    let data = bytes.subarray(o, o + c);
    if (info.fillOrder === 2) data = data.map((b) => TIFF_BIT_REVERSE[b]);
    return data;
}

const tiffStripRows = (info, i) => Math.min(info.rowsPerStrip, info.height - i * info.rowsPerStrip);

/** LZW / Deflate / PackBits / sıkıştırmasız: tüm sayfanın ham satırları. */
async function tiffDecodeRaw(bytes, info) {
    const rowBytes = Math.ceil(info.width * info.spp * info.bps / 8);
    const out = new Uint8Array(rowBytes * info.height);
    for (let i = 0; i < info.stripCount; i++) {
        const expected = rowBytes * tiffStripRows(info, i);
        const src = tiffStripBytes(bytes, info, i);
        let data;
        switch (info.compression) {
            case 1: data = src; break;
            case 5: data = tiffLzwDecode(src, expected); break;
            case 8: case 32946: data = await tiffInflate(src); break;
            case 32773: data = tiffPackBitsDecode(src, expected); break;
            default: throw new PdfTiffUnsupported(`sıkıştırma türü ${info.compression}`);
        }
        out.set(data.subarray(0, Math.min(expected, data.length)), i * info.rowsPerStrip * rowBytes);
    }
    // Yatay fark tahmini (predictor 2, 8 bit): her satırda soldan toplanarak geri alınır.
    if (info.predictor === 2) {
        for (let y = 0; y < info.height; y++) {
            const row = y * rowBytes;
            for (let x = info.spp; x < info.width * info.spp; x++) {
                out[row + x] = (out[row + x] + out[row + x - info.spp]) & 0xff;
            }
        }
    }
    return out;
}

// --- PDF görsel nesneleri -----------------------------------------------------

function tiffCcittParms(info, rows) {
    const parms = {
        K: info.compression === 4 ? -1 : (info.t4Options & 1 ? 1 : 0),
        Columns: info.width,
        Rows: rows,
        BlackIs1: true,
        // TIFF şeridinin sonunda blok sonu (RTC/EOFB) garanti DEĞİLDİR; satır
        // sayısı (Rows) belirleyicidir. Varsayılan (true) bırakılırsa çözücü
        // şeridin SON SATIRINI eksik çözer.
        EndOfBlock: false
    };
    if (info.compression === 3 && (info.t4Options & 4)) parms.EncodedByteAlign = true;
    return parms;
}

/** TIFF'in JPEGTables'ı ile şeridi tam bir JPEG'e birleştirir. */
function tiffFullJpeg(info, strip) {
    const tables = info.jpegTables;
    if (!tables || tables.length < 4) return strip;
    const head = tables.subarray(0, tables.length - 2);           // sondaki EOI atılır
    const out = new Uint8Array(head.length + strip.length - 2);
    out.set(head, 0);
    out.set(strip.subarray(2), head.length);                      // şeridin SOI'si atılır
    return out;
}

/** Görüntünün renk uzayı / Decode'u (ham ve 1:1 çizilmiş yollar için). */
function tiffColorEntries(doc, info) {
    switch (info.photometric) {
        case 0: return { ColorSpace: 'DeviceGray', Decode: [1, 0] };    // min-is-white
        case 1: return { ColorSpace: 'DeviceGray' };
        case 2: case 6: return { ColorSpace: 'DeviceRGB' };
        case 5: return { ColorSpace: 'DeviceCMYK' };
        case 3: {
            const n = 1 << info.bps;
            const map = info.colorMap;
            if (!map || map.length < 3 * n) throw new PdfTiffUnsupported('palet eksik');
            const pal = new Uint8Array(3 * n);
            for (let i = 0; i < n; i++) {
                pal[3 * i] = map[i] >> 8;
                pal[3 * i + 1] = map[n + i] >> 8;
                pal[3 * i + 2] = map[2 * n + i] >> 8;
            }
            const palRef = doc.context.register(doc.context.flateStream(pal));
            return { ColorSpace: doc.context.obj(['Indexed', 'DeviceRGB', n - 1, palRef]) };
        }
        default: throw new PdfTiffUnsupported(`renk türü ${info.photometric}`);
    }
}

/**
 * Çok şeritli CCITT/JPEG: şeritler geçici bir PDF sayfasına alt alta
 * yerleştirilir ve pdf.js ile 1 TIFF pikseli = 1 canvas pikseli ölçeğinde
 * çizilir. Tam sayı konumlarda şerit sınırında ara çizgi oluşmaz.
 * Dönüş: RGBA pikseller.
 */
async function tiffRenderStrips(info, stripImage) {
    const { PDFDocument, PDFRawStream, PDFName, pushGraphicsState, popGraphicsState,
        concatTransformationMatrix, drawObject } = PDFLib;
    const temp = await PDFDocument.create();
    const page = temp.addPage([info.width, info.height]);
    const ops = [];
    for (let i = 0; i < info.stripCount; i++) {
        const rows = tiffStripRows(info, i);
        const { dict, data } = stripImage(i, rows);
        const ref = temp.context.register(PDFRawStream.of(temp.context.obj(dict), data));
        const name = `S${i}`;
        page.node.setXObject(PDFName.of(name), ref);
        const y = info.height - i * info.rowsPerStrip - rows;
        ops.push(pushGraphicsState(), concatTransformationMatrix(info.width, 0, 0, rows, 0, y),
            drawObject(name), popGraphicsState());
    }
    page.pushOperators(...ops);

    await pdfEnsureWorker();
    const pdf = await pdfjsLib.getDocument({ data: await temp.save() }).promise;
    try {
        const p = await pdf.getPage(1);
        const viewport = p.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.width = info.width;
        canvas.height = info.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await p.render({ canvasContext: ctx, viewport }).promise;
        const pixels = ctx.getImageData(0, 0, info.width, info.height).data;
        canvas.width = canvas.height = 0;                          // belleği bırak
        return pixels;
    } finally {
        pdf.destroy();
    }
}

/** Sayfa için PDF görsel akışını kurar. Dönüş: PDFRef. */
async function tiffImageRef(doc, bytes, info) {
    const { PDFRawStream } = PDFLib;
    const base = { Type: 'XObject', Subtype: 'Image', Width: info.width, Height: info.height };
    const register = (dict, data) => doc.context.register(PDFRawStream.of(doc.context.obj(dict), data));
    const decode = info.photometric === 0 ? { Decode: [1, 0] } : {};
    const single = info.stripCount === 1;

    // CCITT faks
    if (info.compression === 3 || info.compression === 4) {
        const ccittImage = (i, rows) => ({
            dict: { ...base, Height: rows, BitsPerComponent: 1, ColorSpace: 'DeviceGray',
                Filter: 'CCITTFaxDecode', DecodeParms: tiffCcittParms(info, rows), ...decode },
            data: tiffStripBytes(bytes, info, i)
        });
        if (single) {
            const { dict, data } = ccittImage(0, info.height);
            return register(dict, data);
        }
        const rgba = await tiffRenderStrips(info, ccittImage);
        const rowBytes = Math.ceil(info.width / 8);
        const packed = new Uint8Array(rowBytes * info.height);
        for (let y = 0; y < info.height; y++) {
            for (let x = 0; x < info.width; x++) {
                if (rgba[(y * info.width + x) * 4] >= 128) packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
        return doc.context.register(doc.context.flateStream(packed,
            { ...base, BitsPerComponent: 1, ColorSpace: 'DeviceGray' }));
    }

    // JPEG
    if (info.compression === 7) {
        const gray = info.photometric <= 1;
        const colors = gray ? { ColorSpace: 'DeviceGray', ...decode } : { ColorSpace: 'DeviceRGB' };
        // Fotometrik RGB (2): JPEG içinde renk dönüşümü YOK.
        const parms = info.photometric === 2 ? { DecodeParms: { ColorTransform: 0 } } : {};
        const jpegImage = (i, rows) => ({
            dict: { ...base, Height: rows, BitsPerComponent: 8, Filter: 'DCTDecode', ...colors, ...parms },
            data: tiffFullJpeg(info, tiffStripBytes(bytes, info, i))
        });
        if (single) {
            const { dict, data } = jpegImage(0, info.height);
            return register(dict, data);
        }
        const rgba = await tiffRenderStrips(info, jpegImage);
        const channels = gray ? 1 : 3;
        const raw = new Uint8Array(info.width * info.height * channels);
        for (let i = 0, j = 0; i < info.width * info.height; i++) {
            raw[j++] = rgba[i * 4];
            if (!gray) { raw[j++] = rgba[i * 4 + 1]; raw[j++] = rgba[i * 4 + 2]; }
        }
        return doc.context.register(doc.context.flateStream(raw,
            { ...base, BitsPerComponent: 8, ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB' }));
    }

    // Ham yollar: LZW / Deflate / PackBits / sıkıştırmasız
    const raw = await tiffDecodeRaw(bytes, info);
    return doc.context.register(doc.context.flateStream(raw,
        { ...base, BitsPerComponent: info.bps, ...tiffColorEntries(doc, info) }));
}

// --- Giriş noktası -------------------------------------------------------------

/**
 * TIFF baytlarını çok sayfalı bir PDF'e çevirir. Küçük resim (NewSubfileType
 * bit 0) sayfaları atlanır. Desteklenmeyen tür PdfTiffUnsupported fırlatır.
 */
async function pdfTiffToPdf(bytes) {
    const { PDFDocument, PDFName, pushGraphicsState, popGraphicsState,
        concatTransformationMatrix, drawObject, degrees } = PDFLib;
    const ifds = tiffParse(bytes).filter((tags) => !((tags.get(254)?.[0] ?? 0) & 1));
    if (ifds.length === 0) throw new Error('TIFF sayfası yok');

    const doc = await PDFDocument.create();
    for (const tags of ifds) {
        const info = tiffPageInfo(tags);
        const ref = await tiffImageRef(doc, bytes, info);
        const page = doc.addPage([info.widthPt, info.heightPt]);
        page.node.setXObject(PDFName.of('Im0'), ref);
        page.pushOperators(pushGraphicsState(),
            concatTransformationMatrix(info.widthPt, 0, 0, info.heightPt, 0, 0),
            drawObject('Im0'), popGraphicsState());
        if (info.rotate) page.setRotation(degrees(info.rotate));
    }
    return new Uint8Array(await doc.save({ useObjectStreams: true }));
}

window.pdfTiffToPdf = pdfTiffToPdf;
window.PdfTiffUnsupported = PdfTiffUnsupported;
