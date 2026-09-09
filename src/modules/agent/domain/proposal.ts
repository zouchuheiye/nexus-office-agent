import { randomUUID } from "node:crypto";
import { sha256, type AgentRiskLevel } from "@/src/modules/agent/domain/agent-run";

export type AgentProposal = {
  id: string;
  tenantId: string;
  agentRunId: string;
  actorId: string;
  toolId: string;
  toolVersion: number;
  riskLevel: AgentRiskLevel;
  input: unknown;
  inputDigest: string;
  preview: string;
  expectedVersions: Record<string, number>;
  proposalHash: string;
  status: "pending" | "confirmed" | "queued" | "executing" | "expired" | "revoked" | "executed" | "failed" | "unknown" | "cancelled";
  expiresAt: string;
  createdAt: string;
  executedAt?: string;
  result?: unknown;
};

export type AgentConfirmation = {
  id: string;
  tenantId: string;
  agentRunId: string;
  proposalId: string;
  requestedBy: string;
  proposalHash: string;
  riskLevel: AgentRiskLevel;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  createdAt: string;
};

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeProposalInput(value: unknown): string {
  return canonicalize(value);
}

export function proposalInputDigest(value: unknown): string {
  return sha256(canonicalize(value));
}

export function createProposal(input: Omit<AgentProposal, "id" | "inputDigest" | "proposalHash" | "status" | "createdAt">): AgentProposal {
  const createdAt = new Date().toISOString();
  const inputDigest = sha256(canonicalize(input.input));
  const proposalHash = sha256(canonicalize({
    tenantId: input.tenantId, actorId: input.actorId, agentRunId: input.agentRunId,
    toolId: input.toolId, toolVersion: input.toolVersion, riskLevel: input.riskLevel,
    inputDigest, expectedVersions: input.expectedVersions, expiresAt: input.expiresAt,
  }));
  return { ...input, id: randomUUID(), inputDigest, proposalHash, status: "pending", createdAt };
}

function recomputeProposalHash(proposal: AgentProposal): string {
  return sha256(canonicalize({
    tenantId: proposal.tenantId, actorId: proposal.actorId, agentRunId: proposal.agentRunId,
    toolId: proposal.toolId, toolVersion: proposal.toolVersion, riskLevel: proposal.riskLevel,
    inputDigest: sha256(canonicalize(proposal.input)), expectedVersions: proposal.expectedVersions, expiresAt: proposal.expiresAt,
  }));
}

export function approveProposal(proposal: AgentProposal, actorId: string, providedHash: string, now = new Date()): { proposal: AgentProposal; confirmation: AgentConfirmation } {
  if (proposal.inputDigest !== sha256(canonicalize(proposal.input)) || proposal.proposalHash !== recomputeProposalHash(proposal)) {
    throw new Error("PROPOSAL_INTEGRITY_VIOLATION");
  }
  if (proposal.actorId !== actorId) throw new Error("CONFIRMATION_ACTOR_MISMATCH");
  if (proposal.proposalHash !== providedHash) throw new Error("CONFIRMATION_HASH_MISMATCH");
  if (proposal.status === "executed") throw new Error("PROPOSAL_ALREADY_EXECUTED");
  if (proposal.status !== "pending") throw new Error(`PROPOSAL_NOT_CONFIRMABLE:${proposal.status}`);
  if (new Date(proposal.expiresAt).getTime() <= now.getTime()) throw new Error("PROPOSAL_EXPIRED");
  const decidedAt = now.toISOString();
  return {
    proposal: { ...proposal, status: "confirmed" },
    confirmation: {
      id: randomUUID(), tenantId: proposal.tenantId, agentRunId: proposal.agentRunId, proposalId: proposal.id,
      requestedBy: actorId, proposalHash: proposal.proposalHash, riskLevel: proposal.riskLevel,
      status: "approved", expiresAt: proposal.expiresAt, decidedAt, decidedBy: actorId, createdAt: decidedAt,
    },
  };
}

/**
 * P2 可编辑预览卡：R3 提案保持不可篡改，不原地修改 input；
 * 人修正字段后调用 supersedeProposal 把旧提案作废（revoked），
 * 再生成一份携带修正后 input 的新提案供再次确认。
 */
export function supersedeProposal(proposal: AgentProposal, input: { reason: string; supersededByProposalId?: string }, now = new Date()): AgentProposal {
  if (proposal.status !== "pending") throw new Error(`PROPOSAL_NOT_SUPERSEDABLE:${proposal.status}`);
  return {
    ...proposal,
    status: "revoked",
    result: { supersededAt: now.toISOString(), reason: input.reason, supersededByProposalId: input.supersededByProposalId },
  };
}
