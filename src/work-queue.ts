import type { CaseStore } from "./store.js";
import type { WorkflowStatus } from "./domain.js";

export interface WorkQueueItem {
  caseId: string;
  status: WorkflowStatus;
  priority: "urgent" | "normal";
  reason: string;
  evidenceCount: number;
  updatedAt: string | null;
}

export class WorkQueueService {
  constructor(private readonly store: CaseStore) {}

  async listActionable(tenantId?: string): Promise<WorkQueueItem[]> {
    return (await this.store.list(tenantId))
      .filter((rxCase) => rxCase.status === "HUMAN_REVIEW_REQUIRED" || rxCase.status === "PA_FAILED_RETRYABLE")
      .map((rxCase) => ({
        caseId: rxCase.id,
        status: rxCase.status,
        priority: rxCase.status === "PA_FAILED_RETRYABLE" ? "urgent" as const : "normal" as const,
        reason: rxCase.failure?.code ?? "pharmacist_review_required",
        evidenceCount: rxCase.paDraft?.evidence.length ?? 0,
        updatedAt: rxCase.audit[rxCase.audit.length - 1]?.at ?? null
      }))
      .sort((a, b) => {
        const priority = Number(b.priority === "urgent") - Number(a.priority === "urgent");
        if (priority !== 0) return priority;
        return (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
      });
  }
}
