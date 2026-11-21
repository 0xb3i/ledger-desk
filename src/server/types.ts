export interface Env { DB: D1Database; ASSETS?: Fetcher; OWNER_ACCESS_KEY: string }
export interface DeviceAuth { id: string; accountId: string }
export interface ApiEnv { Bindings: Env; Variables: { requestId: string; sessionId: string; device: DeviceAuth } }
