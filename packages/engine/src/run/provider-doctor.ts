/** Provider readiness check shared by `agent doctor` and `experiment run`. */
import { agentDoctor, type DoctorResult } from "../agents/agent-executor.js";
import { loadExecutionProfile } from "../workflow/execution-profile.js";

export type ProviderDoctorReport = DoctorResult | (Record<string, unknown> & { success: boolean });

export interface ProviderDoctorTarget {
  provider?: string;
  model?: string;
  variant?: string;
  agentCommand?: string;
  allowUnsafeCommand?: boolean;
  executionProfile?: string;
  workspaceRoot: string;
}

/** Runs the doctor for one provider/model target, expanding an execution profile into its routes. */
export function doctorProviderTarget(target: ProviderDoctorTarget): ProviderDoctorReport {
  const baseOptions = {
    provider: (target.provider ?? "auto") as "auto",
    ...(target.agentCommand ? { command: target.agentCommand } : {}),
    allowUnsafeCommand: target.allowUnsafeCommand === true,
    workspaceRoot: target.workspaceRoot,
    ...(target.model ? { model: target.model } : {}),
    ...(target.variant ? { variant: target.variant } : {}),
  };
  if (!target.executionProfile) return agentDoctor(baseOptions);
  const loaded = loadExecutionProfile(target.executionProfile);
  if (loaded.profile.schema_version === "3.0.0") {
    const routes = Object.entries(loaded.profile.routes).map(([routeId, route]) => ({
      route_id: routeId,
      result: agentDoctor({
        ...baseOptions,
        provider: route.executor,
        model: route.model,
        ...(route.executor === "opencode" && route.variant ? { variant: route.variant } : {}),
      }),
    }));
    return {
      success: routes.length > 0 && routes.every((entry) => entry.result.success),
      provider: "mixed",
      execution_profile_digest: loaded.digest,
      routes,
    };
  }
  if (loaded.profile.schema_version === "2.0.0") {
    const surfaces = Object.entries(loaded.profile.capability_sets ?? {}).map(
      ([name, capabilities]) => ({
        name,
        result: agentDoctor({ ...baseOptions, capabilities }),
      }),
    );
    return {
      success: surfaces.length > 0 && surfaces.every((entry) => entry.result.success),
      provider: "codex",
      execution_profile_digest: loaded.digest,
      capability_sets: surfaces,
    };
  }
  return { ...agentDoctor(baseOptions), execution_profile_digest: loaded.digest };
}

/** One-line description of what failed: false capabilities and the doctor's detail, per route. */
export function failingDoctorChecks(report: ProviderDoctorReport): string {
  const parts: string[] = [];
  const visit = (value: unknown, label: string): void => {
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    if (entry.success === true) return;
    const capabilities = entry.capabilities;
    const failed =
      capabilities && typeof capabilities === "object"
        ? Object.entries(capabilities)
            .filter(([, ok]) => ok === false)
            .map(([name]) => name)
        : [];
    const detail = typeof entry.detail === "string" ? entry.detail : "";
    if (failed.length > 0 || detail)
      parts.push(
        `${label}${failed.length ? `${failed.join(", ")} failed` : ""}${failed.length && detail ? "; " : ""}${detail}`,
      );
    for (const key of ["routes", "capability_sets"]) {
      const children = entry[key];
      if (Array.isArray(children))
        for (const child of children as Record<string, unknown>[])
          visit(child.result, `${String(child.route_id ?? child.name)}: `);
    }
  };
  visit(report, "");
  return parts.join(" | ") || "doctor reported failure";
}
