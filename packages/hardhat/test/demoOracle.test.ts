import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DEMO_PRICE_EXPO,
  HEDERA_PYTH_ADDRESS,
  buildDemoQuote,
  buildDemoUpdate,
  isDemoOracle,
  parseDemoPrice,
} from "../../nextjs/utils/demoOracle";
import { maxNativeToSend, nativeToRpcValue } from "../../nextjs/utils/checkout";

const PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";
const DEMO_MAX_AGE = 600; // keep in sync with deploy/00_deploy_usd_checkout.ts
const HEDERA_DECIMALS = 8;

async function chainTime(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return Number(block!.timestamp);
}

async function deployDemo(maxAge = DEMO_MAX_AGE) {
  const pyth = await (await ethers.getContractFactory("MockPyth")).deploy(maxAge, 1);
  const checkout = await (
    await ethers.getContractFactory("UsdCheckout")
  ).deploy(await pyth.getAddress(), PRICE_ID, maxAge, 100, HEDERA_DECIMALS);
  return { pyth, checkout };
}

describe("Demo oracle mode", () => {
  describe("helpers", () => {
    it("tells the real Pyth contract apart from a mock, ignoring address case", () => {
      expect(isDemoOracle(HEDERA_PYTH_ADDRESS)).to.equal(false);
      expect(isDemoOracle(HEDERA_PYTH_ADDRESS.toLowerCase())).to.equal(false);
      expect(isDemoOracle("0x5FbDB2315678afecb367f032d93F642f64180aa3")).to.equal(true);
    });

    it("parses demo prices into Pyth units at exponent -8", () => {
      expect(DEMO_PRICE_EXPO).to.equal(-8);
      expect(parseDemoPrice("0.10")).to.equal(10_000_000n);
      expect(parseDemoPrice(" 0.1 ")).to.equal(10_000_000n);
      expect(parseDemoPrice("1")).to.equal(100_000_000n);
      expect(parseDemoPrice("0.09386")).to.equal(9_386_000n);
      expect(parseDemoPrice("0.00000001")).to.equal(1n);
      expect(parseDemoPrice("999999.99999999")).to.equal(99_999_999_999_999n);
    });

    it("rejects zero, negative, malformed and over-precise demo prices", () => {
      for (const input of [
        "",
        "0",
        "0.0",
        "0.00000000",
        "-1",
        "abc",
        "1.123456789",
        "1,5",
        "1e3",
        ".5",
        "1.",
        "1234567",
      ]) {
        expect(parseDemoPrice(input), input).to.equal(null);
      }
    });

    it("builds the same payload as MockPyth.createPriceFeedUpdateData", async () => {
      const { pyth } = await deployDemo();
      const publishTime = 1_900_000_000;
      const expected = await pyth.createPriceFeedUpdateData(
        PRICE_ID,
        9_386_000n,
        0n,
        DEMO_PRICE_EXPO,
        9_386_000n,
        0n,
        publishTime,
        0n,
      );
      expect(buildDemoUpdate(PRICE_ID, 9_386_000n, publishTime)).to.equal(expected);
    });

    it("returns a quote in the same shape as the Hermes flow", () => {
      const quote = buildDemoQuote(PRICE_ID, 10_000_000n, 1_900_000_000);
      expect(quote.updateData).to.have.length(1);
      expect(quote.price).to.equal(10_000_000n);
      expect(quote.expo).to.equal(-8);
      expect(quote.publishTime).to.equal(1_900_000_000);
    });
  });

  describe("paying through the mock oracle", () => {
    it("pays the merchant at the typed-in price and refunds the buffer, as the page would send it", async () => {
      const { checkout } = await deployDemo();
      const [merchant, payer] = await ethers.getSigners();

      await checkout.connect(merchant).createInvoice(1000n, 0, ethers.ZeroHash); // $10.00
      const quote = buildDemoQuote(PRICE_ID, parseDemoPrice("0.10")!, await chainTime());

      const fee = await checkout.updateFee(quote.updateData);
      const required = await checkout.usdToNative(1000n, quote.price, quote.expo);
      expect(fee).to.equal(1n);
      expect(required).to.equal(100n * 10n ** 8n); // $10 at $0.10 per HBAR = 100 HBAR in tinybars

      // The page sends the 18-decimal value; on the test chain the contract reads it as native units,
      // so convert the page's value back to what the contract sees on Hedera (divide by 10^10).
      const rpcValue = nativeToRpcValue(maxNativeToSend(required, fee), HEDERA_DECIMALS);
      const value = rpcValue / 10n ** 10n;

      const merchantBefore = await ethers.provider.getBalance(merchant.address);
      const payerBefore = await ethers.provider.getBalance(payer.address);
      const tx = await checkout.connect(payer).pay(1, quote.updateData, { value });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;

      expect(await ethers.provider.getBalance(merchant.address)).to.equal(merchantBefore + required);
      expect(await ethers.provider.getBalance(payer.address)).to.equal(payerBefore - required - fee - gas);

      const payment = await checkout.payments(1);
      expect(payment.nativePaid).to.equal(required);
      expect(payment.price).to.equal(quote.price);
    });

    it("accepts a quote built five minutes ago on a demo deployment, because wallet approval is slow", async () => {
      const { checkout } = await deployDemo();
      await checkout.createInvoice(100n, 0, ethers.ZeroHash);
      const quote = buildDemoQuote(PRICE_ID, 10_000_000n, (await chainTime()) - 300);
      const fee = await checkout.updateFee(quote.updateData);
      const required = await checkout.usdToNative(100n, quote.price, quote.expo);
      await expect(checkout.pay(1, quote.updateData, { value: required + fee })).to.emit(checkout, "InvoicePaid");
    });

    it("still rejects a quote older than the deployment's maximum age", async () => {
      const { checkout } = await deployDemo();
      await checkout.createInvoice(100n, 0, ethers.ZeroHash);
      const quote = buildDemoQuote(PRICE_ID, 10_000_000n, (await chainTime()) - DEMO_MAX_AGE - 30);
      const fee = await checkout.updateFee(quote.updateData);
      const required = await checkout.usdToNative(100n, quote.price, quote.expo);
      await expect(checkout.pay(1, quote.updateData, { value: required + fee })).to.be.reverted;
    });
  });
});
