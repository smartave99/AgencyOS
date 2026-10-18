'use client';

import { useResource } from './agency.hooks';

// ---------------------------------------------------------------------------
// Agent integrations: tokens for outside AI agents, what they proposed, and how to connect one.
// Each resource is its own named hook. A token never comes back from the server except in the answer
// that creates it.
// ---------------------------------------------------------------------------
export type AgentScope = 'READ' | 'DRAFT';
export type AgentTokenState = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type AgentProposalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DECLINED'
  | 'EXPIRED';

export interface AgentTokenView {
  id: string;
  label: string;
  scope: AgentScope;
  /** The first characters, to tell tokens apart. */
  preview: string;
  state: AgentTokenState;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The answer to creating a token: the only time the token itself is ever sent. */
export interface NewAgentToken extends AgentTokenView {
  token: string;
}

export interface AgentProposalView {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: AgentProposalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  outcome: { ok: boolean; result?: unknown; error?: string } | null;
  from: { id: string; label: string; scope: AgentScope };
}

export interface AgentConfig {
  url: string;
  serverPath: string;
  serverFound: boolean;
  placeholder: string;
  fileName: string;
  configText: string;
  genericCommand: string;
  environment: Record<string, string>;
  verifiedWithAntigravity: boolean;
  limits: {
    activeTokens: number;
    callsPerMinute: number;
    proposalHours: number;
    defaultTokenDays: number;
  };
  tools: Array<{ name: string; scope: 'READ' | 'DRAFT'; description: string }>;
}

export const useAgentTokens = () =>
  useResource<AgentTokenView[]>(
    ['agency-agent-tokens'],
    '/agency/agent-integrations/tokens',
    20000
  );

export const useAgentProposals = () =>
  useResource<AgentProposalView[]>(
    ['agency-agent-proposals'],
    '/agency/agent-integrations/proposals',
    10000
  );

export const useAgentConfig = () =>
  useResource<AgentConfig>(
    ['agency-agent-config'],
    '/agency/agent-integrations/config'
  );
