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
  /** Whether AgencyOS sets up and starts local AI by itself (off for a new install). */
  auto?: boolean;
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

/** The local AI engine and models, as the launcher lists them. */
export interface LocalModel {
  name: string;
  sizeBytes: number;
  modifiedAt: string | null;
  parameterSize: string | null;
  quantization: string | null;
  roles: Array<'copy' | 'search'>;
}

export interface ModelSuggestion {
  id: string;
  label: string;
  kind: 'text' | 'embedding';
  sizeGB: number | null;
  recommended: boolean;
}

export interface LocalAiModels {
  auto: boolean;
  engine: {
    installed: boolean;
    running: boolean;
    version: string | null;
    external: boolean;
  };
  installed: LocalModel[];
  listError: string | null;
  suggestions: ModelSuggestion[];
  download: null | {
    model: string;
    state: 'starting' | 'downloading' | 'done' | 'failed' | 'cancelled';
    fraction?: number;
    received?: number;
    total?: number;
    bytesPerSecond?: number;
    error?: string | null;
  };
  engineTask: null | {
    action: 'install' | 'start' | 'stop';
    state: 'working' | 'done' | 'failed';
    message: string;
    error?: string;
  };
  freeDiskGB: number | null;
  modelsDir: string;
}

/** The command-line AI tools on this computer, as the launcher reports them. */
export type CliToolId = 'antigravity' | 'claude' | 'codex';

export interface CliToolView {
  id: CliToolId;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** null when the program could not say, so nothing is guessed. */
  signedIn: boolean | null;
  canSignOut: boolean;
}

export interface CliToolTask {
  tool: CliToolId;
  action: 'install' | 'login';
  state: 'working' | 'waiting' | 'done' | 'failed' | 'cancelled';
  message: string;
  /** The vendor's sign-in page, shown only as a fallback when the browser did not open by itself. */
  url?: string | null;
  error?: string | null;
}

export interface CliTools {
  platform: string;
  tools: CliToolView[];
  task: CliToolTask | null;
}

/** The same rule the launcher applies before a model name reaches the engine. */
export const MODEL_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){0,2}(:[A-Za-z0-9._-]{1,60})?$/;

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

export const useLocalModels = () =>
  useSWR<LocalAiModels>(
    'agency-local-models',
    () => systemRequest<LocalAiModels>('GET', 'ai/models'),
    { refreshInterval: 2000, revalidateOnFocus: true }
  );

const cliBusy = (data?: CliTools) =>
  !!data?.task && ['working', 'waiting'].includes(data.task.state);

export const useCliTools = () =>
  useSWR<CliTools>(
    'agency-cli-tools',
    () => systemRequest<CliTools>('GET', 'cli/tools'),
    {
      refreshInterval: (data) => (cliBusy(data) ? 1500 : 15000),
      revalidateOnFocus: true,
    }
  );

export const useSystemStatus = () =>
  useSWR<SystemStatus>(
    'agency-system-status',
    () => systemRequest<SystemStatus>('GET', 'status'),
    { refreshInterval: 2000, revalidateOnFocus: true }
  );
