import type { Hex } from "viem";

/** A signed Pyth price update plus the parsed price it contains. */
export type HermesQuote = {
  /** Payload(s) to pass to `UsdCheckout.pay` as `priceUpdate`. */
  updateData: Hex[];
  /** Pyth price: USD per HBAR is `price * 10^expo`. */
  price: bigint;
  expo: number;
  /** Unix time (seconds) at which Pyth published this price. */
  publishTime: number;
};

type HermesResponse = {
  binary?: { data?: string[] };
  parsed?: { price: { price: string; expo: number; publish_time: number } }[];
};

/**
 * Fetches the latest signed update for one Pyth price feed.
 * The browser calls this app's own /api/hermes route, which talks to Hermes with the API key
 * (HERMES_API_KEY, server only). Hermes returns the binary payload as hex without a 0x prefix,
 * so we add it.
 */
export async function fetchHermesQuote(priceId: Hex): Promise<HermesQuote> {
  const response = await fetch(`/api/hermes?id=${priceId}`, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Price update request failed (HTTP ${response.status}).`);
  }

  const body = (await response.json()) as HermesResponse;
  const data = body.binary?.data;
  const parsed = body.parsed?.[0]?.price;
  if (!data?.length || !parsed) {
    throw new Error("Hermes returned no price update for this feed id.");
  }

  return {
    updateData: data.map(item => (item.startsWith("0x") ? item : `0x${item}`) as Hex),
    price: BigInt(parsed.price),
    expo: parsed.expo,
    publishTime: parsed.publish_time,
  };
}
