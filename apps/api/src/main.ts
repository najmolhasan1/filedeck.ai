import { createApi } from './app.js';

const { app } = await createApi();
const port = Number(process.env.API_PORT ?? 4000);
// Demo never listens on a public interface. Production remains fail-closed.
const host = process.env.CLOUDNEST_DEMO === '1' ? '127.0.0.1' : process.env.API_HOST ?? '127.0.0.1';
await app.listen(port, host);
console.log(`CloudNest API listening on http://${host}:${port} (${process.env.CLOUDNEST_DEMO === '1' ? 'local-demo' : process.env.CLOUDNEST_API_ENABLE === 'true' ? 'server' : 'not-configured'})`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
