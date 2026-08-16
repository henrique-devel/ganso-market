export const REFRESH_COOKIE_NAME = "ganso_refresh";
export const CSRF_COOKIE_NAME = "ganso_csrf";

// Browser-visible path of the auth endpoints (nginx maps /api/auth/* to the
// API's /auth/*). Cookies are scoped here so they are never sent to unrelated
// routes.
export const AUTH_COOKIE_PATH = "/api/auth";

export interface CookieAttributes {
  readonly maxAgeSeconds: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
}

export function parseCookies(
  header: string | undefined,
): ReadonlyMap<string, string> {
  const jar = new Map<string, string>();
  if (header === undefined) {
    return jar;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0 && !jar.has(name)) {
      jar.set(name, value);
    }
  }
  return jar;
}

export function serializeCookie(
  name: string,
  value: string,
  attributes: CookieAttributes,
): string {
  const segments = [
    `${name}=${value}`,
    `Path=${AUTH_COOKIE_PATH}`,
    "SameSite=Strict",
    `Max-Age=${String(attributes.maxAgeSeconds)}`,
  ];
  if (attributes.httpOnly) {
    segments.push("HttpOnly");
  }
  // Secure is intentionally omitted while the beta runs on HTTP; it becomes
  // mandatory the moment TLS is adopted (PRD AUTH-07).
  if (attributes.secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
}

export function clearCookie(name: string, httpOnly: boolean): string {
  return serializeCookie(name, "", {
    maxAgeSeconds: 0,
    httpOnly,
    secure: false,
  });
}
