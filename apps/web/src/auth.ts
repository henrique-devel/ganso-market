export const CSRF_COOKIE_NAME = "ganso_csrf";

export interface AuthenticatedSession {
  readonly accessToken: string;
  readonly username: string;
  readonly expiresAt: string;
}

export type LoginOutcome =
  | { readonly kind: "ok"; readonly session: AuthenticatedSession }
  | { readonly kind: "invalid" }
  | { readonly kind: "locked" }
  | { readonly kind: "error" };

export type RefreshOutcome =
  | {
      readonly kind: "ok";
      readonly accessToken: string;
      readonly expiresAt: string;
    }
  | { readonly kind: "none" };

type AuthResponse = Pick<Response, "ok" | "status" | "json">;
export type AuthFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<AuthResponse>;

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function readCsrfCookie(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE_NAME) {
      return rest.join("=");
    }
  }
  return null;
}

export async function login(
  username: string,
  password: string,
  fetcher: AuthFetcher = fetch,
): Promise<LoginOutcome> {
  let response: AuthResponse;
  try {
    response = await fetcher("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 401) {
    return { kind: "invalid" };
  }
  if (response.status === 429) {
    return { kind: "locked" };
  }
  if (!response.ok) {
    return { kind: "error" };
  }
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (
      isString(body.access_token) &&
      isString(body.username) &&
      isString(body.expires_at)
    ) {
      return {
        kind: "ok",
        session: {
          accessToken: body.access_token,
          username: body.username,
          expiresAt: body.expires_at,
        },
      };
    }
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export async function refreshSession(
  csrfToken: string | null,
  fetcher: AuthFetcher = fetch,
): Promise<RefreshOutcome> {
  if (csrfToken === null) {
    return { kind: "none" };
  }
  let response: AuthResponse;
  try {
    response = await fetcher("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "x-csrf-token": csrfToken, accept: "application/json" },
    });
  } catch {
    return { kind: "none" };
  }
  if (!response.ok) {
    return { kind: "none" };
  }
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (isString(body.access_token) && isString(body.expires_at)) {
      return {
        kind: "ok",
        accessToken: body.access_token,
        expiresAt: body.expires_at,
      };
    }
    return { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

export async function getSession(
  accessToken: string,
  fetcher: AuthFetcher = fetch,
): Promise<{ username: string; expiresAt: string } | null> {
  let response: AuthResponse;
  try {
    response = await fetcher("/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (isString(body.username) && isString(body.expires_at)) {
      return { username: body.username, expiresAt: body.expires_at };
    }
    return null;
  } catch {
    return null;
  }
}

export async function logout(
  accessToken: string,
  csrfToken: string | null,
  fetcher: AuthFetcher = fetch,
): Promise<void> {
  try {
    await fetcher("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(csrfToken === null ? {} : { "x-csrf-token": csrfToken }),
      },
    });
  } catch {
    // Logout is best-effort on the client; the cookie is cleared server-side.
  }
}
