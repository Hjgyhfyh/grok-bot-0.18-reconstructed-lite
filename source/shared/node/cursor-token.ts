import { createHash } from "node:crypto";

/**
 * The Cursor backend is not reachable from this build. The URL can only come from the
 * environment, and an empty one makes every client that would dial it fail before a socket
 * is opened. Nothing in DB Bot Lite is expected to call these clients any more.
 */
export const DEFAULT_CURSOR_BACKEND_URL = process.env.SAND_BACKEND_URL?.trim() ?? "";
export const PROD_AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const DEV_AUTH_CLIENT_ID = "OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE";
export const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export interface JwtPayload { readonly email?: string; readonly exp?: number; readonly sub?: string; readonly [key: string]: unknown; }

export function parseJwtPayload(token: string): JwtPayload | null {
  const [, payload] = token.split(".");
  if (payload == null || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.email !== undefined && typeof record.email !== "string") return null;
    if (record.exp !== undefined && typeof record.exp !== "number") return null;
    if (record.sub !== undefined && typeof record.sub !== "string") return null;
    return record as JwtPayload;
  } catch { return null; }
}

export function accountCacheScope(accessToken: string): string {
  return createHash("sha256").update(parseJwtPayload(accessToken)?.sub ?? accessToken).digest("hex");
}

export function isTokenExpiringSoon(token: string, now = Date.now()): boolean {
  const payload = parseJwtPayload(token);
  return payload?.exp == null || payload.exp * 1_000 - now < TOKEN_REFRESH_LEEWAY_MS;
}

export function getAccessTokenExpiryMs(token: string): number | null {
  const exp = parseJwtPayload(token)?.exp;
  return exp == null || !Number.isFinite(exp) ? null : exp * 1_000;
}

export function getConfiguredBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_BACKEND_URL?.trim() ?? env.CURSOR_API_BASE_URL?.trim() ?? DEFAULT_CURSOR_BACKEND_URL;
  return configured.length === 0 ? "" : new URL(configured).toString();
}

export function getAuthClientId(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_AUTH_CLIENT_ID;
  if (configured != null && configured.length > 0) return configured;
  const hostname = new URL(backendUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".lclhst.build") || hostname === "dev-staging.cursor.sh" ? DEV_AUTH_CLIENT_ID : PROD_AUTH_CLIENT_ID;
}

export function isDevAuthBackend(backendUrl: string): boolean { return getAuthClientId(backendUrl) !== PROD_AUTH_CLIENT_ID; }
export function shouldRefreshAccessToken(backendUrl: string, accessToken: string): boolean { return isTokenExpiringSoon(accessToken) || isDevAuthBackend(backendUrl); }
