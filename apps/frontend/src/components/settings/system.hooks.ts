'use client';

import useSWR from 'swr';

// ---------------------------------------------------------------------------
// What the launcher on this computer reports. The app asks through its own server (app/api/system),
// which only answers a signed-in administrator, so none of this needs a second page or a second sign-in.
// ---------------------------------------------------------------------------
export type ServiceState =
  | 'pending'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed'
  | 'done'
  | 'stopped'
  | 'idle';

export interface SystemService {
  name: string;
  label: string;
  required: boolean;
  state: ServiceState;
  message?: string;
  error?: string;
}

export interface SystemAi {
  phase?: string;
  message?: string;
  tier?: string;
  label?: string;
  reasons?: string[];
  models?: {
    embedding?: { id: string };
    text?: { id: string; tokensPerSecond?: number };
  };
  progress?: {
    fraction: number;
    received: number;
    total?: number;
    bytesPerSecond?: number;
  };
  hardware?: {
    os?: string;
    cpu?: string;
    threads?: number;
    ramGB?: number;
    gpu?: string;
  };
}

export interface SystemStorage {
  dataRoot: string;
  aiRoot: string;
  customAi: boolean;
  locked: boolean;
  move: null | {
    active: boolean;
    phase: string;
    message?: string;
    copiedBytes?: number;
    totalBytes?: number;
  };
  leftovers: Array<{ path: string; bytes: number }>;
}

export interface SystemStatus {
  version: string;
  ready: boolean;
  attention: boolean;
  services: SystemService[];
  ai: SystemAi;
  storage: SystemStorage;
  dataDir: string;
  logsDir: string;
}

/** What checking a new location answers, before anything is moved. */
export interface StoragePlan {
  ok: boolean;
  changes?: boolean;
  errors?: { dataRoot?: string; aiRoot?: string };
  needBytes?: number;
  freeBytes?: number | null;
  jobs?: Array<{ label: string; bytes: number; to: string }>;
}

export interface StorageRequest {
  dataRoot?: string;
  aiRoot?: string;
  keepWithData?: boolean;
}

export const systemRequest = async <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> => {
  const res = await fetch(`/api/system/${path}`, {
    method,
    credentials: 'same-origin',
    ...(method === 'POST'
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }
      : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }
  return json as T;
};

export const useSystemStatus = () =>
  useSWR<SystemStatus>(
    'agency-system-status',
    () => systemRequest<SystemStatus>('GET', 'status'),
    { refreshInterval: 2000, revalidateOnFocus: true }
  );
