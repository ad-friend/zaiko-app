import assert from "node:assert/strict";
import { amazonOrderItemQuantity } from "./amazon-order-item-quantity";

assert.equal(amazonOrderItemQuantity(0), null);
assert.equal(amazonOrderItemQuantity("0"), null);
assert.equal(amazonOrderItemQuantity(-1), null);
assert.equal(amazonOrderItemQuantity(1), 1);
assert.equal(amazonOrderItemQuantity(2), 2);
assert.equal(amazonOrderItemQuantity(undefined), 1);
assert.equal(amazonOrderItemQuantity(null), 1);
assert.equal(amazonOrderItemQuantity(""), 1);
assert.equal(amazonOrderItemQuantity("x"), 1);

console.log("amazon-order-item-quantity: all tests passed");
