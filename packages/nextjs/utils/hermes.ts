/**
 * Request helpers for Pyth Hermes, shared by the /api/hermes route and the tests.
 * Keep this file free of Next.js imports so the Hardhat tests can load it.
 *
 * Since Pyth's 26 August 2026 upgrade, Hermes needs an API key sent as
 * `Authorization: Bearer <key>` and is served from https://pyth.dourolabs.app/hermes.
 * Source: https://docs.pyth.network/price-feeds/core/upgrade/preparing
 */

export const DEFAULT_HERMES_URL = "https://pyth.dourolabs.app/hermes";

const PRICE_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type HermesEnv = Record<string, string | undefined>;

/** Hermes base URL: `HERMES_URL` if set, otherwise the default, without a trailing slash. */
export function hermesBaseUrl(env: HermesEnv = process.env): string {
  return (env.HERMES_URL || DEFAULT_HERMES_URL).replace(/\/+$/, "");
}

/** True for a 32-byte hex Pyth price feed id with a 0x prefix. */
export function isPriceId(value: string): boolean {
  return PRICE_ID_PATTERN.test(value);
}

/** URL of the latest signed update for one feed, with the payload hex encoded. */
export function hermesLatestUrl(baseUrl: string, priceId: string): string {
  return `${baseUrl}/v2/updates/price/latest?ids%5B%5D=${priceId}&encoding=hex&parsed=true`;
}

/** Request headers; the Bearer token is added only when a key is configured. */
export function hermesHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = apiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Shortens an upstream error body and removes the API key before it is shown in the page. */
export function cleanErrorDetail(text: string, apiKey?: string): string {
  // eslint-disable-next-line no-control-regex
  let detail = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const key = apiKey?.trim();
  if (key) detail = detail.split(key).join("[redacted]");
  return detail.length > 300 ? `${detail.slice(0, 300)}...` : detail;
}

/** A message the page can show for a failed Hermes response; `detail` is Hermes' own explanation. */
export function hermesErrorMessage(status: number, hasApiKey: boolean, detail = ""): string {
  const suffix = detail ? ` Hermes said: ${detail}` : "";
  if (status === 401) {
    return hasApiKey
      ? `Hermes rejected the API key (HTTP 401). Check HERMES_API_KEY in packages/nextjs/.env.local.${suffix}`
      : `Hermes needs an API key (HTTP 401). Set HERMES_API_KEY in packages/nextjs/.env.local and restart yarn next:dev.${suffix}`;
  }
  if (status === 403) {
    return `Hermes refused the request (HTTP 403). The key may not be allowed to read this price feed: check the key's feed access (grants) in Pyth Terminal.${suffix}`;
  }
  if (status === 429) return `Hermes is rate limiting this app (HTTP 429). Wait a minute and try again.${suffix}`;
  return `Hermes request failed (HTTP ${status}).${suffix}`;
}
