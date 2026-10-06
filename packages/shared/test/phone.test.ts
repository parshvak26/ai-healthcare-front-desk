import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDemoPhone } from "../src/index.ts";

describe("demo call phone numbers", () => {
  it("accepts US numbers in common formats", () => {
    for (const input of ["+1 (512) 555-0100", "+1 512-555-0100", "+15125550100", "001 512 555 0100"]) {
      assert.deepEqual(normalizeDemoPhone(input), { e164: "+15125550100", country: "US", display: "+1 (512) 555-0100" }, input);
    }
  });

  it("accepts Indian mobiles with +91", () => {
    assert.deepEqual(normalizeDemoPhone("+91 98765 43210"), { e164: "+919876543210", country: "IN", display: "+91 98765 43210" });
  });

  it("never guesses the country, so an Indian mobile cannot be dialled as a US number", () => {
    for (const input of ["9045551234", "9876543210", "5125550100", "15125550100", "919876543210"]) assert.equal(normalizeDemoPhone(input), null, input);
  });

  it("rejects other countries, landline-style Indian numbers, and junk", () => {
    for (const input of ["+442071838750", "+91 22 1234 5678", "+1 (012) 555-0100", "call me", "", "+1512555010000"]) {
      assert.equal(normalizeDemoPhone(input), null, input);
    }
  });
});
