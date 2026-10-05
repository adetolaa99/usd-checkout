import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";

/**
 * Pyth EVM contract on Hedera (same address on testnet and mainnet).
 * Source: https://docs.pyth.network/price-feeds/core/contract-addresses/evm
 */
const HEDERA_PYTH = "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729";

/**
 * Pyth price feed id for HBAR/USD, as used by Hedera's own `oracles` template.
 * Verify before deploying: https://hermes.pyth.network/v2/price_feeds?query=hbar&asset_type=crypto
 */
const HBAR_USD_PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";

/** Reject Pyth prices older than this many seconds at payment time. */
const MAX_PRICE_AGE_SECONDS = 60;
/** Reject Pyth prices whose confidence interval exceeds 1% of the price. */
const MAX_CONFIDENCE_BPS = 100;
/** Inside a Hedera contract, HBAR amounts are tinybars (8 decimals). */
const HEDERA_NATIVE_DECIMALS = 8;
/** Plain EVM chains (the local Hardhat node) use 18 decimals. */
const EVM_NATIVE_DECIMALS = 18;

const deployUsdCheckout: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const gasPrice = await getDeployGasPrice(hre);

  const isHedera = hre.network.name === "hederaTestnet" || hre.network.name === "hederaMainnet";

  let pythAddress = process.env.PYTH_ADDRESS || HEDERA_PYTH;
  if (!isHedera) {
    // Local chain: there is no Pyth contract, so deploy Pyth's own mock (1 unit fee per update).
    const mock = await deploy("MockPyth", {
      from: deployer,
      args: [MAX_PRICE_AGE_SECONDS, 1],
      log: true,
      autoMine: true,
      gasPrice,
    });
    pythAddress = mock.address;
  }

  const checkout = await deploy("UsdCheckout", {
    from: deployer,
    args: [
      pythAddress,
      process.env.PYTH_HBAR_USD_PRICE_ID || HBAR_USD_PRICE_ID,
      MAX_PRICE_AGE_SECONDS,
      MAX_CONFIDENCE_BPS,
      isHedera ? HEDERA_NATIVE_DECIMALS : EVM_NATIVE_DECIMALS,
    ],
    log: true,
    autoMine: true,
    gasLimit: "3000000",
    gasPrice,
  });

  if (hre.network.name === "hederaTestnet") {
    console.log(`UsdCheckout on HashScan: https://hashscan.io/testnet/contract/${checkout.address}`);
  }
};

deployUsdCheckout.tags = ["UsdCheckout"];
export default deployUsdCheckout;
