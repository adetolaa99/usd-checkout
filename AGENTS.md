# Agent instructions

Briefing for coding agents in this repo (Cursor, Claude Code, Codex, and anything else that reads `AGENTS.md`). Claude Code loads it through `CLAUDE.md`.

## What this project is

A Scaffold-HBAR template called **USD Checkout**. Merchants create invoices priced in US dollars; customers pay in HBAR. `UsdCheckout.sol` converts dollars to HBAR using a Pyth price that the payer submits with the payment. Hardhat for contracts, Next.js App Router for the UI. Target network: Hedera testnet (chain 296).

Read `README.md` first for the payment flow and the Hedera unit rules. This file covers how to change the code safely.

## Commands

Use the package manager this project was created with (`packageManager` in the root `package.json`). Examples use `yarn`; with npm, replace `yarn <script>` with `npm run <script>`.

```bash
yarn install
yarn hardhat:test                              # contract + amount-math tests, offline, ~1 s
yarn hardhat:compile
yarn lint                                      # eslint for nextjs and hardhat, must be warning-free
yarn next:check-types
yarn hardhat:check-types                       # needs generated types: run yarn hardhat:compile (or yarn hardhat:test) once first
yarn next:build

yarn hardhat:chain                             # local node (forks Hedera testnet), port 8545
yarn hardhat:deploy --network localhost        # deploys MockPyth + UsdCheckout locally
yarn hardhat:deploy --network hederaTestnet    # real deploy against Pyth, asks for the key password
DEMO_ORACLE=true yarn hardhat:deploy --network hederaTestnet   # demo oracle: MockPyth, no Pyth API key needed (PowerShell: $env:DEMO_ORACLE="true")
yarn hardhat:account:generate                  # encrypted deployer key into packages/hardhat/.env
yarn hardhat:verify -- UsdCheckout testnet     # Sourcify verification
yarn next:dev                                  # http://localhost:3000
```

Run `yarn hardhat:test`, `yarn lint` and both type checks before finishing a change.

## Layout

| Path | What lives there |
| --- | --- |
| `packages/hardhat/contracts/UsdCheckout.sol` | The only production contract. |
| `packages/hardhat/contracts/mocks/` | Test-only: `HostileMerchant`, and an import that makes Hardhat compile Pyth's `MockPyth`. Do not deploy these to a live network. |
| `packages/hardhat/deploy/00_deploy_usd_checkout.ts` | Deploys `MockPyth` + `UsdCheckout` locally or with `DEMO_ORACLE=true`, otherwise `UsdCheckout` against the real Pyth contract on Hedera. |
| `packages/hardhat/test/` | `UsdCheckout.test.ts` (contract), `frontendAmounts.test.ts` (the page's helpers from `packages/nextjs/utils/checkout.ts`), `hermesRequest.test.ts` (request helpers from `packages/nextjs/utils/hermes.ts`) and `demoOracle.test.ts` (demo price parsing and the mock update payload, checked against `MockPyth`). |
| `packages/nextjs/app/checkout/page.tsx` | The merchant and payer UI. |
| `packages/nextjs/utils/checkout.ts` | Dollar parsing, tinybar and wei scaling, slippage, HashScan links. |
| `packages/nextjs/utils/pyth.ts` | Browser side: asks `/api/hermes` for a signed Pyth price update. |
| `packages/nextjs/app/api/hermes/route.ts` | Server side: calls Pyth Hermes with the API key (`HERMES_API_KEY`, server only). |
| `packages/nextjs/utils/demoOracle.ts` | Demo oracle mode: detects a mock `PYTH` address, parses a typed-in price and builds the `MockPyth` update payload. No Next.js imports. |
| `packages/nextjs/utils/hermes.ts` | Request helpers for that route (URL, headers, error text); no Next.js imports so the tests can load it. |
| `packages/nextjs/contracts/deployedContracts.ts` | **Generated** by `yarn hardhat:deploy`. Do not edit by hand. |

## Rules that are easy to break

### 1. Units: tinybars inside the contract, 18 decimals in JSON-RPC

Inside a Hedera contract, `msg.value` and balances are in **tinybars** (8 decimals). Wallets and JSON-RPC send `value` in **18 decimals**, and the relay divides by 10^10. See Hedera's [decimal handling](https://docs.hedera.com/hedera/core-concepts/smart-contracts/understanding-hederas-evm-differences-and-compatibility/for-evm-developers-migrating-to-hedera/decimal-handling-8-vs.-18-decimals) page.

- The contract does everything in "native units" and reads the unit size from `NATIVE_DECIMALS` (8 on Hedera, 18 on a local chain).
- The page converts at one place only: `nativeToRpcValue` in `utils/checkout.ts`. Do not scale amounts anywhere else.
- Any change to amount math needs a test in both `UsdCheckout.test.ts` and `frontendAmounts.test.ts`.

### 2. The Pyth price must stay load-bearing

`pay` must keep: paying the Pyth update fee, reading the price with `getPriceNoOlderThan`, and the positive-price and confidence checks. Never fall back to a stored or hard-coded price. Never read the price with `getPriceUnsafe`.

### 3. Verify addresses and ids against primary sources

Do not copy a contract address or Pyth feed id from memory, search snippets, or another repo. Check them against:

- Pyth contract addresses: https://docs.pyth.network/price-feeds/core/contract-addresses/evm
- Pyth feed ids: https://pyth.dourolabs.app/hermes/v2/price_feeds?query=hbar&asset_type=crypto
- Hedera contract existence: `https://testnet.mirrornode.hedera.com/api/v1/contracts/<0.0.x or 0x address>`

Current values: Pyth on Hedera `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` (testnet and mainnet, contract id `0.0.3042133` on testnet); HBAR/USD feed `0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd`.

### 4. Secrets

Never commit `.env`, `.env.local`, private keys, API keys, or the encrypted key blob. `HERMES_API_KEY` lives only in `packages/nextjs/.env.local` and must never get a `NEXT_PUBLIC_` prefix, because that would ship it to the browser. The only deployer key flow is `yarn hardhat:account:generate` / `import`, which writes `DEPLOYER_PRIVATE_KEY_ENCRYPTED` to `packages/hardhat/.env` (git-ignored). Do not ask the user to paste a private key into a chat.

### 5. Template compatibility

`template.json` is validated by `create-scaffold-hbar` when someone scaffolds from this repo, and it is deleted from the scaffolded project. Keep it valid: `name` is required; `capabilities` and `defaults` here allow Next.js + Hardhat only. If you add a package manager or framework option, update the manifest and the tests.

### 6. Demo oracle mode is a deployment choice, never a code path

`DEMO_ORACLE=true` deploys the same `UsdCheckout` against Pyth's `MockPyth`, so the flow works without a Pyth API key. The page detects it by comparing the contract's `PYTH` address with the real Pyth address (`utils/demoOracle.ts`) and shows a warning banner. Keep it that way:

- Do not add a stored, hard-coded or admin-set price to `UsdCheckout.sol`; rule 2 still holds.
- `MockPyth` accepts any price, so the deploy script must keep refusing `DEMO_ORACLE=true` on `hederaMainnet`.
- Anything the page or README says about demo mode must say that the price is typed in by the payer and is not Pyth data.

## Hooks and UI conventions

Use the scaffold hooks from `~~/hooks/scaffold-hbar`:

- `useScaffoldReadContract` (not `useScaffoldContractRead`)
- `useScaffoldWriteContract` (not `useScaffoldContractWrite`)

```tsx
const { writeContractAsync } = useScaffoldWriteContract({ contractName: "UsdCheckout" });
await writeContractAsync({ functionName: "createInvoice", args: [cents, expiresAt, ref] });
```

Read hooks stay disabled while any argument is `undefined`, which the checkout page relies on. DaisyUI classes for components. Imports use the `~~` alias. `type` over `interface`. `UpperCamelCase` for types and components, `lowerCamelCase` for values, `CONSTANT_CASE` for constants, `snake_case` for Hardhat deploy files.

## Definition of done

1. `yarn hardhat:test` passes.
2. `yarn lint` has zero warnings, and `yarn next:check-types` and `yarn hardhat:check-types` pass (the latter needs `typechain-types`, which `yarn hardhat:compile` and `yarn hardhat:test` generate).
3. `yarn next:build` succeeds.
4. If the contract ABI changed, `yarn hardhat:deploy --network localhost` was run so `deployedContracts.ts` matches.
5. `README.md` still matches the behaviour you changed.
