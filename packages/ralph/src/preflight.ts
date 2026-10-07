/** Checks whether the configured provider environment exposes sensitive values. */
import { EXIT, RalphError } from "./errors.js";
import type { Logger } from "./logger.js";
import { containsCredential, sanitizedEnv } from "./runner.js";
import type { CliOptions } from "./types.js";

const SENSITIVE_NAMES = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "API_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "AWS_",
  "DATABASE_URL",
  "POSTGRES_URL",
  "STRIPE_",
  "GITHUB_",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
/** Forwarded on purpose so the provider can authenticate; noted instead of flagged. */
const FORWARDED_CREDENTIAL = "OPENAI_API_KEY";
/** Filesystem locations whose values can look token-shaped; only URL userinfo is checked. */
const PATH_NAMES = new Set(["PWD", "HOME", "PATH", "TMPDIR", "OLDPWD"]);

function sensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.some((pattern) => name.toUpperCase().includes(pattern));
}

/** Detects user:password@ style credentials in URLs, including scheme-less proxy settings. */
function hasUserinfo(name: string, value: string): boolean {
  const candidates = value.includes("://")
    ? [value]
    : /proxy/iu.test(name)
      ? [`http://${value}`]
      : [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return true;
    } catch {
      /* not a URL */
    }
  }
  return false;
}

/** Names the risks in the environment the provider receives, never the values. */
function forwardedRisks(env: NodeJS.ProcessEnv): string[] {
  const risks: string[] = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (name === FORWARDED_CREDENTIAL || !value) continue;
    if (sensitiveName(name)) risks.push(name);
    else if (hasUserinfo(name, value)) risks.push(`${name}(url-credentials)`);
    else if (!PATH_NAMES.has(name) && containsCredential(value))
      risks.push(`${name}(credential-value)`);
  }
  return risks;
}

/** Scans the environment the provider will receive; parent-only variables are informational. */
export function securityPreflight(
  options: CliOptions,
  logger: Logger,
  env: NodeJS.ProcessEnv = sanitizedEnv(process.cwd()),
  parent: NodeJS.ProcessEnv = process.env,
): void {
  if (env[FORWARDED_CREDENTIAL]) {
    logger.event("INFO", `security_preflight_forwarded var=${FORWARDED_CREDENTIAL}`);
    logger.log(`Note: ${FORWARDED_CREDENTIAL} is forwarded to the provider environment.`);
  }
  if (!options.securityPreflight) {
    logger.event("INFO", "security_preflight=disabled");
    return;
  }
  const parentOnly = Object.keys(parent)
    .filter((name) => env[name] === undefined && parent[name] && sensitiveName(name))
    .sort();
  if (parentOnly.length) {
    logger.event("INFO", `security_preflight_parent_only vars=${parentOnly.join(",")}`);
    logger.log(`Security preflight (info): not forwarded to the provider: ${parentOnly.join(",")}`);
  }
  const detected = forwardedRisks(env);
  if (!detected.length) {
    logger.event("INFO", "security_preflight=clean");
    return;
  }
  logger.event("WARN", `security_preflight=detected vars=${detected.join(",")}`);
  logger.warn(`Security preflight detected sensitive environment variables: ${detected.join(",")}`);
  logger.warn("Use least privilege and unset unneeded secrets for autonomous runs.");
  if (options.securityPreflightFail)
    throw new RalphError(
      `Security preflight blocked run due sensitive environment variables (vars=${detected.join(",")})`,
      EXIT.security,
    );
}
