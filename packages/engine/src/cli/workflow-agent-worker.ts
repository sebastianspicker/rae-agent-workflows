#!/usr/bin/env node
/** Runs one graph workflow provider session in an isolated Node process. */
import { readFileSync } from "node:fs";
import { runAgentPhase } from "../agents/agent-executor.js";
import { killTrackedProcessGroups } from "../agents/bounded-process.js";

const controller = new AbortController();
for (const name of ["SIGTERM", "SIGINT"] as const) {
  process.on(name, () => {
    controller.abort(new Error(`workflow agent worker received ${name}`));
    // The parent escalates to SIGKILL after a short grace period; stop the provider group first.
    killTrackedProcessGroups();
  });
}

try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const result = await runAgentPhase({ ...request, signal: controller.signal });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
