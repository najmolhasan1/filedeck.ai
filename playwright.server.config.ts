import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./test/ui',timeout:45000,workers:1,reporter:'list',
  use:{baseURL:'http://localhost:3003',viewport:{width:1440,height:1000},
    launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']},
    trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'npm run dev --workspace=@cloudnest/web -- --port 3003',url:'http://127.0.0.1:3003',reuseExistingServer:false,timeout:60000,cwd:process.env.CLOUDNEST_WEB_TEST_ROOT,
    env:{NEXT_PUBLIC_STORAGE_MODE:'server',API_URL:'http://127.0.0.1:4100',NEXT_TELEMETRY_DISABLED:'1'}}
});
