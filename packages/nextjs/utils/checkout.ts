/** Matches `UsdCheckout.Status`. */
export const INVOICE_STATUS = ["None", "Open", "Paid", "Cancelled"] as const;

/** Buffer added on top of the quote to absorb price movement; the contract refunds the excess. */
export const SLIPPAGE_BPS = 100n; // 1%

/** Decimals of the 18-decimal value that wallets and JSON-RPC use for native transfers. */
const RPC_VALUE_DECIMALS = 18;

/** Converts a dollar string such as "12.5" or "12.50" to cents. Returns null if invalid or zero. */
export function parseUsdToCents(input: string): bigint | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents > 0n ? cents : null;
}

/** Formats cents as a dollar string, e.g. 1050n -> "10.50". */
export function formatUsd(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * Amount to send with `pay`, in the contract's native units: the quote plus a slippage buffer
 * (rounded up) plus the Pyth update fee. Anything unused is refunded by the contract.
 */
export function maxNativeToSend(required: bigint, fee: bigint): bigint {
  return (required * (10_000n + SLIPPAGE_BPS) + 9_999n) / 10_000n + fee;
}

/**
 * Wallets and JSON-RPC use 18-decimal wei for `value`, while a Hedera contract sees tinybars
 * (8 decimals). Scale a native-unit amount up to the 18-decimal value the RPC expects.
 */
export function nativeToRpcValue(nativeAmount: bigint, nativeDecimals: number): bigint {
  return nativeAmount * 10n ** BigInt(RPC_VALUE_DECIMALS - nativeDecimals);
}

/**
 * Sanity check on the Pyth update fee: more than 0.01 HBAR for one price update means the fee
 * units are not what we expect, so the UI refuses to pay instead of overspending.
 */
export function isFeeReasonable(fee: bigint, nativeDecimals: number): boolean {
  return fee <= 10n ** BigInt(nativeDecimals) / 100n;
}

/** HashScan link for a transaction on the given Hedera chain id, or undefined for other chains. */
export function hashscanTxUrl(chainId: number, txHash: string): string | undefined {
  if (chainId === 296) return `https://hashscan.io/testnet/transaction/${txHash}`;
  if (chainId === 295) return `https://hashscan.io/mainnet/transaction/${txHash}`;
  return undefined;
}
