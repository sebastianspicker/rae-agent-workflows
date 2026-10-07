/** Normalizes recorded and planned shell commands so Codex command evidence can be matched. */

const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh)\s+(?:-[a-z]*c[a-z]*)\s+([\s\S]+)$/;

/** Removes one level of shell quoting from a single word; unquoted text is returned unchanged. */
function unquoteShellWord(word: string): string {
  const text = word.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("'\\''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return text;
}

/**
 * Unwraps `sh|bash|zsh -lc <cmd>` into the inner command (repeatedly) and collapses whitespace.
 * Codex reports shell-joined commands such as `bash -lc 'npm test'` for what the plan lists as `npm test`.
 */
export function normalizeEvidenceCommand(command: unknown): string {
  let text = String(command ?? "").trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const match = SHELL_WRAPPER.exec(text);
    if (!match) break;
    text = unquoteShellWord(match[1]).trim();
  }
  return text.replace(/\s+/g, " ");
}
