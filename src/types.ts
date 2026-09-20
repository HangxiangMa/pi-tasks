/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** True when cost was attributed from a shared host turn or model estimate. */
  costEstimated?: boolean;
}

export function normalizeTaskUsage(value: unknown): TaskUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const number = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  const token = (candidate: unknown) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  const costValue = record.cost && typeof record.cost === "object"
    ? (record.cost as Record<string, unknown>).total
    : record.cost;
  const usage = {
    inputTokens: token(record.inputTokens ?? record.input),
    outputTokens: token(record.outputTokens ?? record.output),
    cost: number(costValue),
    ...(record.costEstimated === true ? { costEstimated: true } : {}),
  } satisfies TaskUsage;
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cost > 0 ? usage : undefined;
}

export function mergeTaskUsage(base: TaskUsage | undefined, delta: TaskUsage): TaskUsage {
  return {
    inputTokens: (base?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (base?.outputTokens ?? 0) + delta.outputTokens,
    cost: (base?.cost ?? 0) + delta.cost,
    ...(base?.costEstimated || delta.costEstimated ? { costEstimated: true } : {}),
  };
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  /** Parent pi-todo item. TODO owns lifecycle; task only executes this child. */
  todoId?: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
  /** Evidence required when transitioning task to completed. */
  verification?: string[];
  /** Persisted execution usage, accumulated across retries. */
  usage?: TaskUsage;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
