/** Provider IDs are decimal strings at the domain/API boundary. File IDs stay inside the adapter. */
export type AccountKey = string;
export type AuthorizationState =
  | { state: 'phone_required' }
  | { state: 'code_required'; delivery: string; retryAfterSeconds?: number }
  | { state: 'password_required'; hint?: string }
  | { state: 'ready'; telegramUserId: string }
  | { state: 'connecting' | 'closed' | 'logging_out' }
  | { state: 'unsupported'; providerState: string };
export type AuthorizationStep = { type: 'code' | 'password'; value: string };
export interface AttachmentRef {
  telegramUserId: string;
  peerId: string;
  /** Prototype: account-database-bound TDLib message locator. Cross-database resolution is a release gate. */
  messageId: string;
  attachmentIndex: number;
}
export interface AllowedChat {
  peerId: string;
  title: string;
  kind: 'saved_messages' | 'private_channel';
  canSend: boolean;
  canDelete: boolean;
}
export interface RemoteAttachment {
  reference: AttachmentRef;
  originalName: string;
  mime: string;
  bytes: number;
  createdAt: string;
}
export type SendResult =
  | { state: 'confirmed'; reference: AttachmentRef; bytes: number }
  | { state: 'pending' | 'unknown'; operationId: string; reason?: string };
export interface Capabilities { productMaxBytes: number; providerLimitVerified: boolean; premium: boolean; }
export interface TelegramAdapter {
  startAuthorization(accountKey: AccountKey, input: { phoneNumber: string }): Promise<AuthorizationState>;
  submitAuthorizationStep(accountKey: AccountKey, input: AuthorizationStep): Promise<AuthorizationState>;
  getAuthorizationState(accountKey: AccountKey): Promise<AuthorizationState>;
  getAccountCapabilities(accountKey: AccountKey): Promise<Capabilities>;
  listAllowedChats(accountKey: AccountKey): Promise<AllowedChat[]>;
  selectStorageChat(accountKey: AccountKey, peerId: string): Promise<AllowedChat>;
  listAttachments(accountKey: AccountKey, peerId: string, cursor?: string): Promise<{items: RemoteAttachment[]; cursor?: string}>;
  sendOriginalFile(accountKey: AccountKey, input: {path: string; peerId: string; operationId: string; originalName?: string}): Promise<SendResult>;
  lookupSendResult(accountKey: AccountKey, operationId: string): Promise<SendResult>;
  fetchOriginal(accountKey: AccountKey, reference: AttachmentRef): Promise<{path: string; bytes: number}>;
  refreshReference(accountKey: AccountKey, reference: AttachmentRef): Promise<RemoteAttachment>;
  removeMessages(accountKey: AccountKey, peerId: string, messageIds: string[]): Promise<{messageId: string; outcome: 'confirmed' | 'unknown' | 'failed'}[]>;
  revokeAuthorization(accountKey: AccountKey): Promise<'confirmed' | 'pending'>;
}
export class AdapterError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryAfterSeconds?: number) { super(message); this.name = 'AdapterError'; }
}

/** Internal service-to-service RPC only. Never expose its bearer credential or local paths to browsers. */
export interface WorkerRpcMethods {
  'auth.start': { input: {phoneNumber:string}; result: AuthorizationState };
  'auth.step': { input: AuthorizationStep; result: AuthorizationState };
  'auth.state': { input: Record<string,never>; result: AuthorizationState };
  'capabilities': { input: Record<string,never>; result: Capabilities };
  'chats.list': { input: Record<string,never>; result: AllowedChat[] };
  'chats.select': { input: {peerId:string}; result: AllowedChat };
  'attachments.list': { input: {peerId:string;cursor?:string}; result: {items:RemoteAttachment[];cursor?:string} };
  'files.send': { input: {path:string;peerId:string;operationId:string;originalName?:string}; result: SendResult };
  'files.result': { input: {operationId:string}; result: SendResult };
  'files.fetch': { input: {reference:AttachmentRef}; result: {path:string;bytes:number} };
  'files.refresh': { input: {reference:AttachmentRef}; result: RemoteAttachment };
  'session.revoke': { input: Record<string,never>; result: 'confirmed'|'pending' };
}
export type WorkerRpcMethod = keyof WorkerRpcMethods;
export type WorkerRpcRequest<M extends WorkerRpcMethod = WorkerRpcMethod> = {method:M;accountKey:string;input:WorkerRpcMethods[M]['input']};
export type WorkerRpcResponse<T = unknown> = {result:T} | {error:{code:string;message:string;retryAfterSeconds?:number}};
export type WorkerContentRequest = {accountKey:string;reference:AttachmentRef};
