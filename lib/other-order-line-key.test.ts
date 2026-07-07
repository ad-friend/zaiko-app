import assert from "node:assert/strict";
import { otherOrderLineKey } from "./other-order-line-key";

const base = { order_id: "ORD-001", platform: "ラクマ" };

assert.notEqual(
  otherOrderLineKey({ ...base, sku: "SKU-A", jan_code: null }),
  otherOrderLineKey({ ...base, sku: "SKU-B", jan_code: null })
);

assert.notEqual(
  otherOrderLineKey({ ...base, sku: "", jan_code: "649528918994" }),
  otherOrderLineKey({ ...base, sku: "", jan_code: "4901234567890" })
);

assert.equal(
  otherOrderLineKey({ ...base, sku: "", jan_code: "649528918994" }),
  otherOrderLineKey({ ...base, sku: "", jan_code: "0649528918994" })
);

assert.equal(
  otherOrderLineKey({ ...base, sku: "SKU-A", jan_code: "4901234567890" }),
  otherOrderLineKey({ ...base, sku: "SKU-A", jan_code: "9999999999999" })
);

console.log("other-order-line-key: all tests passed");
