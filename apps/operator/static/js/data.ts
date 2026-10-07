/** Project, run, and event loading with stale-selection guards. */

import { api, eventStream, setConnection, showError, showToast } from "./api.js";
import { elements, state } from "./state.js";
import { renderEvents, renderRun, renderRuns } from "./render.js";
import { focusSelectedTask, showRunCatalogue } from "./navigation.js";
import { loadWorkflows, refreshWorkflowLocks } from "./workflows.js";
import type { OperatorEvent, OperatorRun } from "./types.js";

interface RunsPage {
  runs: OperatorRun[];
  next_cursor: string | null;
}
interface EventsPage {
  events: OperatorEvent[];
  next_after: number;
  has_more: boolean;
}
interface ProjectsPayload {
  projects: Array<{ id: string; label: string }>;
}
interface ProfilesPayload {
  profiles?: Array<{ id: string; readiness: string; models?: Record<string, string> }>;
}

const CATALOGUE_POLL_MS = 10_000;
const STREAM_CYCLE_DELAY_MS = 750;
const STREAM_BACKOFF_BASE_MS = 1_000;
const STREAM_BACKOFF_MAX_MS = 30_000;

/** Base session label and the health of the two background feeds that drive the pill. */
const connection = {
  label: "Local session",
  detail: "No publish controls",
  streamHealthy: true,
  catalogueHealthy: true,
};

/** The pill is the polite live region: only these transitions change its text. */
function renderConnection(recovered = false): void {
  if (!connection.catalogueHealthy) {
    setConnection("error", "Unavailable", "Run catalogue refresh failed");
  } else if (!connection.streamHealthy) {
    setConnection("connecting", "Reconnecting", "Live event stream lost");
  } else {
    setConnection("connected", connection.label, recovered ? "Reconnected" : connection.detail);
  }
}

function setFeedHealth(feed: "streamHealthy" | "catalogueHealthy", healthy: boolean): void {
  if (connection[feed] === healthy) return;
  connection[feed] = healthy;
  renderConnection(healthy);
}

function setStreamStatus(text: string, live = false): void {
  const status = elements["stream-status"];
  if (!live) {
    status.textContent = text;
    return;
  }
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  status.replaceChildren(spinner, document.createTextNode(` ${text}`));
}

export async function loadProjects(): Promise<void> {
  const data = await api<ProjectsPayload>("/projects");
  state.projects = data.projects;
  elements["project-select"].replaceChildren(
    ...state.projects.map((project) => new Option(project.label, project.id)),
  );
  state.projectId = state.projects[0]?.id ?? null;
  elements["new-run-button"].disabled = !state.projectId;
  const demo = document.documentElement.dataset.demo === "true";
  connection.label = demo ? "Mock-only demo" : "Local session";
  connection.detail = demo ? "No repository access or publish controls" : "No publish controls";
  renderConnection();
  if (state.projectId) {
    await loadExecutionProfiles();
    await loadRuns();
    await loadWorkflows();
  } else {
    elements["runs-loading"].hidden = true;
    renderRuns();
  }
}

export async function loadExecutionProfiles(): Promise<void> {
  if (!state.projectId) return;
  const payload = await api<ProfilesPayload>(
    `/projects/${encodeURIComponent(state.projectId)}/execution-profiles`,
  );
  state.workflowProfiles = payload.profiles ?? [];
  elements["start-execution-profile"].replaceChildren(
    new Option("Runtime default", ""),
    ...state.workflowProfiles.map(
      (profile) =>
        new Option(
          `${profile.id} · ${profile.readiness} · ${Object.entries(profile.models ?? {})
            .map(([tier, model]) => `${tier}: ${model}`)
            .join(", ")}`,
          profile.id,
        ),
    ),
  );
  elements["workflow-proposal-profile"].replaceChildren(
    new Option("Runtime default", ""),
    ...state.workflowProfiles.map(
      (profile) => new Option(`${profile.id} · ${profile.readiness}`, profile.id),
    ),
  );
}

export async function loadRuns(preserveSelection = true): Promise<void> {
  const generation = ++state.runsGeneration;
  const projectId = state.projectId;
  if (!projectId) return;
  elements["runs-loading"].hidden = false;
  elements["runs-empty"].hidden = true;
  const data = await api<RunsPage>(
    `/projects/${encodeURIComponent(projectId)}/runs?limit=100&view=summary`,
  );
  if (!isCurrentRunList(generation, projectId)) return;
  state.runs = data.runs;
  state.runsCursor = data.next_cursor;
  state.runsHasMore = Boolean(data.next_cursor);
  if (!preserveSelection || !state.runs.some((run) => run.id === state.runId)) {
    state.runId = state.runs[0]?.id ?? null;
  }
  if (document.body && !document.body.dataset.runView)
    document.body.dataset.runView = state.runId ? "selected" : "list";
  await selectRun(state.runId);
}

export async function loadMoreRuns(): Promise<void> {
  const generation = state.runsGeneration;
  const projectId = state.projectId;
  const cursor = state.runsCursor;
  if (!projectId || !cursor || state.runsLoadingMore) return;
  state.runsLoadingMore = true;
  renderRuns();
  try {
    const data = await api<RunsPage>(
      `/projects/${encodeURIComponent(projectId)}/runs?limit=100&view=summary&cursor=${encodeURIComponent(cursor)}`,
    );
    if (!isCurrentRunList(generation, projectId) || cursor !== state.runsCursor) return;
    const ids = new Set(state.runs.map((run) => run.id));
    state.runs.push(...data.runs.filter((run) => !ids.has(run.id)));
    state.runsCursor = data.next_cursor;
    state.runsHasMore = Boolean(data.next_cursor);
  } finally {
    if (isCurrentRunList(generation, projectId)) {
      state.runsLoadingMore = false;
      renderRuns();
    }
  }
}

export function isCurrentRunList(generation: number, projectId: string): boolean {
  return generation === state.runsGeneration && projectId === state.projectId;
}

/** Mirrors the server order: newest start first, ties broken by descending id. */
function isOlderRun(run: OperatorRun, than: OperatorRun): boolean {
  const time = String(run.started_at ?? "").localeCompare(String(than.started_at ?? ""));
  return (time || String(run.id).localeCompare(String(than.id))) < 0;
}

/**
 * Re-reads the first summary page in the background and merges it into the catalogue without
 * changing the selection; rows from later pages stay in place.
 */
export async function refreshRunSummaries(): Promise<void> {
  const generation = state.runsGeneration;
  const projectId = state.projectId;
  if (!projectId || state.runsLoadingMore) return;
  let data: RunsPage;
  try {
    data = await api<RunsPage>(
      `/projects/${encodeURIComponent(projectId)}/runs?limit=100&view=summary`,
    );
  } catch (error) {
    if (isCurrentRunList(generation, projectId)) setFeedHealth("catalogueHealthy", false);
    throw error;
  }
  if (!isCurrentRunList(generation, projectId) || state.runsLoadingMore) return;
  setFeedHealth("catalogueHealthy", true);
  const ids = new Set(data.runs.map((run) => run.id));
  const oldest = data.runs[data.runs.length - 1];
  // Rows from "load more" survive only when older than the first page; anything the server no
  // longer returns inside the first-page range is gone.
  const older =
    oldest && data.next_cursor
      ? state.runs.filter((run) => !ids.has(run.id) && isOlderRun(run, oldest))
      : [];
  state.runs = [...data.runs, ...older];
  if (!older.length) {
    state.runsCursor = data.next_cursor;
    state.runsHasMore = Boolean(data.next_cursor);
  }
  renderRuns();
  refreshWorkflowLocks();
}

/** Polls run summaries while the tab is visible so holds and relative times stay current. */
export function startCataloguePolling(): void {
  const poll = () => {
    if (document.visibilityState !== "visible") return;
    refreshRunSummaries().catch(() => {
      // The connection pill reports the failure; the next cycle retries.
    });
  };
  setInterval(poll, CATALOGUE_POLL_MS);
  document.addEventListener("visibilitychange", poll);
}

export async function selectRun(runId: string | null): Promise<void> {
  state.runId = runId;
  state.runDetail = null;
  state.detailError = null;
  state.detailLoading = Boolean(runId);
  const generation = ++state.detailGeneration;
  const projectId = state.projectId;
  renderRuns();
  renderRun();
  await Promise.all([loadEvents(), loadRunDetail(generation, projectId, runId)]);
}

/**
 * Refreshes the selected run in place after an action: the current detail and event history
 * stay rendered, and focus and scroll position are kept.
 */
export async function refreshSelectedRun(): Promise<void> {
  const focused = document.activeElement as HTMLElement | null;
  const scroll = window.scrollY;
  await Promise.all([
    loadRunDetail(state.detailGeneration, state.projectId, state.runId),
    refreshRunSummaries().catch(() => {}),
  ]);
  if (focused && focused !== document.activeElement && focused.isConnected && !focused.hidden) {
    focused.focus({ preventScroll: true });
  }
  if (window.scrollY !== scroll) window.scrollTo({ top: scroll, behavior: "instant" });
}

/** The selected run no longer exists on the server: forget it and return to the catalogue. */
async function dropMissingRun(runId: string): Promise<void> {
  state.runs = state.runs.filter((run) => run.id !== runId);
  await selectRun(null);
  showRunCatalogue();
  showToast(`Run ${runId} is no longer available.`, "notice");
}

async function loadRunDetail(
  generation: number,
  projectId: string | null,
  runId: string | null,
): Promise<void> {
  if (!projectId || !runId) return;
  try {
    const data = await api<{ run: OperatorRun }>(
      `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    );
    if (
      generation !== state.detailGeneration ||
      projectId !== state.projectId ||
      runId !== state.runId
    )
      return;
    state.runDetail = data.run;
    state.detailError = null;
  } catch (error) {
    if (
      generation !== state.detailGeneration ||
      projectId !== state.projectId ||
      runId !== state.runId
    )
      return;
    if ((error as { status?: number }).status === 404) {
      await dropMissingRun(runId);
      return;
    }
    state.detailError = error instanceof Error ? error.message : String(error);
    showError(error);
  } finally {
    if (
      generation === state.detailGeneration &&
      projectId === state.projectId &&
      runId === state.runId
    ) {
      state.detailLoading = false;
      renderRun();
    }
  }
}

export async function loadEvents(): Promise<void> {
  state.streamAbort?.abort();
  const generation = ++state.streamGeneration;
  const projectId = state.projectId;
  const runId = state.runId;
  state.events = [];
  state.eventIds = new Set();
  state.eventAfter = 0;
  if (state.eventFrame !== null) cancelAnimationFrame(state.eventFrame);
  state.eventFrame = null;
  state.eventError = null;
  setStreamStatus("");
  if (!connection.streamHealthy) {
    // A new selection starts a new stream; the previous run's loss is no longer current.
    connection.streamHealthy = true;
    renderConnection();
  }
  renderEvents();
  if (!projectId || !runId) return;
  const pageController = new AbortController();
  state.streamAbort = pageController;
  let page: Awaited<ReturnType<typeof loadEventPages>>;
  try {
    page = await loadEventPages(projectId, runId, pageController, generation);
  } catch (error) {
    if (!isCurrentEventSelection(generation, projectId, runId)) return;
    state.eventError = error instanceof Error ? error.message : String(error);
    setStreamStatus("Stream unavailable");
    renderEvents();
    showError(error);
    return;
  }
  if (!page) return;
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  state.events = page.events;
  state.eventIds = new Set(page.events.map((event) => event.seq));
  state.eventAfter = page.next_after;
  renderEvents();
  void streamEvents(generation, projectId, runId);
}

async function loadEventPages(
  projectId: string,
  runId: string,
  controller: AbortController,
  generation: number,
): Promise<EventsPage | null> {
  try {
    const events: OperatorEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await api<EventsPage>(
        `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?limit=200&after=${after}`,
        { signal: controller.signal },
      );
      if (!isCurrentEventSelection(generation, projectId, runId)) return null;
      events.push(...page.events);
      if (!page.has_more) return { events, next_after: page.next_after, has_more: false };
      if (page.next_after <= after) throw new Error("Event pagination did not advance");
      after = page.next_after;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return null;
    throw error;
  }
}

export function isCurrentEventSelection(
  generation: number,
  projectId: string | null,
  runId: string | null,
): boolean {
  return (
    generation === state.streamGeneration && projectId === state.projectId && runId === state.runId
  );
}

/** Resolves after the delay, or early when the selection's stream is aborted. */
function pause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, delay);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}

/**
 * Follows the live tail for the selected run. The server ends each tail after about 15 s; that
 * cycle reconnects quietly. A stream error or network failure reconnects with capped exponential
 * backoff and is reported through the connection pill, never as a per-cycle announcement.
 */
async function streamEvents(generation: number, projectId: string, runId: string): Promise<void> {
  let failures = 0;
  while (isCurrentEventSelection(generation, projectId, runId)) {
    const controller = new AbortController();
    state.streamAbort = controller;
    let delay = STREAM_CYCLE_DELAY_MS;
    try {
      if (failures === 0) setStreamStatus("Live verification", true);
      const response = await openEventStream(state.eventAfter, controller, projectId, runId);
      if (!isCurrentEventSelection(generation, projectId, runId)) {
        controller.abort();
        return;
      }
      if (!response.ok) throw new Error(`Event stream unavailable (${response.status})`);
      if (failures > 0) setStreamStatus("Live verification", true);
      failures = 0;
      setFeedHealth("streamHealthy", true);
      await consumeEventStream(response, generation, projectId, runId);
      if (!isCurrentEventSelection(generation, projectId, runId)) return;
      // Refresh only the selected durable state; historical runs and event rows stay in place.
      await loadRunDetail(state.detailGeneration, projectId, runId);
    } catch (error) {
      if (
        (error instanceof Error && error.name === "AbortError") ||
        !isCurrentEventSelection(generation, projectId, runId)
      )
        return;
      failures += 1;
      delay = Math.min(STREAM_BACKOFF_MAX_MS, STREAM_BACKOFF_BASE_MS * 2 ** (failures - 1));
      setFeedHealth("streamHealthy", false);
      setStreamStatus(`Stream lost · retrying in ${Math.round(delay / 1000)} s`);
    }
    if (!isCurrentEventSelection(generation, projectId, runId)) return;
    await pause(delay, controller.signal);
  }
}

async function openEventStream(
  after: number,
  controller: AbortController,
  projectId: string,
  runId: string,
): Promise<Response> {
  return eventStream(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`,
    { signal: controller.signal },
  );
}

async function consumeEventStream(
  response: Response,
  generation: number,
  projectId: string,
  runId: string,
): Promise<void> {
  if (!response.body) throw new Error("Event stream response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (!isCurrentEventSelection(generation, projectId, runId)) {
      await reader.cancel();
      break;
    }
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) appendStreamEvents([buffer]);
      scheduleEventRender(generation, projectId, runId);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    appendStreamEvents(lines);
    scheduleEventRender(generation, projectId, runId);
  }
}

function appendStreamEvents(lines: string[]): void {
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line) as OperatorEvent;
    if (event.event === "stream_error") throw new Error("Event stream unavailable");
    if (event.seq && !state.eventIds.has(event.seq)) {
      state.eventIds.add(event.seq);
      state.events.push(event);
      state.eventAfter = Math.max(state.eventAfter, event.seq);
    }
  }
}

function scheduleEventRender(generation: number, projectId: string, runId: string): void {
  if (state.eventFrame !== null) return;
  state.eventFrame = requestAnimationFrame(() => {
    state.eventFrame = null;
    if (isCurrentEventSelection(generation, projectId, runId)) renderEvents();
  });
}

export async function waitForNewRun(
  previousIds: ReadonlySet<string>,
  projectId = state.projectId,
  acceptedRunId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (state.projectId !== projectId) return;
    const data = await api<RunsPage>(
      `/projects/${encodeURIComponent(projectId ?? "")}/runs?limit=100&view=summary`,
    );
    if (state.projectId !== projectId) return;
    const candidates = data.runs.filter((run) => !previousIds.has(run.id));
    const discovered = acceptedRunId
      ? data.runs.find((run) => run.id === acceptedRunId)
      : candidates.length === 1
        ? candidates[0]
        : null;
    if (discovered) {
      if (document.body) document.body.dataset.runView = "selected";
      state.runs = data.runs;
      await selectRun(discovered.id);
      if (state.projectId === projectId && state.runId === discovered.id) focusSelectedTask();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await loadRuns();
  showToast(
    "Start accepted, but the new run is not identified yet. Check All runs before starting again.",
    "notice",
  );
}
