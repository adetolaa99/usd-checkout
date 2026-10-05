import { expect } from "chai";
import { ethers } from "hardhat";
import {
  formatUsd,
  isFeeReasonable,
  maxNativeToSend,
  nativeToRpcValue,
  parseUsdToCents,
} from "../../nextjs/utils/checkout";

const PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";
const EXPO = -8;
const TINYBAR_IN_WEI = 10n ** 10n; // the JSON-RPC relay turns 18-decimal wei into 8-decimal tinybars
const HEDERA_DECIMALS = 8;

describe("checkout page amount math", () => {
  describe("dollar parsing and formatting", () => {
    it("parses valid dollar strings to cents", () => {
      expect(parseUsdToCents("10")).to.equal(1000n);
      expect(parseUsdToCents("10.5")).to.equal(1050n);
      expect(parseUsdToCents(" 0.01 ")).to.equal(1n);
      expect(parseUsdToCents("123456.78")).to.equal(12345678n);
    });

    it("rejects zero, negative, malformed and over-precise input", () => {
      for (const input of ["", "0", "0.00", "-1", "abc", "1.234", "1,5", "1e3"]) {
        expect(parseUsdToCents(input), input).to.equal(null);
      }
    });

    it("formats cents as dollars", () => {
      expect(formatUsd(1050n)).to.equal("10.50");
      expect(formatUsd(5n)).to.equal("0.05");
      expect(formatUsd(100n)).to.equal("1.00");
    });
  });

  describe("sent value matches what the contract sees on Hedera", () => {
    for (const [cents, price] of [
      [1n, 9_386_000n], // $0.09386 per HBAR
      [999n, 33_333_333n],
      [1000n, 10_000_000n],
      [123_456n, 21_000_000n],
    ] as const) {
      it(`converts cleanly to tinybars for ${cents} cents at price ${price}`, async () => {
        const pyth = await (await ethers.getContractFactory("MockPyth")).deploy(60, 1);
        const checkout = await (
          await ethers.getContractFactory("UsdCheckout")
        ).deploy(await pyth.getAddress(), PRICE_ID, 60, 100, HEDERA_DECIMALS);

        const required = await checkout.usdToNative(cents, price, EXPO); // tinybars
        const fee = 1n; // tinybar
        const rpcValue = nativeToRpcValue(maxNativeToSend(required, fee), HEDERA_DECIMALS);

        // The relay can only deliver whole tinybars, so the value must be a multiple of 1e10 wei.
        expect(rpcValue % TINYBAR_IN_WEI).to.equal(0n);
        const delivered = rpcValue / TINYBAR_IN_WEI;
        expect(delivered).to.be.greaterThanOrEqual(required + fee);
        // The buffer stays within 1% of the quote (plus rounding), so payers are not over-charged.
        expect(delivered - required - fee).to.be.lessThanOrEqual(required / 100n + 1n);
      });
    }
  });

  describe("fee sanity check", () => {
    it("accepts tiny fees and rejects fees above 0.01 HBAR", () => {
      expect(isFeeReasonable(1n, HEDERA_DECIMALS)).to.equal(true);
      expect(isFeeReasonable(10n ** 6n, HEDERA_DECIMALS)).to.equal(true); // exactly 0.01 HBAR
      expect(isFeeReasonable(10n ** 6n + 1n, HEDERA_DECIMALS)).to.equal(false);
      expect(isFeeReasonable(10n ** 10n, HEDERA_DECIMALS)).to.equal(false); // fee misread as wei-scale
    });
  });
});
