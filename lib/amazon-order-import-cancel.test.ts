import assert from "node:assert/strict";
import { classifyAmazonOrderImportCancel } from "./amazon-order-import-cancel";

assert.equal(
  classifyAmazonOrderImportCancel({ orderStatus: "Cancelled", itemStatus: "Cancelled" }),
  "order"
);

assert.equal(
  classifyAmazonOrderImportCancel({ orderStatus: "Shipped", itemStatus: "Cancelled", quantity: 0 }),
  "item"
);

assert.equal(
  classifyAmazonOrderImportCancel({ "order-status": "Shipped", "item-status": "Shipped", quantity: 1 }),
  "none"
);

assert.equal(
  classifyAmazonOrderImportCancel({ order_status: "キャンセル", item_status: "キャンセル" }),
  "order"
);

assert.equal(classifyAmazonOrderImportCancel({ itemStatus: "Canceled" }), "item");

console.log("amazon-order-import-cancel: all tests passed");
