/** Bounded, ephemeral workflow-proposal jobs. Candidates are never saved or activated here. */
import { randomUUID } from "node:crypto";
import { proposeWorkflowCandidateAsync, validateWorkflow } from "@rae/engine";
import type { LoadedExecutionProfile } from "./profiles.js";
import type { OperatorProject } from "./security.js";
const MAX_JOBS = 12;
const MAX_CONCURRENT_RUNS = 4;
const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_TERMINAL_JOBS = 50;
const MAX_TASK_BYTES = 32 * 1024;
const PROPOSAL_FIELDS = new Set(["task", "base_revision", "execution_profile_id"]);

type HttpError = Error & { status: number };
type ProposalRecord = Record<string, unknown>;
interface ProposalInput {
  task: string;
  baseRevision: number | null;
  executionProfileId: unknown;
}
interface ProposalJob {
  id: string;
  projectId: string;
  workflowId: string;
  state: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  error?: string;
  candidate?: unknown;
}
interface PublicProposalJob {
  id: string;
  workflow_id: string;
  state: ProposalJob["state"];
  created_at: string;
  completed_at: string | null;
  error?: string;
  candidate?: unknown;
}
interface CandidateInput {
  projectRoot: string;
  workflowId: string;
  task: string;
  baseRevision: number | null;
  executionProfile?: string;
}
type CandidateRunner = (input: CandidateInput) => Promise<unknown>;

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

/** Validates the enclosing proposal object before field-specific checks. */
export function validateProposalBody(body: unknown): ProposalRecord {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw httpError(400, "proposal body is required");
  for (const key of Object.keys(body))
    if (!PROPOSAL_FIELDS.has(key)) throw httpError(400, `unsupported proposal field: ${key}`);
  return body as ProposalRecord;
}

/** Validates and normalizes the proposal fields accepted by the job queue. */
export function validateProposalFields(body: ProposalRecord): ProposalInput {
  if (typeof body.task !== "string" || body.task.trim().length === 0)
    throw httpError(400, "proposal task is required");
  if (Buffer.byteLength(body.task, "utf8") > MAX_TASK_BYTES)
    throw httpError(413, "proposal task exceeds 32768 bytes");
  if (body.base_revision !== undefined && !/^[0-9]{1,9}$/.test(String(body.base_revision))) {
    throw httpError(400, "invalid base_revision");
  }
  return {
    task: body.task.trim(),
    baseRevision:
      typeof body.base_revision === "string" || typeof body.base_revision === "number"
        ? Number(body.base_revision)
        : null,
    executionProfileId: body.execution_profile_id ?? null,
  };
}

function requestInput(body: unknown): ProposalInput {
  return validateProposalFields(validateProposalBody(body));
}

async function defaultCandidateRunner(input: CandidateInput): Promise<unknown> {
  // The legacy `proposeWorkflow` persists a draft and is deliberately never called.
  return proposeWorkflowCandidateAsync(input);
}

async function validateCandidate(candidate: object): Promise<unknown> {
  return validateWorkflow(candidate) as unknown;
}

function publicJob(job: ProposalJob): PublicProposalJob {
  return {
    id: job.id,
    workflow_id: job.workflowId,
    state: job.state,
    created_at: job.createdAt,
    completed_at: job.completedAt ?? null,
    ...(job.error ? { error: job.error } : {}),
    ...(job.candidate ? { candidate: job.candidate } : {}),
  };
}

export class WorkflowProposalJobs {
  private readonly candidateRunner: CandidateRunner;
  private readonly maxJobs: number;
  private readonly terminalTtlMs: number;
  private readonly maxTerminalJobs: number;
  private readonly maxConcurrentRuns: number;
  private readonly jobs: Map<string, ProposalJob>;
  private readonly waiting: Array<() => Promise<void>> = [];
  private running = 0;

  constructor({
    candidateRunner = defaultCandidateRunner,
    maxJobs = MAX_JOBS,
    terminalTtlMs = TERMINAL_JOB_TTL_MS,
    maxTerminalJobs = MAX_TERMINAL_JOBS,
    maxConcurrentRuns = MAX_CONCURRENT_RUNS,
  }: {
    candidateRunner?: CandidateRunner;
    maxJobs?: number;
    terminalTtlMs?: number;
    maxTerminalJobs?: number;
    maxConcurrentRuns?: number;
  } = {}) {
    this.terminalTtlMs = terminalTtlMs;
    this.maxTerminalJobs = maxTerminalJobs;
    this.maxConcurrentRuns = maxConcurrentRuns;
    this.candidateRunner = candidateRunner;
    this.maxJobs = maxJobs;
    this.jobs = new Map<string, ProposalJob>();
  }

  submit({
    project,
    workflowId,
    body,
    executionProfile = null,
  }: {
    project: OperatorProject;
    workflowId: string;
    body: unknown;
    executionProfile?: LoadedExecutionProfile | null;
  }): PublicProposalJob {
    const input = requestInput(body);
    if (input.executionProfileId && !executionProfile?.source) {
      throw httpError(400, "execution_profile_id must name a preloaded execution profile");
    }
    this.#evict();
    const active = [...this.jobs.values()].filter(
      (job) => job.state === "queued" || job.state === "running",
    ).length;
    if (active >= this.maxJobs) throw httpError(429, "workflow proposal queue is full");
    const job: ProposalJob = {
      id: `proposal-${randomUUID()}`,
      projectId: project.id,
      workflowId,
      state: "queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.waiting.push(async () => {
      job.state = "running";
      try {
        const candidate = await this.candidateRunner({
          projectRoot: project.root,
          workflowId,
          task: input.task,
          baseRevision: input.baseRevision,
          ...(executionProfile ? { executionProfile: executionProfile.source } : {}),
        });
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          throw new Error("proposal runner returned no workflow candidate");
        }
        job.candidate = structuredClone(await validateCandidate(candidate));
        job.state = "completed";
      } catch (error) {
        job.error =
          error instanceof Error &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status < 500
            ? error.message
            : "proposal could not be generated";
        job.state = "failed";
      } finally {
        job.completedAt = new Date().toISOString();
      }
    });
    queueMicrotask(() => this.#drain());
    return publicJob(job);
  }

  /** Starts queued provider runs while fewer than the concurrency cap are in flight. */
  #drain(): void {
    while (this.running < this.maxConcurrentRuns && this.waiting.length) {
      const run = this.waiting.shift();
      if (!run) return;
      this.running += 1;
      void run().finally(() => {
        this.running -= 1;
        this.#drain();
      });
    }
  }

  /** Drops terminal jobs past their TTL, then the oldest terminal jobs beyond the retention cap. */
  #evict(): void {
    const now = Date.now();
    const terminal = [...this.jobs.values()].filter(
      (job) => job.state === "completed" || job.state === "failed",
    );
    for (const job of terminal) {
      if (job.completedAt && now - Date.parse(job.completedAt) > this.terminalTtlMs) {
        this.jobs.delete(job.id);
      }
    }
    const kept = terminal.filter((job) => this.jobs.has(job.id));
    for (const job of kept.slice(0, Math.max(0, kept.length - this.maxTerminalJobs))) {
      this.jobs.delete(job.id);
    }
  }

  get(
    id: string,
    workflowId: string | null = null,
    projectId: string | null = null,
  ): PublicProposalJob {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, "proposal job not found");
    if (workflowId && job.workflowId !== workflowId) throw httpError(404, "proposal job not found");
    if (projectId && job.projectId !== projectId) throw httpError(404, "proposal job not found");
    return publicJob(job);
  }
}
