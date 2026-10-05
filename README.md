# USD Checkout: a Scaffold-HBAR template

Price invoices in US dollars, get paid in HBAR. The customer submits a fresh [Pyth](https://pyth.network) price with the payment, and the contract converts the dollar amount to HBAR in the same transaction. No fresh Pyth price, no payment: the oracle is the point of this template, not decoration.

```bash
npm create scaffold-hbar@latest my-checkout -- --template adetolaa99/usd-checkout
```

Stack: Hardhat, Next.js (App Router), wagmi, RainbowKit, Hedera testnet, Pyth price feeds. Built on the Scaffold-HBAR blank template (MIT).

## Contents

- [What you get](#what-you-get)
- [How a payment works](#how-a-payment-works)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Deploy to Hedera testnet and try it](#deploy-to-hedera-testnet-and-try-it)
- [Testnet evidence](#testnet-evidence)
- [Configuration](#configuration)
- [Contract reference](#contract-reference)
- [Hedera details that matter here](#hedera-details-that-matter-here)
- [Security notes and limits](#security-notes-and-limits)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

## What you get

- `UsdCheckout.sol`: merchants create dollar-denominated invoices; anyone can pay one in HBAR. The contract refunds any overpayment in the same transaction.
- A `/checkout` page: create an invoice, fetch a live quote from Pyth Hermes, pay, and open the payment on HashScan.
- 29 tests that run offline: 21 on the contract (including stale prices, wide confidence intervals, rounding, a merchant that rejects funds, and re-entrancy) and 8 on the page's amount math.
- The Scaffold-HBAR extras: Debug Contracts page, block explorer, and Hedera testnet and mainnet network config.

## How a payment works

```
 Merchant                    Customer (browser)                   Hedera testnet
    |                               |                                    |
    | createInvoice($10.00) ------------------------------------------> UsdCheckout
    |                               |                                    |
    |                               | 1. GET /v2/updates/price/latest    |
    |                               |    from Pyth Hermes (signed price) |
    |                               | 2. read usdToNative() + updateFee()|
    |                               |    and add a 1% buffer             |
    |                               | 3. pay(invoiceId, priceUpdate) ---> UsdCheckout
    |                               |                                    |  a. pay Pyth its update fee
    |                               |                                    |  b. read the Pyth price (<= 60 s old,
    |                               |                                    |     confidence <= 1%)
    |                               |                                    |  c. dollars -> HBAR (rounded up)
    |  <---------- HBAR ------------------------------------------------|  d. forward HBAR to the merchant
    |                               |  <---------- refund of excess -----|  e. refund anything left over
```

The price update is signed by Pyth's publishers and verified on-chain by the Pyth contract, so the payer cannot invent a price. They can only submit a genuine one.

## Prerequisites

- [Node.js](https://nodejs.org/) 20.18.3 or later
- [Git](https://git-scm.com/) with `user.name` and `user.email` set
- [Yarn](https://yarnpkg.com/): `corepack enable && corepack prepare yarn@stable --activate`. npm also works when you scaffold with the CLI.
- A wallet that can add Hedera testnet (for example MetaMask). RainbowKit offers to switch to Hedera testnet for you.
- Testnet HBAR, from the [Hedera faucet](https://portal.hedera.com/faucet). It accepts a `0x` EVM address and creates the account on first use ([docs](https://docs.hedera.com/evm/quickstart/get-test-hbar)).

## Quick start

This path needs no wallet and no testnet funds.

```bash
yarn install
yarn hardhat:test      # 21 contract tests + 8 amount-math tests
yarn lint
yarn next:build
```

Run the app against a local chain (three terminals):

```bash
yarn hardhat:chain                        # local node forking Hedera testnet, on port 8545
yarn hardhat:deploy --network localhost   # deploys Pyth's MockPyth and UsdCheckout
yarn next:dev                             # http://localhost:3000
```

On a local chain the contract talks to `MockPyth`, which has no live prices, so the **Get live HBAR quote** button is disabled there. Use the local chain with the **Debug Contracts** page, and use Hedera testnet for the full payment flow below.

## Deploy to Hedera testnet and try it

1. **Create a deployer account.** The key is stored encrypted in `packages/hardhat/.env`, which is git-ignored.
   ```bash
   yarn hardhat:account:generate
   ```
   Choose a password. The command prints the account's `0x` address.
2. **Fund it.** Paste that address into the [faucet](https://portal.hedera.com/faucet).
3. **Deploy.** Enter your password when prompted.
   ```bash
   yarn hardhat:deploy --network hederaTestnet
   ```
   The script prints a HashScan link for the contract and updates `packages/nextjs/contracts/deployedContracts.ts`.
4. **Start the app.**
   ```bash
   yarn next:dev
   ```
5. **Use a funded wallet.** Fund the address of the wallet you will use in the browser through the faucet too (it can be the same account as the deployer if you import its key).
6. **Open `/checkout`**, connect the wallet, and make sure the network is **Hedera Testnet**.
7. **Create an invoice** (for example `$1.00`). The page shows the invoice count; the newest invoice id equals it.
8. **Pay it.** Enter the invoice id (or press **Latest**), press **Get live HBAR quote**, check the amount, and press **Pay invoice**. Confirm in your wallet.
9. **Find the proof.** The page shows a **View payment on HashScan** link. That is your testnet transaction.
10. *(Optional)* Verify the contract source on Sourcify so HashScan shows it as verified:
    ```bash
    yarn hardhat:verify -- UsdCheckout testnet
    ```

## Testnet evidence

| Item | Link |
| --- | --- |
| `UsdCheckout` contract (Hedera testnet) | https://hashscan.io/testnet/contract/0xbB7EFfBcd38765a5B00557b77aD3805F9261d665 |
| Contract creation transaction (SUCCESS) | https://hashscan.io/testnet/transaction/0x08470cabacb29302abbdcf6a822ed2f90e7d64dc8d3933fbdd9cec92b8d4f29c |
| `createInvoice` call from the /checkout page (SUCCESS) | https://hashscan.io/testnet/transaction/0x361a76bbe0ee708d4bec33ece285d6e85cb04b12ba2845e6d45daaa5c9692b1f |

## Configuration

All variables are optional. Defaults target Hedera testnet.

| Variable | File | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_HERMES_URL` | `packages/nextjs/.env.local` | Pyth Hermes instance. Default `https://hermes.pyth.network`. Set this if you hit rate limits or use an instance that needs an API key. |
| `NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL` | `packages/nextjs/.env.local` | Browser RPC for Hedera testnet. Default `https://testnet.hashio.io/api`. |
| `PYTH_ADDRESS` | `packages/hardhat/.env` | Pyth contract to use at deploy time. Default is the Hedera deployment `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`. |
| `PYTH_HBAR_USD_PRICE_ID` | `packages/hardhat/.env` | Pyth price feed id. Default is the HBAR/USD feed `0x3728e591…86dfbd`. |
| `DEPLOYER_PRIVATE_KEY_ENCRYPTED` | `packages/hardhat/.env` | Written by `yarn hardhat:account:generate`. Never commit it. |

Contract parameters are set in `packages/hardhat/deploy/00_deploy_usd_checkout.ts`:

| Parameter | Value | Meaning |
| --- | --- | --- |
| `maxPriceAge` | 60 s | Reject Pyth prices older than this when paying. |
| `maxConfidenceBps` | 100 | Reject prices whose confidence interval is wider than 1% of the price. |
| `nativeDecimals` | 8 on Hedera, 18 on a local chain | Units of `msg.value` inside the contract (see [below](#hedera-details-that-matter-here)). |

The addresses and feed id above come from [Pyth's contract address list](https://docs.pyth.network/price-feeds/core/contract-addresses/evm) and [Pyth Hermes](https://hermes.pyth.network/v2/price_feeds?query=hbar&asset_type=crypto).

## Contract reference

`packages/hardhat/contracts/UsdCheckout.sol`

| Function | What it does |
| --- | --- |
| `createInvoice(usdCents, expiresAt, ref)` | Creates an invoice payable to the caller. `usdCents` is in cents (`1000` = $10.00), `expiresAt` is a Unix time (`0` = never), `ref` is a 32-byte merchant reference. Returns the invoice id (ids start at 1). |
| `cancelInvoice(id)` | The merchant cancels an unpaid invoice. |
| `pay(id, priceUpdate)` | Payable. Pays Pyth's update fee, reads the price, converts the invoice amount, sends it to the merchant, and refunds the rest to the payer. `priceUpdate` may be empty if Pyth already holds a price fresher than `maxPriceAge`. |
| `usdToNative(usdCents, price, expo)` | View. Converts cents to native units at a given Pyth price, rounding up so the merchant is never short. |
| `updateFee(priceUpdate)` | View. The Pyth fee, in native units, for a given update. |
| `invoices(id)`, `payments(id)`, `invoiceCount()` | Invoice, settlement record (payer, time, amount paid, price used), and counter. |

Events: `InvoiceCreated`, `InvoicePaid`, `InvoiceCancelled`. Errors are custom errors (for example `InvoiceExpired`, `InsufficientPayment`, `PriceTooUncertain`), so reverts show up readable in the UI and in HashScan.

## Hedera details that matter here

Hedera counts HBAR in two precisions, and mixing them up is the classic bug in this kind of contract.

- **Inside a smart contract**, `msg.value` and `address.balance` are in **tinybars** (8 decimals).
- **In JSON-RPC** (wallets, viem, ethers), the `value` you send is in **18 decimals**, and the relay converts it. One tinybar is 10^10 of those units.

Source: Hedera's [Decimal Handling (8 vs. 18 Decimals)](https://docs.hedera.com/hedera/core-concepts/smart-contracts/understanding-hederas-evm-differences-and-compatibility/for-evm-developers-migrating-to-hedera/decimal-handling-8-vs.-18-decimals).

How the template handles it:

- `UsdCheckout` takes `nativeDecimals` in its constructor and does all math in native units. It is deployed with `8` on Hedera and `18` on a plain EVM chain, so the same code runs and is tested in both.
- The page multiplies the final amount by 10^10 before sending (`packages/nextjs/utils/checkout.ts`), so the value is always a whole number of tinybars. A test checks this for several prices.
- The page refuses to pay if Pyth's update fee is above 0.01 HBAR, which would mean the fee units are not what the page expects.

## Security notes and limits

This is a template and a learning reference, not an audited payment system.

- **Price timing.** A payer can choose which valid Pyth price to submit, as long as it is no older than `maxPriceAge` and newer than the one Pyth already stores. Over 60 seconds the HBAR price moves little, but a merchant who needs tighter bounds can lower `maxPriceAge`.
- **Whoever creates an invoice is paid.** Any address can create invoices, and the payer should check the merchant address. The pay page shows it.
- **Refunds and payouts use `call`.** If the merchant or the payer cannot receive HBAR, the whole payment reverts and the invoice stays open. `pay` is protected against re-entrancy.
- **No partial payments, no HBAR-to-dollar refunds.** An invoice is paid once, in full.
- **Hermes is a public service.** It is rate limited. Use `NEXT_PUBLIC_HERMES_URL` for production traffic.

## Project layout

```
packages/
  hardhat/
    contracts/UsdCheckout.sol          the contract
    contracts/mocks/                   HostileMerchant (tests), MockPyth import
    deploy/00_deploy_usd_checkout.ts   deploy script (MockPyth locally, real Pyth on Hedera)
    test/UsdCheckout.test.ts           contract tests
    test/frontendAmounts.test.ts       amount-math tests for the page
  nextjs/
    app/checkout/page.tsx              merchant and payer UI
    utils/checkout.ts                  dollars, cents, tinybars, slippage
    utils/pyth.ts                      Hermes client
```

Everything else is the standard Scaffold-HBAR layout. See [`AGENTS.md`](AGENTS.md) for working on this repo with an AI coding assistant.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Sender account not found` on deploy | The deployer address has no HBAR yet. Fund it at the faucet and retry. |
| Faucet page does not load | Try another browser or a private window, turn off VPN and ad blockers, or try another network. |
| `StalePrice` when paying | The quote is older than 60 seconds. Press **Get live HBAR quote** again, then pay. |
| `PriceTooUncertain` | Pyth reports a wide confidence interval right now. Wait a moment and fetch a new quote. |
| `InsufficientPayment` | The price moved more than the 1% buffer between quote and payment. Fetch a new quote. |
| Hermes error (HTTP 429) | The public Hermes is rate limited. Wait, or set `NEXT_PUBLIC_HERMES_URL`. |
| Quote button disabled | You are not on Hedera testnet, or the invoice is not open. |
| `Target Contract is not deployed` in the app | Deploy first, or switch the app's network to the one you deployed to. |

## Licence

MIT. Built on the Scaffold-HBAR blank template by BuidlGuidl and hedera-dev. See [`LICENCE`](LICENCE).
