/** Purpose: load and validate the experimental platform configuration. */
import fs from "node:fs/promises";
import net from "node:net";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const configSchema = z.object({
  management: z
    .object({
      host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
      port: z.coerce.number().int().min(1).max(65535).default(9090),
      intervalMs: z.coerce.number().int().min(100).max(60_000).default(5000),
      timeoutMs: z.coerce.number().int().min(1).max(60_000).default(2000),
    })
    .refine(
      (value) => value.timeoutMs <= value.intervalMs,
      "management timeoutMs must not exceed intervalMs",
    )
    .prefault({}),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().int().min(1).max(65535).default(8080),
      publicBaseUrl: z.url().optional(),
    })
    .prefault({}),
  database: z.object({
    url: z.string().min(1),
    // Permits an OIDC deployment to connect without sslmode=verify-full; never set it in hosted use.
    allowInsecure: z.boolean().default(false),
    // Sent as the `-c statement_timeout` startup option; 0 omits it for PgBouncer or RDS Proxy,
    // which reject startup options.
    statementTimeoutMs: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  }),
  oidc: z
    .object({
      issuer: z.url(),
      audience: z.string().min(1),
      jwksUrl: z.url(),
      tokenType: z.string().min(1).default("at+jwt"),
      algorithms: z
        .array(z.enum(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]))
        .min(1)
        .default(["RS256"]),
    })
    .optional(),
  auth: z
    .object({
      // Upper bound on exp - iat so a leaked long-lived token cannot be replayed indefinitely.
      maxTokenLifetimeSeconds: z.coerce.number().int().min(60).max(604_800).default(86_400),
    })
    .prefault({}),
  storage: z
    .object({
      bucket: z.string().min(1),
      region: z.string().min(1),
      endpoint: z.url().optional(),
      forcePathStyle: z.boolean().default(false),
    })
    .optional(),
  platform: z
    .object({
      development: z.boolean().default(false),
      allowInsecureAuth: z.boolean().default(false),
      allowInsecureHttp: z.boolean().default(false),
      leaseSeconds: z.coerce.number().int().min(10).max(3600).default(60),
      heartbeatSeconds: z.coerce.number().int().min(1).max(1800).default(20),
    })
    .refine(
      (value) => value.heartbeatSeconds < value.leaseSeconds / 2,
      "platform.heartbeatSeconds must be less than half of platform.leaseSeconds",
    )
    .prefault({}),
});

/** Classifies hostnames for configuration policy without performing DNS lookups. */
export function classifyHost(hostname: string) {
  const host = mappedIpv4(
    String(hostname)
      .replace(/^\[|\]$/g, "")
      .toLowerCase(),
  );
  const privateName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  const privateV4 =
    net.isIPv4(host) &&
    (/^10\./.test(host) ||
      /^127\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  const privateV6 =
    net.isIPv6(host) &&
    (host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb"));
  return privateName || privateV4 || privateV6 ? "private" : "public";
}

/** Identifies bind addresses that cannot resolve to a non-loopback interface. */
export function isLiteralLoopbackHost(hostname: string) {
  const host = String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "127.0.0.1" || host === "::1";
}

/** Rejects OIDC endpoints that could redirect production trust to a private host. */
export function assertPublicHttpsUrl(value: string, label: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
  if (classifyHost(url.hostname) === "private")
    throw new Error(`${label} must not target a private or loopback address`);
}

function assertInsecureConfigurationIsDevelopment(platform: PlatformConfig["platform"]) {
  if ((platform.allowInsecureAuth || platform.allowInsecureHttp) && !platform.development) {
    throw new Error("insecure authentication or HTTP requires platform.development=true");
  }
}

function assertInsecureConfigurationIsLoopback(config: PlatformConfig) {
  if (!config.platform.allowInsecureAuth && !config.platform.allowInsecureHttp) return;
  if (!isLiteralLoopbackHost(config.server.host))
    throw new Error("insecure authentication or HTTP requires a literal loopback server.host");
  if (!config.server.publicBaseUrl)
    throw new Error("insecure authentication or HTTP requires server.publicBaseUrl");
  const publicUrl = new URL(config.server.publicBaseUrl);
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error("insecure authentication or HTTP requires a credential-free HTTP(S) origin");
  }
  if (!isLiteralLoopbackHost(publicUrl.hostname))
    throw new Error(
      "insecure authentication or HTTP requires a literal loopback server.publicBaseUrl",
    );
}

function assertConfigurationTransport(config: PlatformConfig) {
  const publicUrl = config.server.publicBaseUrl ? new URL(config.server.publicBaseUrl) : null;
  if (!config.platform.allowInsecureHttp && publicUrl?.protocol !== "https:") {
    throw new Error("server.publicBaseUrl must use HTTPS unless platform.allowInsecureHttp=true");
  }
  if (config.oidc && !config.platform.allowInsecureHttp) {
    assertPublicHttpsUrl(config.oidc.issuer, "OIDC issuer");
    assertPublicHttpsUrl(config.oidc.jwksUrl, "OIDC JWKS URL");
  }
}

/** Lists the Host header names accepted by the platform listener. */
export function platformAllowedHosts(config: PlatformConfig) {
  const hosts = [config.server.host];
  if (config.server.publicBaseUrl) hosts.push(new URL(config.server.publicBaseUrl).hostname);
  return hosts.filter((host) => host.length > 0);
}

function assertDatabaseTransport(config: PlatformConfig) {
  if (!config.oidc || config.database.allowInsecure) return;
  let sslmode: string | null = null;
  try {
    sslmode = new URL(config.database.url).searchParams.get("sslmode");
  } catch {
    sslmode = null;
  }
  if (sslmode !== "verify-full")
    throw new Error(
      "database.url must use sslmode=verify-full with OIDC unless database.allowInsecure=true",
    );
}

export async function loadConfig(path = process.env.RAE_PLATFORM_CONFIG) {
  if (!path) throw new Error("RAE_PLATFORM_CONFIG must point to a TOML configuration file");
  const parsed = configSchema.parse(parseToml(await fs.readFile(path, "utf8")));
  if (!parsed.oidc && !parsed.platform.allowInsecureAuth) {
    throw new Error(
      "OIDC configuration is required unless platform.allowInsecureAuth=true for local experiments",
    );
  }
  assertInsecureConfigurationIsDevelopment(parsed.platform);
  assertInsecureConfigurationIsLoopback(parsed);
  assertConfigurationTransport(parsed);
  assertDatabaseTransport(parsed);
  return parsed;
}

export { configSchema };

export type PlatformConfig = z.infer<typeof configSchema>;

function mappedIpv4(host: string): string {
  if (!net.isIPv6(host)) return host;
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  const match = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!match) return host;
  const high = Number.parseInt(match[1], 16),
    low = Number.parseInt(match[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
