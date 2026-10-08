import { expect } from "chai";
import {
  DEFAULT_HERMES_URL,
  cleanErrorDetail,
  hermesBaseUrl,
  hermesErrorMessage,
  hermesHeaders,
  hermesLatestUrl,
  isPriceId,
} from "../../nextjs/utils/hermes";

const PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";

describe("Hermes request helpers", () => {
  it("sends the API key as a Bearer header, and no Authorization header without a key", () => {
    expect(hermesHeaders("secret-key").Authorization).to.equal("Bearer secret-key");
    expect(hermesHeaders("  secret-key \n").Authorization).to.equal("Bearer secret-key");
    expect(hermesHeaders(undefined)).to.not.have.property("Authorization");
    expect(hermesHeaders("   ")).to.not.have.property("Authorization");
  });

  it("uses HERMES_URL when set, else the default, without a trailing slash", () => {
    expect(hermesBaseUrl({})).to.equal(DEFAULT_HERMES_URL);
    expect(hermesBaseUrl({ HERMES_URL: "" })).to.equal(DEFAULT_HERMES_URL);
    expect(hermesBaseUrl({ HERMES_URL: "https://example.test/hermes///" })).to.equal("https://example.test/hermes");
  });

  it("builds the latest-update URL for one feed", () => {
    expect(hermesLatestUrl("https://example.test/hermes", PRICE_ID)).to.equal(
      `https://example.test/hermes/v2/updates/price/latest?ids%5B%5D=${PRICE_ID}&encoding=hex&parsed=true`,
    );
  });

  it("accepts only 0x-prefixed 32-byte hex feed ids", () => {
    expect(isPriceId(PRICE_ID)).to.equal(true);
    expect(isPriceId(PRICE_ID.slice(2))).to.equal(false);
    expect(isPriceId(`${PRICE_ID}00`)).to.equal(false);
    expect(isPriceId("0x1234")).to.equal(false);
    expect(isPriceId(`${PRICE_ID.slice(0, 65)}z`)).to.equal(false);
    expect(isPriceId("")).to.equal(false);
  });

  it("explains missing keys, rejected keys, rate limits and other failures", () => {
    expect(hermesErrorMessage(401, false)).to.contain("Set HERMES_API_KEY");
    expect(hermesErrorMessage(401, true)).to.contain("rejected the API key");
    expect(hermesErrorMessage(403, false)).to.contain("HTTP 403");
    expect(hermesErrorMessage(429, true)).to.contain("rate limiting");
    expect(hermesErrorMessage(500, true)).to.equal("Hermes request failed (HTTP 500).");

    // Hermes' own explanation is passed through, shortened, and never contains the key.
    expect(hermesErrorMessage(403, true, "Not entitled: feed X")).to.contain("Hermes said: Not entitled: feed X");
    expect(cleanErrorDetail("bad key secret-key\n\tfor you", "secret-key")).to.equal("bad key [redacted] for you");
    expect(cleanErrorDetail("x".repeat(400))).to.have.length(303);
  });
});
