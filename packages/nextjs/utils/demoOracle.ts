import type { HermesQuote } from "./pyth";
import { type Hex, encodeAbiParameters } from "viem";

/**
 * Demo oracle mode.
 *
 * Pyth's Hermes service needs an API key that covers the HBAR/USD feed. To let anyone run the whole
 * payment flow without one, the contract can be deployed against Pyth's own `MockPyth` instead of
 * the real Pyth contract (`DEMO_ORACLE=true yarn hardhat:deploy --network hederaTestnet`). The
 * contract code is identical; only the address it reads the price from changes.
 *
 * `MockPyth` accepts whatever price a payer submits, so this mode is for testnet only. The page
 * detects it by comparing the contract's `PYTH` address with the real Pyth address below.
 *
 * Keep this file free of Next.js imports so the Hardhat tests can load it.
 */

/**
 * Pyth EVM contract on Hedera (same address on testnet and mainnet).
 * Source: https://docs.pyth.network/price-feeds/core/contract-addresses/evm
 */
export const HEDERA_PYTH_ADDRESS = "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729";

/** Exponent used for demo prices: price 10_000_000 means $0.10 per HBAR. */
export const DEMO_PRICE_EXPO = -8;

const DEMO_PRICE_PATTERN = /^(\d{1,6})(?:\.(\d{1,8}))?$/;

/** True when the contract reads its price from something other than the real Pyth contract. */
export function isDemoOracle(pythAddress: string): boolean {
  return pythAddress.toLowerCase() !== HEDERA_PYTH_ADDRESS.toLowerCase();
}

/**
 * Parses a demo price in USD per HBAR (for example "0.10") into Pyth units at `DEMO_PRICE_EXPO`.
 * Returns null for anything that is not a positive number with at most 8 decimals.
 */
export function parseDemoPrice(input: string): bigint | null {
  const match = DEMO_PRICE_PATTERN.exec(input.trim());
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  const price = whole * 10n ** 8n + fraction;
  return price > 0n ? price : null;
}

const MOCK_PRICE_COMPONENTS = [
  { name: "price", type: "int64" },
  { name: "conf", type: "uint64" },
  { name: "expo", type: "int32" },
  { name: "publishTime", type: "uint256" },
] as const;

/**
 * Builds the payload `MockPyth.updatePriceFeeds` expects, which is
 * `abi.encode(PythStructs.PriceFeed, uint64 prevPublishTime)`. Equivalent to calling
 * `MockPyth.createPriceFeedUpdateData` with zero confidence and the EMA equal to the price.
 */
export function buildDemoUpdate(priceId: Hex, price: bigint, publishTime: number): Hex {
  const priceInfo = { price, conf: 0n, expo: DEMO_PRICE_EXPO, publishTime: BigInt(publishTime) };
  return encodeAbiParameters(
    [
      {
        name: "priceFeed",
        type: "tuple",
        components: [
          { name: "id", type: "bytes32" },
          { name: "price", type: "tuple", components: MOCK_PRICE_COMPONENTS },
          { name: "emaPrice", type: "tuple", components: MOCK_PRICE_COMPONENTS },
        ],
      },
      { name: "prevPublishTime", type: "uint64" },
    ],
    [{ id: priceId, price: priceInfo, emaPrice: priceInfo }, 0n],
  );
}

/** A quote in the same shape the Hermes flow returns, built from a typed-in demo price. */
export function buildDemoQuote(priceId: Hex, price: bigint, publishTime: number): HermesQuote {
  return {
    updateData: [buildDemoUpdate(priceId, price, publishTime)],
    price,
    expo: DEMO_PRICE_EXPO,
    publishTime,
  };
}
