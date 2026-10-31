import { AdapterError } from '@cloudnest/contracts';
import { createWorkerService, serviceConfigFromEnv } from './service.js';
async function main(){
  const config=serviceConfigFromEnv(process.env);const service=createWorkerService(config);
  await new Promise<void>((resolve,reject)=>{service.server.once('error',reject);service.server.listen(config.port,config.host,resolve);});
  // No tokens, account identifiers, request bodies or provider payloads in logs.
  console.log(JSON.stringify({service:'telegram-worker',listening:true,host:config.host,port:config.port,configured:!!config.provider}));
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void service.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(error=>{console.error(JSON.stringify({error:{code:error instanceof AdapterError?error.code:'WORKER_START_FAILED',message:error instanceof AdapterError?error.message:'The internal worker could not start.'}}));process.exitCode=1;});
