/** Expands a preregistered experiment into a deterministic, seeded trial schedule. */
import { resolve } from "node:path";
import type {
  ExperimentsExperimentV1DefsArm,
  ExperimentsTaskSuiteV1DefsTask,
} from "@rae/contracts";
import { experimentDefaults, type LoadedExperiment } from "./experiment-contract.js";
import { DEFAULT_EXPERIMENT_WORKFLOW } from "./experiment-inputs.js";
import { DEFAULT_AUTONOMOUS_POLICY } from "./autonomous-policy.js";
import { createSeededRandom, deriveSeed, shuffle } from "./experiment-statistics.js";

export interface PlannedTrial {
  trial_id: string;
  arm_id: string;
  task_id: string;
  repetition: number;
  sequence: number;
}

/** Interleaved order rotates arm position per task so drift is spread evenly across arms. */
export function planTrials(loaded: Pick<LoadedExperiment, "experiment" | "tasks">): PlannedTrial[] {
  const { experiment } = loaded;
  const arms = experiment.arms;
  const order = experimentDefaults(experiment).order;
  const trials: PlannedTrial[] = [];
  let sequence = 0;
  const push = (
    arm: ExperimentsExperimentV1DefsArm,
    task: ExperimentsTaskSuiteV1DefsTask,
    repetition: number,
  ): void => {
    trials.push({
      trial_id: `${arm.arm_id}.${task.task_id}.r${repetition}`,
      arm_id: arm.arm_id,
      task_id: task.task_id,
      repetition,
      sequence: sequence++,
    });
  };
  for (let repetition = 1; repetition <= experiment.design.repetitions; repetition++) {
    const tasks = shuffle(
      loaded.tasks,
      createSeededRandom(deriveSeed(experiment.design.seed, `repetition:${repetition}`)),
    );
    if (order === "interleaved") {
      tasks.forEach((task, taskIndex) => {
        const rotation = (repetition - 1 + taskIndex) % arms.length;
        for (let armIndex = 0; armIndex < arms.length; armIndex++)
          push(arms[(armIndex + rotation) % arms.length], task, repetition);
      });
    } else {
      for (const arm of arms) for (const task of tasks) push(arm, task, repetition);
    }
  }
  const limit = experiment.budgets?.max_trials;
  return limit === undefined ? trials : trials.slice(0, limit);
}

/** Full `autonomous.js` argv (without node and the entrypoint) for one trial. */
export function trialRunArguments(
  loaded: LoadedExperiment,
  arm: ExperimentsExperimentV1DefsArm,
  task: ExperimentsTaskSuiteV1DefsTask,
  repositoryDir: string,
): string[] {
  const run = arm.run;
  const args = [
    "run",
    "--project-root",
    repositoryDir,
    "--task",
    task.prompt,
    "--checkpoint-policy",
    "none",
    "--json",
  ];
  const value = (flag: string, option: string | number | undefined): void => {
    if (option !== undefined) args.push(flag, String(option));
  };
  const path = (flag: string, option: string | undefined): void => {
    if (option !== undefined) args.push(flag, resolve(loaded.root, option));
  };
  path("--workflow", run.workflow ?? DEFAULT_EXPERIMENT_WORKFLOW);
  path("--execution-profile", run.execution_profile);
  path("--policy", run.policy ?? DEFAULT_AUTONOMOUS_POLICY);
  value("--context-mode", run.context_mode);
  value("--provider", run.provider);
  value("--model", run.model);
  value("--reasoning-effort", run.reasoning_effort);
  value("--variant", run.variant);
  value("--graph-memory", run.graph_memory);
  value("--max-concurrency", run.max_concurrency);
  value("--max-repair-rounds", run.max_repair_rounds);
  value("--timeout-seconds", run.timeout_seconds);
  value("--agent-command", run.agent_command);
  for (const agentArg of run.agent_args ?? []) args.push("--agent-arg", agentArg);
  if (run.allow_unsafe_command_provider === true) args.push("--allow-unsafe-command-provider");
  return args;
}
