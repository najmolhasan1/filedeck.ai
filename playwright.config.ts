import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30000, fullyParallel: false, workers: 1,
  reporter: 'list',
  use: {baseURL:'http://localhost:3000', viewport:{width:1440,height:1000},
    launchOptions: {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']},
    screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'npm run dev',url:'http://127.0.0.1:3000',reuseExistingServer:true,timeout:60000}
});
