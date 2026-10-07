/** Renders and controls the authenticated workflow registry editor. */
import { api, showError, showToast } from "./api.js";
import { formatDateTime } from "./format.js";
import { currentRun, elements, state } from "./state.js";
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowRecord } from "./types.js";

interface GraphVertex extends WorkflowNode {
  members: string[];
}
interface Position {
  x: number;
  y: number;
}
interface WorkflowInstance extends Record<string, unknown> {
  instance_id?: string;
  node_id?: string;
  status?: string;
  attempt?: number;
  item_key?: string;
  execution_tier?: string;
  selection?: Record<string, unknown>;
  quorum?: Record<string, unknown>;
  convergence?: Record<string, unknown>;
}
interface WorkflowListItem extends WorkflowRecord {
  workflow_id: string;
  latest_revision?: number;
}
type Layers = Map<number, GraphVertex[]>;
type Positions = Map<string, Position>;

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_WIDTH = 130;
const NODE_HEIGHT = 60;
const COLUMN_PITCH = 220;
const ROW_PITCH = 92;
const GRAPH_MARGIN_X = 20;
const GRAPH_MARGIN_Y = 24;
// Plex Mono advances 0.6 em: 12 px ids and 10 px badges inside the node's 8 px padding.
const NODE_ID_CHARACTERS = 15;
const NODE_BADGE_CHARACTERS = 18;
const base = (): string => `/projects/${encodeURIComponent(state.projectId ?? "")}/workflows`;
const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined);
const WORKFLOW_VIEW_PANELS = Object.freeze({
  loop: "workflow-loop",
  graph: "workflow-graph-panel",
  analyze: "workflow-analysis",
  json: "workflow-json",
});

function selectedRevision(): number | null {
  return state.workflow?.revisions?.at(-1)?.revision ?? state.workflow?.workflow?.revision ?? null;
}

function draftDefinition(): WorkflowDefinition {
  return JSON.parse(elements["workflow-definition"].value) as WorkflowDefinition;
}

function setDraftDefinition(
  definition: WorkflowDefinition,
  { render = true }: { render?: boolean } = {},
): void {
  const latest = selectedRevision();
  if (
    definition?.schema_version === "2.1.0" &&
    latest !== null &&
    Number.isSafeInteger(latest) &&
    Number(definition.revision) <= latest
  ) {
    definition.revision = latest + 1;
  }
  if (!state.workflow) throw new Error("no workflow is selected");
  state.workflow.workflow = structuredClone(definition);
  elements["workflow-definition"].value = JSON.stringify(definition, null, 2);
  if (render) renderWorkflow();
}

function selectedNode(
  definition: WorkflowDefinition | undefined = state.workflow?.workflow,
): WorkflowNode | null {
  return (definition?.nodes ?? []).find((node) => node.id === state.workflowNodeId) ?? null;
}

function edgeKey(edge: WorkflowEdge): string {
  return `${edge.from}|${edge.to}|${edge.type}|${edge.condition ?? edge.artifact ?? ""}`;
}

function selectedEdge(
  definition: WorkflowDefinition | undefined = state.workflow?.workflow,
): WorkflowEdge | null {
  return (definition?.edges ?? []).find((edge) => edgeKey(edge) === state.workflowEdgeKey) ?? null;
}

function updateWorkflowView(view: string): void {
  state.workflowView = view;
  for (const [name, panelId] of Object.entries(WORKFLOW_VIEW_PANELS)) {
    elements[`workflow-view-${name}`].setAttribute("aria-selected", String(name === view));
    elements[panelId].hidden = name !== view;
  }
}

function renderSelectors(definition: WorkflowDefinition): void {
  const nodes = definition.nodes ?? [];
  if (!nodes.some((node) => node.id === state.workflowNodeId))
    state.workflowNodeId = nodes[0]?.id ?? null;
  const edges = definition.edges ?? [];
  if (!edges.some((edge) => edgeKey(edge) === state.workflowEdgeKey)) {
    state.workflowEdgeKey = edges[0] ? edgeKey(edges[0]) : null;
  }
  elements["workflow-node-select"].replaceChildren(
    ...nodes.map(
      (node) =>
        new Option(`${node.id} · ${node.kind}`, node.id, false, node.id === state.workflowNodeId),
    ),
  );
  elements["workflow-edge-select"].replaceChildren(
    ...edges.map(
      (edge) =>
        new Option(
          `${edge.from} → ${edge.to} · ${edge.type}`,
          edgeKey(edge),
          false,
          edgeKey(edge) === state.workflowEdgeKey,
        ),
    ),
  );
}

function renderInspector(definition: WorkflowDefinition): void {
  const node = selectedNode(definition);
  const controls = {
    "workflow-node-guidance": node?.guidance ?? "",
    "workflow-node-role": node?.role ?? "",
    "workflow-node-kind": node?.kind ?? "agent",
    "workflow-node-access": node?.access ?? "read",
    "workflow-node-tier": node?.tier ?? "",
    "workflow-node-payload": node?.payload_contract ?? "",
    "workflow-node-join": node?.join ?? "",
    "workflow-node-quorum": node?.quorum?.threshold ?? "",
    "workflow-node-failure": node?.failure_handling?.mode ?? "",
    "workflow-node-resource": node?.resource ?? "",
    "workflow-node-loop-mode": node?.loop?.mode ?? "bounded",
    "workflow-node-loop-bound": node?.loop?.max_iterations ?? 3,
    "workflow-node-loop-members": (node?.loop?.members ?? []).join(", "),
  };
  for (const [id, value] of Object.entries(controls)) elements[id].value = String(value);
  elements["workflow-node-verification"].checked = node?.verification === true;
  // Absent or true is a mutation checkpoint; only an explicit false is a release checkpoint.
  elements["workflow-node-checkpoint"].value =
    node?.mutation_checkpoint === false ? "release" : "mutation";
  elements["workflow-node-checkpoint-field"].hidden = node?.kind !== "checkpoint";
  elements["workflow-node-ownership"].checked = node?.ownership_plan === true;
  elements["workflow-inspector-help"].textContent = node
    ? `Editing ${node.id}. Use Delete to remove the selected node or edge, and connect two selected nodes in the structured list.`
    : "Add a node to begin structured workflow authoring.";
}

function renderLoopSummary(definition: WorkflowDefinition): void {
  const loops = (definition.nodes ?? []).filter(
    (node): node is WorkflowNode & { loop: NonNullable<WorkflowNode["loop"]> } =>
      Boolean(node.loop),
  );
  elements["workflow-loop-summary"].textContent = loops.length
    ? loops
        .map(
          (node) =>
            `${node.id}: ${node.loop.mode ?? "bounded"}, at most ${node.loop.max_iterations} iterations`,
        )
        .join(". ")
    : "No loop nodes in this revision.";
}

function isExpertJson(definition: WorkflowDefinition): boolean {
  return ["2.0.0", "2.2.0"].includes(definition.schema_version ?? "");
}

function updateExpertMode(definition: WorkflowDefinition): void {
  const expert = isExpertJson(definition);
  for (const control of elements["workflow-structured-controls"].querySelectorAll<
    HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
  >("button, input, select, textarea")) {
    control.disabled = expert || mutationLocked();
  }
  elements["workflow-version-help"].textContent = expert
    ? `Workflow ${definition.schema_version} is an expert-only JSON surface. Structured v2.1 authoring is disabled.`
    : "JSON is for schema 2.0 and 2.2 experts. Use structured controls for standard graph authoring.";
}

function neighborIds(edges: WorkflowEdge[], nodeId: string, direction: "to" | "from"): string[] {
  return edges
    .filter((edge) => (direction === "to" ? edge.to : edge.from) === nodeId)
    .map((edge) => (direction === "to" ? edge.from : edge.to))
    .sort();
}

function isCollapsibleNode(node: WorkflowNode): boolean {
  return node.kind === "agent" && node.access === "read";
}

function fanoutSignatures(definition: WorkflowDefinition): Map<string, WorkflowNode[]> {
  const edges = definition.edges ?? [];
  const signatures = new Map<string, WorkflowNode[]>();
  for (const node of definition.nodes ?? []) {
    if (!isCollapsibleNode(node)) continue;
    const incoming = neighborIds(edges, node.id, "to");
    const outgoing = neighborIds(edges, node.id, "from");
    const signature = `${incoming.join(",")}|${outgoing.join(",")}`;
    if (!signatures.has(signature)) signatures.set(signature, []);
    signatures.get(signature)!.push(node);
  }
  return new Map(
    [...signatures.values()]
      .filter((group) => group.length > 2)
      .flatMap((group) => group.map((node) => [node.id, group])),
  );
}

function fanoutVertex(group: WorkflowNode[]): GraphVertex {
  return {
    id: `fanout:${group
      .map((item) => item.id)
      .sort()
      .join("+")}`,
    kind: "fan-out",
    access: "read",
    tier: group.every((item) => item.tier === group[0].tier) ? group[0].tier : "mixed",
    members: group.map((item) => item.id).sort(),
  };
}

function groupedVertices(definition: WorkflowDefinition): {
  vertices: GraphVertex[];
  aliases: Map<string, string>;
} {
  const collapsed = fanoutSignatures(definition);
  const emitted = new Set<string>();
  const vertices: GraphVertex[] = [];
  const aliases = new Map<string, string>();
  for (const node of definition.nodes ?? []) {
    const group = collapsed.get(node.id);
    if (!group) {
      vertices.push({ ...node, members: [node.id] });
      aliases.set(node.id, node.id);
      continue;
    }
    const vertex = fanoutVertex(group);
    aliases.set(node.id, vertex.id);
    if (emitted.has(vertex.id)) continue;
    emitted.add(vertex.id);
    vertices.push(vertex);
  }
  return { vertices, aliases };
}

function topology(definition: WorkflowDefinition): {
  vertices: GraphVertex[];
  edges: WorkflowEdge[];
  layers: Layers;
} {
  const { vertices, aliases } = groupedVertices(definition);
  const edges = normalizedEdges(definition.edges ?? [], vertices, aliases);
  return { vertices, edges, layers: topologyLayers(vertices, edges) };
}

function normalizedEdges(
  sourceEdges: WorkflowEdge[],
  vertices: GraphVertex[],
  aliases: Map<string, string>,
): WorkflowEdge[] {
  const ids = new Set(vertices.map(({ id }) => id));
  const seen = new Set<string>();
  return sourceEdges.flatMap((edge) => uniqueEdge(edge, ids, aliases, seen));
}

function uniqueEdge(
  edge: WorkflowEdge,
  ids: Set<string>,
  aliases: Map<string, string>,
  seen: Set<string>,
): WorkflowEdge[] {
  const from = aliases.get(edge.from) ?? edge.from;
  const to = aliases.get(edge.to) ?? edge.to;
  if (!ids.has(from) || !ids.has(to) || from === to) return [];
  const detail = firstDefined(edge.condition, edge.artifact, "");
  const key = `${from}|${to}|${edge.type}|${detail}`;
  if (seen.has(key)) return [];
  seen.add(key);
  return [{ ...edge, from, to }];
}

function topologyLayers(vertices: GraphVertex[], edges: WorkflowEdge[]): Layers {
  const depth = new Map(vertices.map(({ id }) => [id, 0]));
  const acyclic = edges.filter((edge) => edge.type !== "loop-back");
  const incoming = new Map(vertices.map(({ id }) => [id, 0]));
  for (const edge of acyclic) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const queue = [...vertices.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id)].sort();
  while (queue.length) {
    const id = queue.shift()!;
    advanceTopologyDepth(id, acyclic, depth, incoming, queue);
    queue.sort();
  }
  return groupedLayers(vertices, depth);
}

function advanceTopologyDepth(
  id: string,
  edges: WorkflowEdge[],
  depth: Map<string, number>,
  incoming: Map<string, number>,
  queue: string[],
): void {
  for (const edge of edges.filter((candidate) => candidate.from === id)) {
    depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, (depth.get(id) ?? 0) + 1));
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) - 1);
    if (incoming.get(edge.to) === 0) queue.push(edge.to);
  }
}

function groupedLayers(vertices: GraphVertex[], depth: Map<string, number>): Layers {
  const layers: Layers = new Map();
  for (const vertex of vertices) {
    const layer = depth.get(vertex.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(vertex);
  }
  for (const layer of layers.values()) layer.sort((left, right) => left.id.localeCompare(right.id));
  return layers;
}

function renderGraph(definition: WorkflowDefinition): void {
  const graph = elements["workflow-graph-content"];
  graph.replaceChildren();
  const { vertices, edges, layers } = topology(definition);
  setGraphViewBox(layers);
  const positions = graphPositions(layers);
  const paths = renderEdges(graph, edges, positions);
  renderNodes(graph, vertices, positions);
  // Labels follow the nodes so their halos sit above every box and line they cross.
  for (const [edgeRecord, path, from, to] of paths) {
    graph.append(edgeLabel(edgeRecord, path, from, to));
  }
}

function setGraphViewBox(layers: Layers): void {
  const maximumRows = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const maximumDepth = Math.max(0, ...layers.keys());
  const width = Math.max(640, GRAPH_MARGIN_X * 2 + maximumDepth * COLUMN_PITCH + NODE_WIDTH);
  const height = Math.max(250, maximumRows * ROW_PITCH + 45);
  const svg = elements["workflow-graph"];
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  // Draw at 1:1 so labels keep their size; the surrounding .graph-scroll scrolls instead.
  svg.style.setProperty("--graph-width", `${width}px`);
  svg.style.setProperty("--graph-height", `${height}px`);
}

function graphPositions(layers: Layers): Positions {
  const positions: Positions = new Map();
  for (const [layerIndex, layer] of layers) {
    layer.forEach((node, row) => {
      positions.set(node.id, {
        x: GRAPH_MARGIN_X + layerIndex * COLUMN_PITCH,
        y: GRAPH_MARGIN_Y + row * ROW_PITCH,
      });
    });
  }
  return positions;
}

type DrawnEdge = [WorkflowEdge, SVGPathElement, Position, Position];

function renderEdges(graph: Element, edges: WorkflowEdge[], positions: Positions): DrawnEdge[] {
  const drawn: DrawnEdge[] = [];
  for (const edgeRecord of edges) {
    const from = positions.get(edgeRecord.from);
    const to = positions.get(edgeRecord.to);
    if (!from || !to) continue;
    const path = edgePath(edgeRecord, from, to);
    graph.append(path);
    drawn.push([edgeRecord, path, from, to]);
  }
  return drawn;
}

function edgePath(edgeRecord: WorkflowEdge, from: Position, to: Position): SVGPathElement {
  const edge = document.createElementNS(SVG_NS, "path");
  edge.setAttribute("class", `workflow-edge workflow-edge--${edgeRecord.type}`);
  edge.setAttribute("d", edgePathData(edgeRecord.type, from, to));
  return edge;
}

/** Start, two control points and end of an edge's cubic Bézier. */
function edgeCurve(type: string, from: Position, to: Position): Position[] {
  const start = { x: from.x + NODE_WIDTH, y: from.y + NODE_HEIGHT / 2 };
  const end = { x: to.x, y: to.y + NODE_HEIGHT / 2 };
  if (type === "loop-back") {
    const bend = Math.min(from.y, to.y) - 18;
    return [start, { x: start.x + 25, y: bend }, { x: end.x - 25, y: bend }, end];
  }
  const bend = (start.x + end.x) / 2;
  return [start, { x: bend, y: start.y }, { x: bend, y: end.y }, end];
}

function edgePathData(type: string, from: Position, to: Position): string {
  const [start, first, second, end] = edgeCurve(type, from, to);
  return `M${start.x} ${start.y} C${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`;
}

function bezierPoint([p0, p1, p2, p3]: Position[], t: number): Position {
  const u = 1 - t;
  const at = (key: "x" | "y") =>
    u * u * u * p0[key] + 3 * u * u * t * p1[key] + 3 * u * t * t * p2[key] + t * t * t * p3[key];
  return { x: at("x"), y: at("y") };
}

/** Midpoint of a forward edge by arc length; the highest point of a loop-back arc. */
function labelPoint(type: string, path: SVGPathElement, from: Position, to: Position): Position {
  const curve = edgeCurve(type, from, to);
  if (type === "loop-back") {
    let apex = bezierPoint(curve, 0.5);
    for (let step = 0; step <= 20; step += 1) {
      const point = bezierPoint(curve, step / 20);
      if (point.y < apex.y) apex = point;
    }
    return apex;
  }
  try {
    const length = path.getTotalLength();
    const point = length > 0 ? path.getPointAtLength(length / 2) : null;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      return { x: point.x, y: point.y };
    }
  } catch {
    // Geometry can be unavailable while the panel is not rendered; the curve is symmetric.
  }
  return bezierPoint(curve, 0.5);
}

function edgeLabel(
  edgeRecord: WorkflowEdge,
  path: SVGPathElement,
  from: Position,
  to: Position,
): SVGTextElement {
  const label = document.createElementNS(SVG_NS, "text");
  const point = labelPoint(edgeRecord.type, path, from, to);
  label.setAttribute("class", "workflow-edge-label");
  label.setAttribute("x", String(Math.round(point.x)));
  label.setAttribute("y", String(Math.round(point.y)));
  // Complete condition and artifact values remain available in the equivalent tables.
  label.textContent =
    edgeRecord.type === "condition"
      ? "when"
      : edgeRecord.type === "loop-back"
        ? "loop"
        : edgeRecord.type;
  return label;
}

function renderNodes(graph: Element, vertices: GraphVertex[], positions: Positions): void {
  for (const node of vertices) {
    const position = positions.get(node.id);
    if (!position) continue;
    const group = document.createElementNS(SVG_NS, "g");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = node.kind === "fan-out" ? `${node.members.join(", ")} (parallel)` : node.id;
    group.append(
      title,
      nodeRectangle(node, position),
      nodeText(node, position),
      nodeBadge(node, position),
    );
    graph.append(group);
  }
}

function nodeRectangle(node: GraphVertex, { x, y }: Position): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", `workflow-node workflow-node--${node.kind}`);
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(NODE_WIDTH));
  rect.setAttribute("height", String(NODE_HEIGHT));
  return rect;
}

/** Ellipsises text to a monospace character budget; the node's <title> keeps the full value. */
function fitText(value: string, characters: number): string {
  return value.length <= characters ? value : `${value.slice(0, characters - 1)}…`;
}

function nodeText(node: GraphVertex, { x, y }: Position): SVGTextElement {
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(x + 8));
  text.setAttribute("y", String(y + 24));
  text.textContent = fitText(
    node.kind === "fan-out" ? `${node.members.length} parallel nodes` : node.id,
    NODE_ID_CHARACTERS,
  );
  return text;
}

function nodeBadge(node: GraphVertex, { x, y }: Position): SVGTextElement {
  const badge = document.createElementNS(SVG_NS, "text");
  badge.setAttribute("class", "workflow-node-badge");
  badge.setAttribute("x", String(x + 8));
  badge.setAttribute("y", String(y + 46));
  badge.textContent = fitText(`${node.kind} · ${node.tier ?? node.access}`, NODE_BADGE_CHARACTERS);
  return badge;
}

function structuredTable(caption: string, columns: string[], rows: unknown[][]): HTMLTableElement {
  const table = document.createElement("table");
  const captionElement = document.createElement("caption");
  captionElement.textContent = caption;
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column;
    headingRow.append(cell);
  }
  head.append(headingRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      cell.textContent = String(value ?? "");
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(captionElement, head, body);
  return table;
}

function renderStructure(definition: WorkflowDefinition): void {
  const instances = visibleInstances(definition);
  elements["workflow-structure"].replaceChildren(
    structuredTable(
      "Nodes",
      ["ID", "Kind", "Access", "Tier", "Join or fan-out", "Failure"],
      (definition.nodes ?? []).map(nodeStructureRow),
    ),
    structuredTable(
      "Edges",
      ["From", "To", "Type", "Artifact or condition"],
      (definition.edges ?? []).map(edgeStructureRow),
    ),
    structuredTable(
      "Live and completed node instances",
      ["Instance", "Node", "Status", "Attempt", "Item key", "Tier", "Decision"],
      instances.map(instanceStructureRow),
    ),
  );
}

function visibleInstances(definition: WorkflowDefinition): WorkflowInstance[] {
  const run = currentRun();
  const matches =
    run?.workflow?.workflow_id === definition.workflow_id ||
    run?.workflow?.digest === state.workflow?.digest;
  return matches && run?.workflow && "instances" in run.workflow
    ? ((run.workflow.instances ?? []) as WorkflowInstance[])
    : [];
}

function nodeStructureRow(node: WorkflowNode): unknown[] {
  return [
    node.id,
    node.kind,
    node.access,
    node.tier ?? "standard",
    nodeJoinLabel(node),
    node.failure_handling?.mode ?? "fail-workflow",
  ];
}

function nodeJoinLabel(node: WorkflowNode): string {
  if (node.join === "quorum") return `quorum ${node.quorum?.threshold ?? "?"}`;
  return node.join ?? (node.map ? `map ≤${node.map.max_items ?? 32}` : "—");
}

function edgeStructureRow(edge: WorkflowEdge): unknown[] {
  return [edge.from, edge.to, edge.type, edge.condition ?? edge.artifact ?? "—"];
}

function instanceStructureRow(instance: WorkflowInstance): unknown[] {
  return [
    instance.instance_id,
    instance.node_id,
    instance.status,
    instance.attempt,
    instance.item_key ?? "—",
    instance.execution_tier,
    instanceDecisionLabel(instance),
  ];
}

function instanceDecisionLabel(instance: WorkflowInstance): string {
  if (instance.selection) return `selected ${String(instance.selection.winner ?? "input")}`;
  if (instance.quorum)
    return `quorum ${instance.quorum.passed ?? instance.quorum.accepted ?? "—"}/${instance.quorum.threshold ?? "—"}`;
  return instance.convergence?.dry ? "converged" : "—";
}

/** Reads the catalogue summaries, which the background poll keeps current. */
function mutationLocked(): boolean {
  // The Pages bootstrap is mock-only and must keep its in-memory registry controls explorable.
  if (document.documentElement.dataset.demo === "true") return false;
  return state.runs.some(
    (run) =>
      run.runtime_active || ["running", "waiting", "phase-active"].includes(run.status ?? ""),
  );
}

/** Re-applies the registry lock after the run summaries change. */
export function refreshWorkflowLocks(): void {
  if (!state.workflow) return;
  updateExpertMode(state.workflow.workflow);
  updateMutationControls();
}

let registryLocked = false;

function setWorkflowStatus(text: string): void {
  if (elements["workflow-status"].textContent !== text)
    elements["workflow-status"].textContent = text;
}

function updateMutationControls(): void {
  const locked = mutationLocked();
  for (const control of mutationControls()) {
    control.disabled = locked;
  }
  elements["workflow-definition"].readOnly = locked;
  if (locked === registryLocked) return;
  registryLocked = locked;
  // Status copy changes only on a lock transition so the 10 s poll never overwrites
  // validation, proposal or draft messages.
  const lockedCopy = "Registry is read-only while a run is active.";
  if (locked) setWorkflowStatus(lockedCopy);
  else if (elements["workflow-status"].textContent === lockedCopy)
    setWorkflowStatus("Registry unlocked. No run is active.");
}

/** Validation is read-only and stays available while a run is active. */
function mutationControls() {
  return [
    elements["workflow-draft"],
    elements["workflow-activate"],
    elements["workflow-add-node"],
    elements["workflow-delete-node"],
    elements["workflow-add-edge"],
    elements["workflow-delete-edge"],
    elements["workflow-propose"],
  ];
}

function renderWorkflowBudget(definition: WorkflowDefinition): void {
  elements["workflow-budget"].textContent = definition.budgets
    ? `Budgets: concurrency ${definition.budgets.max_concurrency ?? 4}; map ${definition.budgets.max_map_items ?? 32}; pipeline depth ${definition.budgets.max_pipeline_depth ?? 4}; dynamic instances or attempts ${definition.budgets.max_dynamic_instances ?? 128}; repair rounds ${definition.budgets.max_repair_rounds ?? 5}.`
    : "No explicit revision budgets.";
}

function renderWorkflowDetails(workflow: WorkflowRecord): void {
  elements["workflow-details"].replaceChildren(
    ...Object.entries({
      id: workflow.workflow_id,
      active_revision:
        workflow.active?.workflow_id === workflow.workflow_id ? workflow.active?.revision : "none",
      latest_revision: selectedRevision() ?? "none",
      digest: workflow.digest,
    }).map(([key, value]) => {
      const box = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = key.replace("_", " ");
      dd.textContent = String(value ?? "");
      box.append(dt, dd);
      return box;
    }),
  );
}

function renderWorkflowHistory(workflow: WorkflowRecord): void {
  const history = workflow.activation_history ?? [];
  elements["workflow-history"].replaceChildren(
    ...history.map((item) => {
      const li = document.createElement("li");
      li.textContent =
        typeof item === "string"
          ? item
          : `Revision ${item.revision ?? "unknown"} · ${
              item.activated_at ? formatDateTime(item.activated_at) : "time not recorded"
            }`;
      return li;
    }),
  );
}

function renderWorkflow(): void {
  const workflow = state.workflow;
  if (!workflow) return;
  const definition = workflow.workflow;
  elements["workflow-definition"].value = JSON.stringify(definition, null, 2);
  renderWorkflowBudget(definition);
  renderWorkflowDetails(workflow);
  renderWorkflowHistory(workflow);
  renderGraph(definition);
  renderStructure(definition);
  renderSelectors(definition);
  renderInspector(definition);
  renderLoopSummary(definition);
  updateWorkflowView(state.workflowView);
  updateExpertMode(definition);
  updateMutationControls();
}

async function selectWorkflow(id: string): Promise<void> {
  state.workflowId = id;
  state.workflow = (
    await api<{ workflow: WorkflowRecord }>(`${base()}/${encodeURIComponent(id)}`)
  ).workflow;
  renderWorkflow();
  [...elements["workflow-list"].querySelectorAll("button")].forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.workflowId === id));
  });
}

export async function loadWorkflows(): Promise<void> {
  if (!state.projectId) return;
  elements["workflow-status"].textContent = "Loading workflow registry…";
  const [payload, templatePayload] = await Promise.all([
    api<{ workflows?: WorkflowListItem[] }>(base()),
    api<{ templates?: Array<{ id: string; title: string }> }>(`${base()}/templates`),
  ]);
  elements["workflow-template"].replaceChildren(
    new Option("Keep current workflow", ""),
    ...(templatePayload.templates ?? []).map((template) => new Option(template.title, template.id)),
  );
  state.workflows = payload.workflows ?? [];
  elements["workflow-list"].replaceChildren(
    ...state.workflows.map((workflow) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.workflowId = workflow.workflow_id;
      button.textContent = `${workflow.workflow_id} · r${workflow.latest_revision ?? "—"}${workflow.active ? " · active" : ""}`;
      button.addEventListener("click", () => selectWorkflow(workflow.workflow_id).catch(showError));
      return button;
    }),
  );
  elements["workflow-empty"].hidden = state.workflows.length > 0;
  const retained = state.workflows.find((workflow) => workflow.workflow_id === state.workflowId);
  if (!retained) {
    state.workflowId = null;
    state.workflow = null;
  }
  const selected = retained ?? state.workflows[0];
  if (selected) await selectWorkflow(selected.workflow_id);
  elements["workflow-status"].textContent =
    "Registry loaded. Drafts cannot change while a run is active.";
  updateMutationControls();
}

function makeNodeId(definition: WorkflowDefinition): string {
  const ids = new Set((definition.nodes ?? []).map((node) => node.id));
  for (let number = 1; number <= 64; number += 1) {
    const id = `node-${number}`;
    if (!ids.has(id)) return id;
  }
  throw new Error("workflow already has the maximum number of nodes");
}

function addNode(): void {
  const definition = draftDefinition();
  const id = makeNodeId(definition);
  definition.nodes = [
    ...(definition.nodes ?? []),
    {
      id,
      kind: "agent",
      access: "read",
      guidance: "Describe the bounded work and required evidence.",
    },
  ];
  state.workflowNodeId = id;
  setDraftDefinition(definition);
}

function deleteNode(): void {
  const definition = draftDefinition();
  const node = selectedNode(definition);
  if (!node) return;
  if ([definition.entry_node, definition.terminal_node].includes(node.id))
    throw new Error("entry and terminal nodes cannot be deleted");
  definition.nodes = definition.nodes.filter((item) => item.id !== node.id);
  definition.edges = (definition.edges ?? []).filter(
    (edge) => edge.from !== node.id && edge.to !== node.id,
  );
  state.workflowNodeId = definition.nodes[0]?.id ?? null;
  setDraftDefinition(definition);
}

function connectSelectedNodes(): void {
  const definition = draftDefinition();
  const from = selectedNode(definition);
  const target = selectedEdge(definition)?.to ?? definition.terminal_node;
  if (!from || !target || from.id === target)
    throw new Error("select a node and an edge whose destination will receive the connection");
  const edge = { from: from.id, to: target, type: "sequence" };
  if (!(definition.edges ?? []).some((item) => edgeKey(item) === edgeKey(edge)))
    definition.edges.push(edge);
  state.workflowEdgeKey = edgeKey(edge);
  setDraftDefinition(definition);
}

function deleteEdge(): void {
  const definition = draftDefinition();
  if (!state.workflowEdgeKey) return;
  definition.edges = (definition.edges ?? []).filter(
    (edge) => edgeKey(edge) !== state.workflowEdgeKey,
  );
  state.workflowEdgeKey = definition.edges[0] ? edgeKey(definition.edges[0]) : null;
  setDraftDefinition(definition);
}

function applyInspector(): void {
  const definition = draftDefinition();
  const node = selectedNode(definition);
  if (!node) return;
  node.guidance = elements["workflow-node-guidance"].value.trim();
  node.kind = elements["workflow-node-kind"].value;
  if (node.kind !== "map") delete node.map;
  if (node.kind !== "transform") delete node.transform;
  for (const [field, id] of [
    ["role", "workflow-node-role"],
    ["tier", "workflow-node-tier"],
    ["payload_contract", "workflow-node-payload"],
    ["join", "workflow-node-join"],
    ["resource", "workflow-node-resource"],
  ] as const) {
    const value = elements[id].value.trim();
    if (value) node[field] = value;
    else delete node[field];
  }
  node.access = elements["workflow-node-access"].value;
  const failure = elements["workflow-node-failure"].value;
  if (failure) node.failure_handling = { mode: failure };
  else delete node.failure_handling;
  node.verification = elements["workflow-node-verification"].checked;
  if (node.kind === "checkpoint") {
    node.mutation_checkpoint = elements["workflow-node-checkpoint"].value !== "release";
  } else delete node.mutation_checkpoint;
  node.ownership_plan = elements["workflow-node-ownership"].checked;
  if (node.join === "quorum") {
    node.quorum = { threshold: Number(elements["workflow-node-quorum"].value || 1) };
  } else delete node.quorum;
  if (node.kind === "loop") {
    const members = elements["workflow-node-loop-members"].value
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    node.loop = {
      mode: elements["workflow-node-loop-mode"].value,
      max_iterations: Number(elements["workflow-node-loop-bound"].value || 1),
      members: members.length ? [...new Set(members)] : [node.id],
    };
  } else delete node.loop;
  setDraftDefinition(definition);
}

async function applyTemplate(name: string): Promise<void> {
  if (!name) return;
  const definition = draftDefinition();
  const result = await api<{ workflow: WorkflowDefinition }>(`${base()}/templates`, {
    method: "POST",
    body: JSON.stringify({
      template_id: name,
      workflow_id: definition.workflow_id,
      revision: (selectedRevision() ?? 0) + 1,
    }),
  });
  state.workflowNodeId = result.workflow.entry_node ?? null;
  setDraftDefinition(result.workflow);
  elements["workflow-template"].value = "";
}

async function analyzeDraft(): Promise<void> {
  const result = await api<unknown>(
    `${base()}/${encodeURIComponent(state.workflowId ?? "")}/analysis`,
    {
      method: "POST",
      body: JSON.stringify({ workflow: draftDefinition() }),
    },
  );
  elements["workflow-analysis-output"].textContent = JSON.stringify(result, null, 2);
  updateWorkflowView("analyze");
}

async function pollProposal(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await api<{
      proposal: { state: string; candidate: WorkflowDefinition; error?: string };
    }>(
      `${base()}/${encodeURIComponent(state.workflowId ?? "")}/proposals/${encodeURIComponent(jobId)}`,
    );
    const proposal = result.proposal;
    if (proposal.state === "completed") {
      setDraftDefinition(proposal.candidate);
      elements["workflow-status"].textContent =
        "Proposal loaded into the unsaved editor. Save and activate remain separate decisions.";
      return;
    }
    if (proposal.state === "failed") throw new Error(proposal.error ?? "workflow proposal failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("workflow proposal timed out in the local console");
}

async function proposeDraft(): Promise<void> {
  const task = elements["workflow-proposal-task"].value.trim();
  const profileId = elements["workflow-proposal-profile"].value;
  const result = await api<{ id: string }>(
    `${base()}/${encodeURIComponent(state.workflowId ?? "")}/proposals`,
    {
      method: "POST",
      body: JSON.stringify({
        task,
        base_revision: selectedRevision(),
        ...(profileId ? { execution_profile_id: profileId } : {}),
      }),
    },
  );
  elements["workflow-status"].textContent = "Generating an unsaved workflow proposal…";
  await pollProposal(result.id);
}

/** Delete edits text in fields; it removes a node only from non-text controls. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

export function bindWorkflowEditor(): void {
  elements["workflow-refresh"].addEventListener("click", () => loadWorkflows().catch(showError));
  for (const view of ["loop", "graph", "analyze", "json"]) {
    elements[`workflow-view-${view}`].addEventListener("click", () => {
      if (view === "analyze") analyzeDraft().catch(showError);
      else updateWorkflowView(view);
    });
  }
  elements["workflow-template"].addEventListener("change", () => {
    applyTemplate(elements["workflow-template"].value).catch(showError);
  });
  elements["workflow-node-select"].addEventListener("change", () => {
    state.workflowNodeId = elements["workflow-node-select"].value;
    if (state.workflow) renderInspector(state.workflow.workflow);
  });
  elements["workflow-edge-select"].addEventListener("change", () => {
    state.workflowEdgeKey = elements["workflow-edge-select"].value;
  });
  const structuredActions = {
    "workflow-add-node": addNode,
    "workflow-delete-node": deleteNode,
    "workflow-add-edge": connectSelectedNodes,
    "workflow-delete-edge": deleteEdge,
    "workflow-propose": proposeDraft,
  };
  for (const [id, action] of Object.entries(structuredActions)) {
    elements[id].addEventListener("click", () => Promise.resolve(action()).catch(showError));
  }
  for (const id of [
    "workflow-node-guidance",
    "workflow-node-role",
    "workflow-node-kind",
    "workflow-node-access",
    "workflow-node-tier",
    "workflow-node-payload",
    "workflow-node-join",
    "workflow-node-quorum",
    "workflow-node-failure",
    "workflow-node-resource",
    "workflow-node-verification",
    "workflow-node-checkpoint",
    "workflow-node-ownership",
    "workflow-node-loop-mode",
    "workflow-node-loop-bound",
    "workflow-node-loop-members",
  ]) {
    elements[id].addEventListener("change", () => applyInspector());
  }
  elements["workflow-draft-form"].addEventListener("keydown", (event) => {
    if (event.key !== "Delete" || isTextEntry(event.target)) return;
    event.preventDefault();
    try {
      deleteNode();
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-draft-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const workflow = JSON.parse(elements["workflow-definition"].value) as WorkflowDefinition;
      const result = await api<{
        revision: { revision: number; workflow: WorkflowDefinition; digest: string };
      }>(`${base()}/${encodeURIComponent(state.workflowId ?? "")}/drafts`, {
        method: "POST",
        body: JSON.stringify({
          workflow,
          expected_revision: selectedRevision(),
          actor: elements["workflow-actor"].value,
          rationale: elements["workflow-rationale"].value,
        }),
      });
      if (!state.workflow) throw new Error("no workflow is selected");
      state.workflow.revisions ??= [];
      state.workflow.revisions.push(result.revision);
      state.workflow.workflow = result.revision.workflow;
      state.workflow.digest = result.revision.digest;
      showToast("Draft revision saved.", "notice");
      renderWorkflow();
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-validate"].addEventListener("click", async () => {
    try {
      const revision = selectedRevision();
      const result = await api<{ validation: unknown }>(
        `${base()}/${encodeURIComponent(state.workflowId ?? "")}/revisions/${encodeURIComponent(revision ?? "")}/validate`,
        { method: "POST", body: "{}" },
      );
      elements["workflow-status"].textContent = `Validation: ${JSON.stringify(result.validation)}`;
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-diff"].addEventListener("click", async () => {
    try {
      const query = new URLSearchParams();
      const from = elements["workflow-diff-base"].value;
      const to = selectedRevision();
      if (from) query.set("from", from);
      if (to !== null && to !== undefined) query.set("to", String(to));
      const diff = await api<{ diff: unknown }>(
        `${base()}/${encodeURIComponent(state.workflowId ?? "")}/diff${query.size ? `?${query}` : ""}`,
      );
      elements["workflow-diff-output"].textContent = JSON.stringify(diff.diff, null, 2);
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-activate"].addEventListener("click", async () => {
    try {
      const revision = selectedRevision();
      const result = await api<{ activation?: { revision?: number } }>(
        `${base()}/${encodeURIComponent(state.workflowId ?? "")}/revisions/${encodeURIComponent(revision ?? "")}/activate`,
        {
          method: "POST",
          body: JSON.stringify({
            digest: elements["workflow-digest-confirmation"].value,
            actor: elements["workflow-actor"].value,
            rationale: elements["workflow-rationale"].value,
          }),
        },
      );
      elements["workflow-status"].textContent =
        `Activated ${result.activation?.revision ?? revision}.`;
      if (state.workflowId) await selectWorkflow(state.workflowId);
    } catch (error) {
      showError(error);
    }
  });
}
