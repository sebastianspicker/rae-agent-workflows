/** Shared startup guard for package entrypoints that may bypass the umbrella CLI (Node 24 or newer). */
export const NODE_RUNTIME_RANGE = ">=24.0.0";

export function nodeVersionSupported(version: unknown): boolean {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  return major >= 24;
}

export function assertSupportedNodeRuntime(version: string = process.versions.node): void {
  if (!nodeVersionSupported(version)) {
    throw new Error(`unsupported Node.js ${version}; RAE requires ${NODE_RUNTIME_RANGE}`);
  }
}
