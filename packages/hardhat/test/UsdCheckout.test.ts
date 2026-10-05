import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// HBAR/USD feed id used on Hedera (any 32-byte id works against MockPyth).
const PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";
const EXPO = -8;
const PRICE_10_CENTS = 10_000_000n; // $0.10 per HBAR at expo -8
const MAX_AGE = 60;
const MAX_CONF_BPS = 100; // 1%
const FEE = 7n; // MockPyth fee per update payload, in native units
const ONE_HBAR_18 = 10n ** 18n; // the local test chain uses 18 native decimals

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

async function deployFixture() {
  const [merchant, payer, other] = await ethers.getSigners();

  const pyth = await (await ethers.getContractFactory("MockPyth")).deploy(MAX_AGE, FEE);
  const checkout = await (
    await ethers.getContractFactory("UsdCheckout")
  ).deploy(await pyth.getAddress(), PRICE_ID, MAX_AGE, MAX_CONF_BPS, 18);

  /** Builds a MockPyth update payload published `ageSeconds` before the next block. */
  async function priceUpdate(price: bigint, conf = 1_000n, ageSeconds = 0) {
    const now = await time.latest();
    return pyth.createPriceFeedUpdateData(PRICE_ID, price, conf, EXPO, price, conf, now - ageSeconds, 0);
  }

  /** Creates a $10.00 invoice owned by `merchant`. */
  async function openInvoice(usdCents = 1000n, expiresAt = 0n) {
    await checkout.connect(merchant).createInvoice(usdCents, expiresAt, ethers.encodeBytes32String("order-1"));
    return checkout.invoiceCount();
  }

  return { merchant, payer, other, pyth, checkout, priceUpdate, openInvoice };
}

describe("UsdCheckout", () => {
  describe("deployment", () => {
    it("stores its configuration", async () => {
      const { checkout, pyth } = await loadFixture(deployFixture);
      expect(await checkout.PYTH()).to.equal(await pyth.getAddress());
      expect(await checkout.PRICE_ID()).to.equal(PRICE_ID);
      expect(await checkout.MAX_PRICE_AGE()).to.equal(MAX_AGE);
      expect(await checkout.MAX_CONFIDENCE_BPS()).to.equal(MAX_CONF_BPS);
      expect(await checkout.NATIVE_DECIMALS()).to.equal(18);
    });

    it("rejects invalid configuration", async () => {
      const { pyth } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("UsdCheckout");
      const pythAddress = await pyth.getAddress();
      // [pyth, priceId, maxPriceAge, maxConfidenceBps, nativeDecimals]
      const bad: [string, string, number, number, number][] = [
        [ethers.ZeroAddress, PRICE_ID, MAX_AGE, MAX_CONF_BPS, 8],
        [pythAddress, ethers.ZeroHash, MAX_AGE, MAX_CONF_BPS, 8],
        [pythAddress, PRICE_ID, 0, MAX_CONF_BPS, 8],
        [pythAddress, PRICE_ID, MAX_AGE, 0, 8],
        [pythAddress, PRICE_ID, MAX_AGE, 10_001, 8],
        [pythAddress, PRICE_ID, MAX_AGE, MAX_CONF_BPS, 0],
        [pythAddress, PRICE_ID, MAX_AGE, MAX_CONF_BPS, 19],
      ];
      for (const [pyth_, priceId, maxAge, maxConfBps, decimals] of bad) {
        await expect(factory.deploy(pyth_, priceId, maxAge, maxConfBps, decimals)).to.be.revertedWithCustomError(
          factory,
          "InvalidConfig",
        );
      }
    });
  });

  describe("createInvoice / cancelInvoice", () => {
    it("creates an invoice and emits InvoiceCreated", async () => {
      const { checkout, merchant } = await loadFixture(deployFixture);
      const ref = ethers.encodeBytes32String("order-1");
      await expect(checkout.connect(merchant).createInvoice(1000, 0, ref))
        .to.emit(checkout, "InvoiceCreated")
        .withArgs(1, merchant.address, 1000, 0, ref);

      const invoice = await checkout.invoices(1);
      expect(invoice.merchant).to.equal(merchant.address);
      expect(invoice.usdCents).to.equal(1000);
      expect(invoice.status).to.equal(1); // Open
      expect(await checkout.invoiceCount()).to.equal(1);
    });

    it("rejects a zero amount and an expiry in the past", async () => {
      const { checkout } = await loadFixture(deployFixture);
      await expect(checkout.createInvoice(0, 0, ethers.ZeroHash)).to.be.revertedWithCustomError(checkout, "ZeroAmount");
      const past = (await time.latest()) - 1;
      await expect(checkout.createInvoice(1000, past, ethers.ZeroHash)).to.be.revertedWithCustomError(
        checkout,
        "ExpiryInPast",
      );
    });

    it("lets only the merchant cancel an open invoice", async () => {
      const { checkout, merchant, other, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      await expect(checkout.connect(other).cancelInvoice(id)).to.be.revertedWithCustomError(checkout, "NotMerchant");
      await expect(checkout.connect(merchant).cancelInvoice(id)).to.emit(checkout, "InvoiceCancelled").withArgs(id);
      await expect(checkout.connect(merchant).cancelInvoice(id)).to.be.revertedWithCustomError(
        checkout,
        "InvoiceNotOpen",
      );
    });
  });

  describe("usdToNative", () => {
    it("converts $10.00 at $0.10/HBAR to 100 HBAR", async () => {
      const { checkout } = await loadFixture(deployFixture);
      expect(await checkout.usdToNative(1000, PRICE_10_CENTS, EXPO)).to.equal(100n * ONE_HBAR_18);
    });

    it("uses Hedera's 8 native decimals when deployed for Hedera", async () => {
      const { pyth } = await loadFixture(deployFixture);
      const hederaCheckout = await (
        await ethers.getContractFactory("UsdCheckout")
      ).deploy(await pyth.getAddress(), PRICE_ID, MAX_AGE, MAX_CONF_BPS, 8);
      // 100 HBAR expressed in tinybars
      expect(await hederaCheckout.usdToNative(1000, PRICE_10_CENTS, EXPO)).to.equal(100n * 10n ** 8n);
    });

    it("rounds up so the merchant is never underpaid", async () => {
      const { checkout } = await loadFixture(deployFixture);
      const price = 33_333_333n; // $0.33333333 per HBAR
      const exact = ceilDiv(1n * 10n ** 26n, 100n * price); // 1 cent, 18 decimals, expo -8
      expect(await checkout.usdToNative(1, price, EXPO)).to.equal(exact);
    });

    it("rejects non-positive prices and unsupported exponents", async () => {
      const { checkout } = await loadFixture(deployFixture);
      await expect(checkout.usdToNative(1000, 0, EXPO)).to.be.revertedWithCustomError(checkout, "PriceNotPositive");
      await expect(checkout.usdToNative(1000, 1, -19)).to.be.revertedWithCustomError(checkout, "UnsupportedExponent");
      await expect(checkout.usdToNative(1000, 1, 19)).to.be.revertedWithCustomError(checkout, "UnsupportedExponent");
    });

    it("handles non-negative exponents", async () => {
      const { checkout } = await loadFixture(deployFixture);
      // price 1 * 10^0 = $1 per HBAR -> $10.00 = 10 HBAR
      expect(await checkout.usdToNative(1000, 1, 0)).to.equal(10n * ONE_HBAR_18);
    });
  });

  describe("pay", () => {
    it("pays the merchant, refunds the excess and records the settlement", async () => {
      const { checkout, merchant, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const update = await priceUpdate(PRICE_10_CENTS);
      const required = 100n * ONE_HBAR_18;
      const buffer = ONE_HBAR_18; // overpay by 1 HBAR

      const merchantBefore = await ethers.provider.getBalance(merchant.address);
      const tx = await checkout.connect(payer).pay(id, [update], { value: required + FEE + buffer });
      await tx.wait();

      expect(await ethers.provider.getBalance(merchant.address)).to.equal(merchantBefore + required);
      expect(await ethers.provider.getBalance(await checkout.getAddress())).to.equal(0n);
      await expect(tx)
        .to.emit(checkout, "InvoicePaid")
        .withArgs(id, payer.address, merchant.address, required, PRICE_10_CENTS, EXPO);

      const payment = await checkout.payments(id);
      expect(payment.payer).to.equal(payer.address);
      expect(payment.nativePaid).to.equal(required);
      expect((await checkout.invoices(id)).status).to.equal(2); // Paid
    });

    it("refunds exactly the overpayment to the payer", async () => {
      const { checkout, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const update = await priceUpdate(PRICE_10_CENTS);
      const required = 100n * ONE_HBAR_18;
      const sent = required + FEE + 5n * ONE_HBAR_18;

      const before = await ethers.provider.getBalance(payer.address);
      const tx = await checkout.connect(payer).pay(id, [update], { value: sent });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(payer.address);

      expect(before - after - gasCost).to.equal(required + FEE);
    });

    it("works with an empty update when the on-chain price is still fresh", async () => {
      const { checkout, pyth, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      await pyth.updatePriceFeeds([await priceUpdate(PRICE_10_CENTS)], { value: FEE });

      await expect(checkout.connect(payer).pay(id, [], { value: 100n * ONE_HBAR_18 })).to.emit(checkout, "InvoicePaid");
    });

    it("reverts when the payment does not cover the converted amount", async () => {
      const { checkout, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const update = await priceUpdate(PRICE_10_CENTS);
      const required = 100n * ONE_HBAR_18;

      await expect(checkout.connect(payer).pay(id, [update], { value: required + FEE - 1n }))
        .to.be.revertedWithCustomError(checkout, "InsufficientPayment")
        .withArgs(required, required - 1n);
    });

    it("reverts when msg.value does not even cover the Pyth fee", async () => {
      const { checkout, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const update = await priceUpdate(PRICE_10_CENTS);
      await expect(checkout.connect(payer).pay(id, [update], { value: FEE - 1n }))
        .to.be.revertedWithCustomError(checkout, "InsufficientPayment")
        .withArgs(FEE, FEE - 1n);
    });

    it("reverts on a stale price", async () => {
      const { checkout, pyth, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const stale = await priceUpdate(PRICE_10_CENTS, 1_000n, MAX_AGE + 30);
      await expect(
        checkout.connect(payer).pay(id, [stale], { value: 200n * ONE_HBAR_18 }),
      ).to.be.revertedWithCustomError(pyth, "StalePrice");
    });

    it("reverts when the price confidence interval is too wide", async () => {
      const { checkout, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      // conf = 2% of price, limit is 1%
      const wide = await priceUpdate(PRICE_10_CENTS, PRICE_10_CENTS / 50n);
      await expect(
        checkout.connect(payer).pay(id, [wide], { value: 200n * ONE_HBAR_18 }),
      ).to.be.revertedWithCustomError(checkout, "PriceTooUncertain");
    });

    it("reverts on a non-positive price", async () => {
      const { checkout, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const bad = await priceUpdate(-5n);
      await expect(checkout.connect(payer).pay(id, [bad], { value: 200n * ONE_HBAR_18 })).to.be.revertedWithCustomError(
        checkout,
        "PriceNotPositive",
      );
    });

    it("reverts for an expired invoice", async () => {
      const { checkout, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const expiresAt = BigInt((await time.latest()) + 600);
      const id = await openInvoice(1000n, expiresAt);
      await time.increaseTo(expiresAt + 1n);
      const update = await priceUpdate(PRICE_10_CENTS);
      await expect(
        checkout.connect(payer).pay(id, [update], { value: 200n * ONE_HBAR_18 }),
      ).to.be.revertedWithCustomError(checkout, "InvoiceExpired");
    });

    it("cannot be paid twice, and cannot pay a cancelled or unknown invoice", async () => {
      const { checkout, merchant, payer, priceUpdate, openInvoice } = await loadFixture(deployFixture);
      const id = await openInvoice();
      const update = await priceUpdate(PRICE_10_CENTS);
      await checkout.connect(payer).pay(id, [update], { value: 101n * ONE_HBAR_18 });
      await expect(checkout.connect(payer).pay(id, [], { value: 101n * ONE_HBAR_18 })).to.be.revertedWithCustomError(
        checkout,
        "InvoiceNotOpen",
      );

      const second = await openInvoice();
      await checkout.connect(merchant).cancelInvoice(second);
      await expect(
        checkout.connect(payer).pay(second, [update], { value: 101n * ONE_HBAR_18 }),
      ).to.be.revertedWithCustomError(checkout, "InvoiceNotOpen");
      await expect(checkout.connect(payer).pay(999, [], { value: 1 })).to.be.revertedWithCustomError(
        checkout,
        "InvoiceNotOpen",
      );
    });

    it("rolls back the payment when the merchant rejects funds or tries to re-enter", async () => {
      const { checkout, payer, priceUpdate } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("HostileMerchant");
      const checkoutAddress = await checkout.getAddress();

      for (const reenter of [false, true]) {
        const hostile = await factory.deploy(checkoutAddress, reenter);
        await hostile.createInvoice(1000);
        const id = await checkout.invoiceCount();
        const update = await priceUpdate(PRICE_10_CENTS);
        await expect(
          checkout.connect(payer).pay(id, [update], { value: 101n * ONE_HBAR_18 }),
        ).to.be.revertedWithCustomError(checkout, "TransferFailed");
        expect((await checkout.invoices(id)).status).to.equal(1); // still Open
      }
    });
  });
});
