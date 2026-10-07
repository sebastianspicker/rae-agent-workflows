/** Allowlisted run control and confirmation actions. */

import { api, showToast } from "./api.js";
import { currentRun, elements, selectedSummary, state } from "./state.js";
import { refreshSelectedRun } from "./data.js";
import { renderRun } from "./render.js";

/** Containment controls are validated by the server and never wait on run detail or events. */
const CONTAINMENT_ACTIONS = new Set(["stop", "interrupt"]);

interface ConfirmationCopy {
  kicker: string;
  heading: string;
  message: string;
  submit: string;
  progress: string;
  notice: string;
  typed: boolean;
}

const CONFIRMATIONS: Readonly<Record<string, ConfirmationCopy>> = {
  cleanup: {
    kicker: "Worktree cleanup",
    heading: "Confirm cleanup",
    message:
      "Cleanup preserves any dirty or unmerged worktree and remains subject to the pipeline ownership checks.",
    submit: "Cleanup run",
    progress: "Cleaning up worktree…",
    notice: "Worktree cleaned up.",
    typed: true,
  },
  interrupt: {
    kicker: "Process interruption",
    heading: "Confirm interrupt",
    message:
      "Interrupt signals the owned process group. Inspect provider activity before reusing an interrupted run.",
    submit: "Interrupt run",
    progress: "Interrupting…",
    notice: "Interrupt accepted.",
    typed: true,
  },
  reject: {
    kicker: "Terminal decision",
    heading: "Confirm rejection",
    message:
      "Rejecting this checkpoint is terminal: the console cannot resume the run afterwards. Your rationale is saved verbatim:",
    submit: "Reject checkpoint",
    progress: "Recording rejection…",
    notice: "Reject decision recorded.",
    typed: false,
  },
  escalate: {
    kicker: "Terminal decision",
    heading: "Confirm escalation",
    message:
      "Escalating this checkpoint is terminal: the console cannot resume the run afterwards. Your rationale is saved verbatim:",
    submit: "Escalate checkpoint",
    progress: "Recording escalation…",
    notice: "Escalate decision recorded.",
    typed: false,
  },
};

/** Runs the confirmed action and may return work to do once the dialog has closed. */
type ConfirmHandler = () => Promise<(() => void) | undefined>;
let confirmHandler: ConfirmHandler | null = null;

export async function postAction(
  action: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const containment = CONTAINMENT_ACTIONS.has(action);
  // Stop and interrupt proceed from the summary row alone; the server validates them.
  const run = currentRun() ?? (containment ? selectedSummary() : null);
  if (!run || state.actionPending) return;
  if (!containment && (state.detailLoading || state.detailError))
    throw new Error("Refresh the run details before submitting a decision or control action.");
  const projectId = state.projectId;
  state.actionPending = true;
  renderRun();
  try {
    await api(
      `/projects/${encodeURIComponent(projectId ?? "")}/runs/${encodeURIComponent(run.id)}/${action}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (state.projectId === projectId) await refreshSelectedRun();
  } finally {
    state.actionPending = false;
    renderRun();
  }
}

function confirmError(message: string | null): void {
  elements["confirm-error"].textContent = message ?? "";
  elements["confirm-error"].hidden = !message;
}

function confirmPending(message: string | null): void {
  elements["confirm-pending"].textContent = message ?? "";
  elements["confirm-pending"].hidden = !message;
}

export function openConfirmation(
  action: string,
  { rationale, onConfirm }: { rationale?: string; onConfirm?: ConfirmHandler } = {},
): void {
  const run = currentRun() ?? (CONTAINMENT_ACTIONS.has(action) ? selectedSummary() : null);
  const copy = CONFIRMATIONS[action];
  if (!run || !copy) return;
  state.confirmAction = action;
  confirmHandler = onConfirm ?? null;
  elements["confirm-kicker"].textContent = copy.kicker;
  elements["confirm-heading"].textContent = copy.heading;
  elements["confirm-message"].textContent = copy.message;
  elements["confirm-rationale"].textContent = rationale ?? "";
  elements["confirm-rationale"].hidden = !rationale;
  elements["confirm-run-id-field"].hidden = !copy.typed;
  elements["confirm-help"].hidden = !copy.typed;
  elements["confirm-run-id"].toggleAttribute("required", copy.typed);
  elements["confirm-expected-id"].textContent = run.id;
  elements["confirm-run-id"].value = "";
  elements["confirm-submit"].textContent = copy.submit;
  elements["confirm-submit"].disabled = copy.typed;
  confirmError(null);
  confirmPending(null);
  elements["confirm-dialog"].showModal();
  // Terminal decisions start on Cancel so a stray Enter cannot confirm them.
  (copy.typed ? elements["confirm-run-id"] : elements["confirm-cancel"]).focus();
}

export function closeConfirmation(): void {
  state.confirmAction = null;
  confirmHandler = null;
  elements["confirm-dialog"].close();
}

export async function submitConfirmation(): Promise<void> {
  const action = state.confirmAction;
  const run =
    currentRun() ?? (action && CONTAINMENT_ACTIONS.has(action) ? selectedSummary() : null);
  const copy = action ? CONFIRMATIONS[action] : undefined;
  if (!run || !action || !copy) return;
  if (copy.typed && elements["confirm-run-id"].value !== run.id) return;
  const handler = confirmHandler;
  elements["confirm-submit"].disabled = true;
  confirmError(null);
  confirmPending(copy.progress);
  try {
    let afterClose: (() => void) | undefined;
    if (handler) afterClose = await handler();
    else {
      await postAction(action, { confirm_run_id: elements["confirm-run-id"].value });
      showToast(copy.notice, "notice");
    }
    closeConfirmation();
    afterClose?.();
  } catch (error) {
    confirmError(error instanceof Error ? error.message : "The action could not be completed.");
  } finally {
    confirmPending(null);
    elements["confirm-submit"].disabled = false;
  }
}
