import assert from "node:assert/strict";
import { siblingIdsToDelete } from "./amazon-order-import-existing";
import {
  applyCollapsedSkuReconciliationStatus,
  isStockAndSalesAlreadyFinished,
  linkedRootsCoverOrder,
  orderQuantityNeedingStock,
  preferredPreservedStatus,
  requiredSettledRootCount,
} from "./amazon-order-reconciliation-status";

assert.equal(preferredPreservedStatus(["pending", "reconciled", "manual_required"]), "reconciled");
assert.equal(preferredPreservedStatus(["manual_required", "canceled"]), "canceled");
assert.equal(preferredPreservedStatus(["pending", ""]), null);

const rows = [
  { amazon_order_id: "A", sku: "S", line_index: 0, reconciliation_status: "pending" },
  { amazon_order_id: "B", sku: "S", line_index: 0, reconciliation_status: "pending" },
];
applyCollapsedSkuReconciliationStatus(rows, [
  { amazon_order_id: "A", sku: "S", reconciliation_status: "pending" },
  { amazon_order_id: "A", sku: "S", reconciliation_status: "reconciled" },
]);
assert.equal(rows[0].reconciliation_status, "reconciled");
assert.equal(rows[1].reconciliation_status, "pending");

const drop = siblingIdsToDelete(
  [
    { id: 1, amazon_order_id: "A", sku: "S", line_index: 0 },
    { id: 2, amazon_order_id: "A", sku: "S", line_index: 1 },
    { id: 3, amazon_order_id: "B", sku: "S", line_index: 1 },
  ],
  [{ amazon_order_id: "A", sku: "S", line_index: 0 }]
);
assert.deepEqual(drop, [2]);

assert.equal(
  requiredSettledRootCount(
    [{ sku: "S", quantity: 1, reconciliation_status: "manual_required" }],
    [{ sku: "S", quantity: 1 }]
  ),
  1
);
assert.equal(
  requiredSettledRootCount(
    [{ sku: "SET", quantity: 1, reconciliation_status: "manual_required" }],
    [
      { sku: "SET", quantity: 1 },
      { sku: "SET", quantity: 2 },
    ]
  ),
  3
);
assert.equal(isStockAndSalesAlreadyFinished(1, 1, ["reconciled", "reconciled"]), true);
assert.equal(isStockAndSalesAlreadyFinished(1, 1, []), false);
assert.equal(isStockAndSalesAlreadyFinished(0, 1, ["reconciled"]), false);
assert.equal(
  orderQuantityNeedingStock([
    { quantity: 1, reconciliation_status: "manual_required" },
    { quantity: 2, reconciliation_status: "canceled" },
  ]),
  1
);
assert.equal(linkedRootsCoverOrder(1, 1), true);
assert.equal(linkedRootsCoverOrder(0, 1), false);

console.log("amazon-order-import-existing: all tests passed");
