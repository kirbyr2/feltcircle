export interface Env {
  ROOMS: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  ASSETS?: Fetcher;
  CORS_ORIGINS?: string;
  ROOM_CREATE_LIMIT?: string;
}
