"use client";

import { useState } from "react";
import type { NextPage } from "next";
import { formatUnits, stringToHex } from "viem";
import { useAccount } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import {
  INVOICE_STATUS,
  formatUsd,
  hashscanTxUrl,
  isFeeReasonable,
  maxNativeToSend,
  nativeToRpcValue,
  parseUsdToCents,
} from "~~/utils/checkout";
import { buildDemoQuote, isDemoOracle, parseDemoPrice } from "~~/utils/demoOracle";
import { type HermesQuote, fetchHermesQuote } from "~~/utils/pyth";
import { notification } from "~~/utils/scaffold-hbar";

const OPEN_STATUS = 1;
const HEDERA_CHAIN_IDS = [295, 296];

const CheckoutPage: NextPage = () => {
  const { address } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const isHedera = HEDERA_CHAIN_IDS.includes(targetNetwork.id);

  // --- merchant: create an invoice -------------------------------------------------------------
  const [usdInput, setUsdInput] = useState("10.00");
  const [expiryMinutes, setExpiryMinutes] = useState("60");
  const [reference, setReference] = useState("");
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "UsdCheckout" });

  const handleCreate = async () => {
    const cents = parseUsdToCents(usdInput);
    if (cents === null) {
      notification.error("Enter a dollar amount such as 10.00");
      return;
    }
    if (new TextEncoder().encode(reference).length > 32) {
      notification.error("Reference must be 32 bytes or fewer");
      return;
    }
    const minutes = Number(expiryMinutes);
    const expiresAt = minutes > 0 ? BigInt(Math.floor(Date.now() / 1000) + Math.floor(minutes * 60)) : 0n;
    await writeContractAsync({
      functionName: "createInvoice",
      args: [cents, expiresAt, stringToHex(reference, { size: 32 })],
    });
  };

  // --- payer: quote and pay ----------------------------------------------------------------------
  const [invoiceIdInput, setInvoiceIdInput] = useState("");
  const [quote, setQuote] = useState<HermesQuote>();
  const [isQuoting, setIsQuoting] = useState(false);
  const [txHash, setTxHash] = useState<string>();

  const invoiceId = /^\d+$/.test(invoiceIdInput) ? BigInt(invoiceIdInput) : undefined;

  const { data: invoiceCount } = useScaffoldReadContract({ contractName: "UsdCheckout", functionName: "invoiceCount" });
  const { data: priceId } = useScaffoldReadContract({ contractName: "UsdCheckout", functionName: "PRICE_ID" });
  const { data: pythAddress } = useScaffoldReadContract({ contractName: "UsdCheckout", functionName: "PYTH" });
  const { data: nativeDecimals } = useScaffoldReadContract({
    contractName: "UsdCheckout",
    functionName: "NATIVE_DECIMALS",
  });
  const { data: invoice, refetch: refetchInvoice } = useScaffoldReadContract({
    contractName: "UsdCheckout",
    functionName: "invoices",
    args: [invoiceId],
  });

  const usdCents = invoice?.[3];
  const status = invoice?.[2];
  const isOpen = status === OPEN_STATUS;

  const { data: required } = useScaffoldReadContract({
    contractName: "UsdCheckout",
    functionName: "usdToNative",
    args: [usdCents, quote?.price, quote?.expo],
  });
  const { data: fee } = useScaffoldReadContract({
    contractName: "UsdCheckout",
    functionName: "updateFee",
    args: [quote?.updateData],
  });

  // Demo oracle mode: the contract reads its price from a mock Pyth contract (see utils/demoOracle.ts).
  const demoMode = pythAddress !== undefined && isDemoOracle(pythAddress);
  const [demoPriceInput, setDemoPriceInput] = useState("0.10");

  const decimals = nativeDecimals ?? 8;
  const feeIsReasonable = fee === undefined || isFeeReasonable(fee, decimals);

  const handleQuote = async () => {
    if (!priceId) return;
    if (demoMode) {
      const demoPrice = parseDemoPrice(demoPriceInput);
      if (demoPrice === null) {
        notification.error("Enter a demo price in USD per HBAR, such as 0.10");
        return;
      }
      setQuote(buildDemoQuote(priceId, demoPrice, Math.floor(Date.now() / 1000)));
      return;
    }
    setIsQuoting(true);
    try {
      setQuote(await fetchHermesQuote(priceId));
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Could not fetch a price update");
    } finally {
      setIsQuoting(false);
    }
  };

  const handlePay = async () => {
    if (invoiceId === undefined || !quote || required === undefined || fee === undefined || !nativeDecimals) return;
    const value = nativeToRpcValue(maxNativeToSend(required, fee), nativeDecimals);
    const hash = await writeContractAsync({
      functionName: "pay",
      args: [invoiceId, quote.updateData],
      value,
    });
    if (hash) {
      setTxHash(hash);
      await refetchInvoice();
    }
  };

  const quoteAgeSeconds = quote ? Math.max(0, Math.floor(Date.now() / 1000) - quote.publishTime) : undefined;
  const hashscanUrl = txHash ? hashscanTxUrl(targetNetwork.id, txHash) : undefined;

  return (
    <div className="flex flex-col items-center grow px-5 py-10 gap-8">
      <div className="text-center max-w-2xl">
        <h1 className="text-3xl font-bold m-0">USD checkout on Hedera</h1>
        <p className="text-base-content/70 mt-2">
          Price in dollars, get paid in HBAR. The conversion uses a price that the payer submits with the payment: a
          live Pyth price, or a typed-in demo price in demo oracle mode.
        </p>
      </div>

      {demoMode && (
        <div role="alert" className="alert alert-warning max-w-2xl">
          <span>
            <strong>Demo oracle mode.</strong> This contract reads its HBAR price from a mock Pyth contract, so the
            price is whatever you type below, not live Pyth data. Use it on testnet only. For live Pyth prices, deploy
            without <code>DEMO_ORACLE</code> (see the README).
          </span>
        </div>
      )}

      {!demoMode && !isHedera && (
        <div role="alert" className="alert alert-warning max-w-2xl">
          <span>
            You are on {targetNetwork.name}. Live Pyth prices are available on Hedera only, so switch the target network
            to Hedera testnet.
          </span>
        </div>
      )}

      <section className="bg-base-100 rounded-2xl shadow-md p-6 border border-base-300 w-full max-w-2xl">
        <h2 className="font-bold text-xl mt-0">1. Merchant: create an invoice</h2>
        <div className="flex flex-col gap-3">
          <label className="form-control">
            <span className="label-text">Amount (USD)</span>
            <input
              className="input input-bordered w-full"
              value={usdInput}
              onChange={event => setUsdInput(event.target.value)}
              inputMode="decimal"
              placeholder="10.00"
            />
          </label>
          <label className="form-control">
            <span className="label-text">Expires in (minutes, 0 = never)</span>
            <input
              className="input input-bordered w-full"
              value={expiryMinutes}
              onChange={event => setExpiryMinutes(event.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="form-control">
            <span className="label-text">Order reference (optional, up to 32 bytes)</span>
            <input
              className="input input-bordered w-full"
              value={reference}
              onChange={event => setReference(event.target.value)}
              placeholder="order-1001"
            />
          </label>
          <button className="btn btn-primary" onClick={handleCreate} disabled={!address || isMining}>
            {isMining ? "Waiting for wallet…" : "Create invoice"}
          </button>
          <p className="text-sm text-base-content/70 m-0">
            Invoices created so far: <strong>{invoiceCount?.toString() ?? "…"}</strong>. The newest invoice id equals
            this number.
          </p>
        </div>
      </section>

      <section className="bg-base-100 rounded-2xl shadow-md p-6 border border-base-300 w-full max-w-2xl">
        <h2 className="font-bold text-xl mt-0">2. Customer: pay an invoice</h2>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              className="input input-bordered grow"
              value={invoiceIdInput}
              onChange={event => {
                setInvoiceIdInput(event.target.value);
                setQuote(undefined);
                setTxHash(undefined);
              }}
              inputMode="numeric"
              placeholder="Invoice id"
            />
            <button
              className="btn btn-outline"
              onClick={() => invoiceCount && setInvoiceIdInput(invoiceCount.toString())}
              disabled={!invoiceCount}
            >
              Latest
            </button>
          </div>

          {invoiceId !== undefined && usdCents !== undefined && status !== undefined && (
            <div className="text-sm bg-base-200 rounded-lg p-3">
              <div>
                Amount due: <strong>${formatUsd(usdCents)}</strong>
              </div>
              <div>
                Status: <strong>{INVOICE_STATUS[status] ?? "Unknown"}</strong>
              </div>
              <div className="break-all">
                Pays to: <code>{invoice?.[0]}</code> (check this is the merchant you expect)
              </div>
            </div>
          )}

          {demoMode && (
            <label className="form-control">
              <span className="label-text">Demo price (USD per HBAR)</span>
              <input
                className="input input-bordered w-full"
                value={demoPriceInput}
                onChange={event => {
                  setDemoPriceInput(event.target.value);
                  setQuote(undefined);
                }}
                inputMode="decimal"
                placeholder="0.10"
              />
            </label>
          )}

          <button
            className="btn btn-secondary"
            onClick={handleQuote}
            disabled={pythAddress === undefined || (!demoMode && !isHedera) || !isOpen || !priceId || isQuoting}
          >
            {isQuoting ? "Fetching price…" : demoMode ? "Use demo price" : "Get live HBAR quote"}
          </button>

          {quote && required !== undefined && fee !== undefined && (
            <div className="text-sm bg-base-200 rounded-lg p-3 flex flex-col gap-1">
              <div>
                {demoMode ? "Demo price (typed by you, not from Pyth)" : "Pyth price"}:{" "}
                <strong>${(Number(quote.price) * 10 ** quote.expo).toFixed(5)}</strong> per HBAR
                {demoMode ? "" : ` (${quoteAgeSeconds}s old)`}
              </div>
              <div>
                You pay: <strong>{formatUnits(required, decimals)} HBAR</strong>
              </div>
              <div>
                {demoMode ? "Mock oracle" : "Pyth"} update fee: {formatUnits(fee, decimals)} HBAR. A 1% buffer is added
                to the amount sent; whatever is not needed is refunded in the same transaction.
              </div>
              {!feeIsReasonable && (
                <div role="alert" className="text-error font-semibold">
                  The Pyth update fee is unexpectedly large, so paying is disabled. Check the fee units before paying.
                </div>
              )}
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handlePay}
            disabled={
              !address ||
              !isOpen ||
              !quote ||
              required === undefined ||
              fee === undefined ||
              !feeIsReasonable ||
              isMining
            }
          >
            {isMining ? "Waiting for wallet…" : "Pay invoice"}
          </button>

          {hashscanUrl && (
            <a className="link link-primary text-sm" href={hashscanUrl} target="_blank" rel="noopener noreferrer">
              View payment on HashScan
            </a>
          )}
        </div>
      </section>
    </div>
  );
};

export default CheckoutPage;
