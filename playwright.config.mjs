import { defineConfig, devices } from '@playwright/test';

// Testler gerçek `file://` protokolünü kullanır; web sunucusu yoktur.
// Bu, README'de belgelenen "index.html dosyasına çift tıklayarak açın" yolunu
// her koşuda doğrular.
export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    reporter: [['list']],
    timeout: 120000,
    expect: { timeout: 15000 },
    use: {
        trace: 'retain-on-failure'
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Önceden kurulu tarayıcı olan ortamlar için (ör. bulut oturumu):
                // PW_CHROMIUM_PATH verilirse o kullanılır; yoksa Playwright varsayılanı.
                ...(process.env.PW_CHROMIUM_PATH
                    ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
                    : {})
            }
        }
    ]
});
