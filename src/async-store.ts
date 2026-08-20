import type { RxCase, WorkflowStatus } from "./domain.js";
import type { ClaimedOutboxRecord, IntegrationEvent, OutboxRecord, OutboxStatus } from "./events.js";
import type { CaseStore, IdempotencyLookup, OutboxCounts, OutboxPressure, OutboxRecoveryAuditEntry, OutboxRetirementApprovalRequest, OutboxRetirementApprovalResult, OutboxRetirementRequest, OutboxRetirementResult } from "./store.js";

/**
 * Async boundary adapter used to prove that workflow and dispatch code no longer
 * depend on synchronous SQLite-style calls. A real PostgreSQL/Cloud SQL adapter
 * can implement CaseStore directly with an async driver.
 */
export class AsyncCaseStoreAdapter implements CaseStore {
  constructor(
    private readonly inner: CaseStore,
    private readonly latencyMs = 0
  ) {
    if (!Number.isInteger(latencyMs) || latencyMs < 0) throw new Error("invalid_async_store_latency");
  }

  private async pause(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  async get(id: string, tenantId?: string): Promise<RxCase | undefined> { await this.pause(); return await this.inner.get(id, tenantId); }
  async list(tenantId?: string): Promise<RxCase[]> { await this.pause(); return await this.inner.list(tenantId); }
  async save(rxCase: RxCase): Promise<void> { await this.pause(); await this.inner.save(rxCase); }
  async createCase(rxCase: RxCase, idempotencyKey: string, requestFingerprint: string, events: IntegrationEvent[] = []): Promise<void> {
    await this.pause(); await this.inner.createCase(rxCase, idempotencyKey, requestFingerprint, events);
  }
  async saveWithOutbox(rxCase: RxCase, events: IntegrationEvent[]): Promise<void> { await this.pause(); await this.inner.saveWithOutbox(rxCase, events); }
  async saveWithOutboxIfStatus(rxCase: RxCase, expectedStatus: WorkflowStatus, events: IntegrationEvent[]): Promise<boolean> {
    await this.pause(); return await this.inner.saveWithOutboxIfStatus(rxCase, expectedStatus, events);
  }
  async saveWithOutboxIfVersion(rxCase: RxCase, expectedVersion: number, events: IntegrationEvent[]): Promise<boolean> {
    await this.pause(); return await this.inner.saveWithOutboxIfVersion(rxCase, expectedVersion, events);
  }
  async getByIdempotencyKey(key: string, tenantId?: string): Promise<IdempotencyLookup | undefined> { await this.pause(); return await this.inner.getByIdempotencyKey(key, tenantId); }
  async bindIdempotencyKey(key: string, caseId: string, requestFingerprint: string, tenantId?: string): Promise<void> {
    await this.pause(); await this.inner.bindIdempotencyKey(key, caseId, requestFingerprint, tenantId);
  }
  async listOutbox(status?: OutboxStatus, tenantId?: string): Promise<OutboxRecord[]> { await this.pause(); return await this.inner.listOutbox(status, tenantId); }
  async claimOutbox(workerId: string, limit: number, leaseMs: number, now?: Date, perTenantLimit?: number): Promise<ClaimedOutboxRecord[]> {
    await this.pause(); return await this.inner.claimOutbox(workerId, limit, leaseMs, now, perTenantLimit);
  }
  async renewOutboxLease(eventId: string, claimId: string, leaseMs: number, now?: Date): Promise<void> {
    await this.pause(); await this.inner.renewOutboxLease(eventId, claimId, leaseMs, now);
  }
  async deferOutboxClaim(eventId: string, claimId: string, retryDelayMs = 0, now?: Date): Promise<void> {
    await this.pause(); await this.inner.deferOutboxClaim(eventId, claimId, retryDelayMs, now);
  }
  async markOutboxPublished(eventId: string, claimId: string): Promise<void> { await this.pause(); await this.inner.markOutboxPublished(eventId, claimId); }
  async markOutboxFailure(eventId: string, claimId: string, error: string, maxAttempts: number, retryDelayMs = 0, now?: Date): Promise<OutboxStatus> {
    await this.pause(); return await this.inner.markOutboxFailure(eventId, claimId, error, maxAttempts, retryDelayMs, now);
  }
  async redriveDeadLetter(eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): Promise<OutboxRecord> { await this.pause(); return await this.inner.redriveDeadLetter(eventId, tenantId, expectedRecoveryGeneration, actorId); }
  async retireDeadLetter(request: OutboxRetirementRequest): Promise<OutboxRetirementResult> { await this.pause(); return await this.inner.retireDeadLetter(request); }
  async createRetirementApprovalRequest(request: Omit<OutboxRetirementApprovalRequest, "requestId" | "status" | "requestedAt"> & { now?: Date }): Promise<OutboxRetirementApprovalRequest> { await this.pause(); return await this.inner.createRetirementApprovalRequest(request); }
  async approveRetirementApprovalRequest(requestId: string, approverId: string, tenantId?: string, now?: Date): Promise<OutboxRetirementApprovalResult> { await this.pause(); return await this.inner.approveRetirementApprovalRequest(requestId, approverId, tenantId, now); }
  async listRetirementApprovalRequests(tenantId?: string, eventId?: string): Promise<OutboxRetirementApprovalRequest[]> { await this.pause(); return await this.inner.listRetirementApprovalRequests(tenantId, eventId); }
  async listOutboxRecoveryAudit(eventId: string, tenantId?: string): Promise<OutboxRecoveryAuditEntry[]> { await this.pause(); return await this.inner.listOutboxRecoveryAudit(eventId, tenantId); }
  async size(): Promise<number> { await this.pause(); return await this.inner.size(); }
  async healthCheck(): Promise<void> { await this.pause(); await this.inner.healthCheck(); }
  async getOutboxCounts(): Promise<OutboxCounts> { await this.pause(); return await this.inner.getOutboxCounts(); }
  async getOutboxPressure(ageTargetMs?: number, now?: Date): Promise<OutboxPressure> { await this.pause(); return await this.inner.getOutboxPressure(ageTargetMs, now); }
}
