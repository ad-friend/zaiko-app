/**
 * inbound_items.stock_status（返品検品待ちなど）
 * - null / available: 通常の引当・在庫数カウント対象
 * - return_inspection: Amazon 返品で解放した在庫。検品後に available へ戻す
 * - disposed: 返品ジャンク等で販売不可（廃棄扱い）
 */
export const STOCK_STATUS_AVAILABLE = "available";
export const STOCK_STATUS_RETURN_INSPECTION = "return_inspection";
export const STOCK_STATUS_DISPOSED = "disposed";

/** 返品検品でジャンク廃棄したときの exit_type */
export const EXIT_TYPE_JUNK_RETURN = "junk_return";

/** ダッシュボード「クイック在庫調整」などの社内イレギュラー除外理由（inbound_items.exit_type） */
export const EXIT_TYPE_INTERNAL_DAMAGE = "internal_damage";
export const EXIT_TYPE_LOSS = "loss";
export const EXIT_TYPE_INTERNAL_USE = "internal_use";
export const EXIT_TYPE_PROMO_ENTERTAINMENT = "promo_entertainment";

export const QUICK_ADJUST_EXIT_TYPES = [
  EXIT_TYPE_INTERNAL_DAMAGE,
  EXIT_TYPE_LOSS,
  EXIT_TYPE_INTERNAL_USE,
  EXIT_TYPE_PROMO_ENTERTAINMENT,
] as const;

export type QuickAdjustExitType = (typeof QUICK_ADJUST_EXIT_TYPES)[number];

/**
 * PostgREST `.or()` 用: 引当対象の在庫のみ（検品待ち・廃棄を除外）
 */
export const INBOUND_FILTER_SALABLE_FOR_ALLOCATION = "stock_status.is.null,stock_status.eq.available";
