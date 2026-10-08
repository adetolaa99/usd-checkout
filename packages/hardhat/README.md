# Hardhat package

Contracts, deploy scripts, tests and verification for the USD Checkout template. Run everything from the repo root with the `hardhat:*` scripts; inside this folder the unprefixed script names work too.

## Test (offline)

```bash
yarn hardhat:test
```

Runs on Hardhat's in-process chain, so it needs no network and no funds. It deploys Pyth's `MockPyth` and checks `UsdCheckout` against it:

- `test/UsdCheckout.test.ts`: configuration checks, invoice lifecycle, dollar-to-HBAR conversion (8 and 18 native decimals, rounding up), payment and refund, stale prices, wide confidence intervals, non-positive prices, expired and cancelled invoices, double payment, and a merchant that rejects funds or tries to re-enter.
- `test/frontendAmounts.test.ts`: the page's helpers in `packages/nextjs/utils/checkout.ts`, including that the value it sends is always a whole number of tinybars.
- `test/hermesRequest.test.ts`: the Hermes request helpers in `packages/nextjs/utils/hermes.ts` (Bearer header only when a key is set, base URL, feed id check, error text).
- `test/demoOracle.test.ts`: demo oracle mode: price parsing, the `MockPyth` update payload (checked against `MockPyth.createPriceFeedUpdateData`), and a full payment through the mock.

## Local chain

```bash
yarn hardhat:chain                        # terminal 1: local node forking Hedera testnet (port 8545)
yarn hardhat:deploy --network localhost   # terminal 2: deploys MockPyth + UsdCheckout
```

`yarn hardhat:deploy` without `--network localhost` deploys to a throwaway in-process network, not to the node from terminal 1. The local node needs internet access, because it forks Hedera testnet through Hashio.

## Hedera testnet

You need a deployer account with testnet HBAR. Without funds the deploy fails with `Sender account not found`.

```bash
yarn hardhat:account:generate                    # prints the 0x address; key is stored encrypted in packages/hardhat/.env
# fund that address at https://portal.hedera.com/faucet
yarn hardhat:deploy --network hederaTestnet      # asks for the password
yarn hardhat:verify -- UsdCheckout testnet       # optional: Sourcify verification, shown on HashScan
```

Use `yarn hardhat:account:import` to import an existing key instead of generating one.

By default the deploy script (`deploy/00_deploy_usd_checkout.ts`) uses the real Pyth contract on Hedera, `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`, and the HBAR/USD feed id `0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd` (Pyth mode). Override them with `PYTH_ADDRESS` and `PYTH_HBAR_USD_PRICE_ID` in `packages/hardhat/.env`.

To try the template without a Pyth API key, deploy in demo oracle mode. It deploys Pyth's `MockPyth` next to `UsdCheckout`, and the payer types the price. It is for testnet and local chains only, and the script refuses it on mainnet:

```bash
# macOS / Linux
DEMO_ORACLE=true yarn hardhat:deploy --network hederaTestnet
# Windows PowerShell
$env:DEMO_ORACLE="true"; yarn hardhat:deploy --network hederaTestnet
Remove-Item Env:DEMO_ORACLE
```

Either way, after a deploy `packages/nextjs/contracts/deployedContracts.ts` is regenerated; commit it.

## Layout

- `contracts/UsdCheckout.sol`: the contract
- `contracts/mocks/`: test helpers (`HostileMerchant`) and an import that compiles Pyth's `MockPyth`
- `deploy/`: hardhat-deploy script
- `scripts/`: account generation and import, deploy-with-key wrapper, Sourcify verification, ABI export for the frontend
- `test/`: tests
- `hardhat.config.ts`: networks `hardhat`, `localhost`, `hederaTestnet` (296), `hederaMainnet` (295). Forking is only enabled by `yarn hardhat:chain` and `yarn hardhat:fork`.
