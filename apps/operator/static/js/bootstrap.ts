/** Startup sequencing: every step reports its own failure and never blocks the next. */

export interface BootstrapStep {
  run: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** Runs the steps in order; a failing step is reported by its own handler only. */
export async function runBootstrapSteps(steps: readonly BootstrapStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      step.onError(error);
    }
  }
}
