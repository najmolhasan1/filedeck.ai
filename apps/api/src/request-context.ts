import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogState } from '@cloudnest/domain';

export interface CatalogRepository {
  read<T>(callback:(state:CatalogState)=>T|Promise<T>):Promise<T>;
  transaction<T>(callback:(state:CatalogState)=>T|Promise<T>):Promise<T>;
}
export interface RequestScope {userId:string;accountKey?:string;sessionToken?:string;repository:CatalogRepository;csrfToken?:string;}
export const requests = new AsyncLocalStorage<RequestScope>();
export function scope():RequestScope {
  const value=requests.getStore();
  if(!value)throw new Error('An authenticated request context is required.');
  return value;
}
export const currentUser = () => scope().userId;
