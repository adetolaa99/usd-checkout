import type { Hex } from "viem";

/**
 * Pyth Hermes serves signed price updates. The public instance is rate limited; to use another
 * instance (for example one that needs an API key) set NEXT_PUBLIC_HERMES_URL.
 */
export const HERMES_URL = (process.env.NEXT_PUBLIC_HERMES_URL || "https://hermes.pyth.network").replace(/\/$/, "");

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
 * Fetches the latest signed update for one Pyth price feed from Hermes.
 * Hermes returns the binary payload as hex without a 0x prefix, so we add it.
 */
export async function fetchHermesQuote(priceId: Hex): Promise<HermesQuote> {
  const url = `${HERMES_URL}/v2/updates/price/latest?ids%5B%5D=${priceId}&encoding=hex&parsed=true`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Hermes request failed (HTTP ${response.status}). Check NEXT_PUBLIC_HERMES_URL.`);
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
