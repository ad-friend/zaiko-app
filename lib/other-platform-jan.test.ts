import assert from "node:assert/strict";
import {
  extractJanDigits,
  normalizeOtherPlatformJan,
  otherPlatformJanLookupVariants,
} from "./other-platform-jan";

assert.equal(extractJanDigits(" 649528918994 "), "649528918994");
assert.equal(normalizeOtherPlatformJan("649528918994"), "0649528918994");
assert.equal(normalizeOtherPlatformJan("0649528918994"), "0649528918994");
assert.equal(normalizeOtherPlatformJan("4901234567890"), "4901234567890");
assert.equal(normalizeOtherPlatformJan(""), null);
assert.equal(normalizeOtherPlatformJan("12345"), null);

assert.deepEqual(otherPlatformJanLookupVariants("649528918994"), [
  "0649528918994",
  "649528918994",
]);
assert.deepEqual(otherPlatformJanLookupVariants("0649528918994"), [
  "0649528918994",
  "649528918994",
]);

console.log("other-platform-jan: all tests passed");
