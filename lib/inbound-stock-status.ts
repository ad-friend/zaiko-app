/**
 * inbound_items.stock_status（返品検品待ちなど）
 * - null / available: 通常の引当・在庫数カウント対象
 * - return_inspection: Amazon 返品で解放した在庫。検品後に available へ戻す
 */
export const STOCK_STATUS_AVAILABLE = "available";
export const STOCK_STATUS_RETURN_INSPECTION = "return_inspection";

/**
 * PostgREST `.or()` 用: 引当対象の在庫のみ（検品待ちを除外）
 */
export const INBOUND_FILTER_SALABLE_FOR_ALLOCATION = "stock_status.is.null,stock_status.eq.available";
