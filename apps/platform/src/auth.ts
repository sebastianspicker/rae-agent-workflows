/** Purpose: validate OIDC bearer tokens and enforce per-route scopes. */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { PLATFORM_SCOPES } from "./authorization.js";
export {
  authorizedProjects,
  PLATFORM_SCOPES,
  projectVisible,
  requireProject,
  requireScope,
  requireWorkerIdentity,
} from "./authorization.js";

function tokenScopes(payload: JWTPayload): Set<string> {
  return new Set([
    ...(typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []),
    // Azure AD emits `scp` as a space-delimited string; other issuers use an array.
    ...(typeof payload.scp === "string" ? payload.scp.split(/\s+/) : []),
    ...(Array.isArray(payload.scp)
      ? payload.scp.filter((scope): scope is string => typeof scope === "string")
      : []),
  ]);
}

/** Clock skew tolerated for issued-at claims, in seconds. */
const ISSUED_AT_SKEW_SECONDS = 60;

/** Distinguishes an unreachable or failing JWKS endpoint from an invalid token. */
function jwksUnavailable(error: unknown) {
  if (error instanceof errors.JWKSTimeout) return true;
  if (error instanceof errors.JOSEError)
    return (
      error.code === "ERR_JOSE_GENERIC" && /JSON Web Key Set HTTP response/.test(error.message)
    );
  // fetch() rejects with a TypeError (for example "fetch failed") on network failures.
  return error instanceof TypeError && /fetch/i.test(error.message);
}

function unauthorized(message: string) {
  return Object.assign(new Error(message), { statusCode: 401 });
}

export function createAuthenticator(
  config: PlatformConfig,
): (authorization?: string) => Promise<Principal> {
  const oidc = config.oidc;
  if (!oidc) {
    return async () => ({
      sub: "local-experiment",
      scopes: new Set(PLATFORM_SCOPES),
      claims: { projects: ["*"] },
    });
  }
  const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
  return async (authorization) => {
    // RFC 9110 auth schemes are case-insensitive.
    const bearer = /^bearer +([^\s]+)$/i.exec(authorization ?? "");
    if (!bearer) throw unauthorized("missing bearer token");
    try {
      const { payload } = await jwtVerify(bearer[1], jwks, {
        issuer: oidc.issuer,
        audience: oidc.audience,
        algorithms: oidc.algorithms,
        typ: oidc.tokenType,
        clockTolerance: ISSUED_AT_SKEW_SECONDS,
      });
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.sub !== "string" || typeof payload.exp !== "number" || payload.exp <= now)
        throw unauthorized("token subject and unexpired exp claims are required");
      // Lifetime is measured from issuance, so a token without iat or nbf cannot claim a short life.
      if (payload.iat !== undefined && typeof payload.iat !== "number")
        throw unauthorized("token iat claim must be numeric");
      const issuedAt =
        typeof payload.iat === "number"
          ? payload.iat
          : typeof payload.nbf === "number"
            ? payload.nbf
            : null;
      if (issuedAt === null) throw unauthorized("token iat or nbf claim is required");
      if (issuedAt > now + ISSUED_AT_SKEW_SECONDS)
        throw unauthorized("token iat must not be in the future");
      const maxLifetime = config.auth?.maxTokenLifetimeSeconds ?? 86_400;
      if (payload.exp - issuedAt > maxLifetime)
        throw unauthorized(`token lifetime exceeds auth.maxTokenLifetimeSeconds (${maxLifetime})`);
      return { sub: payload.sub, scopes: tokenScopes(payload), claims: payload };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401) throw error;
      if (jwksUnavailable(error))
        throw Object.assign(new Error("token signing keys are temporarily unavailable"), {
          statusCode: 503,
        });
      throw unauthorized("invalid bearer token");
    }
  };
}

import type { PlatformConfig } from "./config.js";
import type { Principal } from "./authorization.js";
