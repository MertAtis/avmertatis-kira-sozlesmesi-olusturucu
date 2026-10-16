// WebKit-Linux (GitHub Actions runner), index.html'in Chrome'a özgü
// `interactive-widget=resizes-content` meta anahtarını CONSOLE HATASI olarak
// yazar: "Viewport argument key \"interactive-widget\" not recognized and
// ignored." Bu uygulama hatası değildir — klavye-davranış düzeltmesidir ve
// yalnızca o anahtarın yoksayıldığını söyler. Tam bu satır süzgeçlenir;
// başka hiçbir konsol hatası geçmez.
export function onErrorList(page, list) {
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (text.startsWith('Viewport argument key "') && text.includes('not recognized and ignored')) return;
        list.push(text);
    });
}
