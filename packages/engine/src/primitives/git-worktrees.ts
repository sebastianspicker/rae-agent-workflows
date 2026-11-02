/** Git's worktree registry: the authoritative list of every linked worktree location. */
import { spawnSync } from "node:child_process";

/** Absolute worktree roots registered with the repository at `directory`, or null when git fails. */
export function registeredWorktreeRoots(directory: string): string[] | null {
  const result = spawnSync("git", ["-C", directory, "worktree", "list", "--porcelain", "-z"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}
