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
            use: { ...devices['Desktop Chrome'] }
        }
    ]
});
