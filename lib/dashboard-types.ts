export type DashboardPeriod = {
  label: string;
  startIso: string;
  endExclusiveIso: string;
  dateStart: string;
  dateEndExclusive: string;
};

/** GET /api/dashboard が返すお知らせ1件（未確認のみ） */
export type DashboardNoticeRow = {
  id: string;
  notice_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type DashboardPayload = {
  period: DashboardPeriod;
  inventory: { count: number; totalAmount: number };
  monthlyPurchase: { count: number; totalAmount: number };
  monthlyLoss: { count: number; totalAmount: number };
  monthlySettled: {
    soldCount: number;
    costOfGoodsSold: number;
    revenue: number;
    feesAndAdjustments: number;
    profit: number;
  };
  notices: DashboardNoticeRow[];
};

export type MonthlyDashboardRow = {
  period: DashboardPeriod;
  salesTotal: number;
  consumptionTax: number;
  monthlyPurchase: { count: number; totalAmount: number };
  inventoryAtMonthEnd: { count: number; totalAmount: number };
  soldCount: number;
  netDeposit: number;
  costOfGoodsSold: number;
  monthlyLoss: { count: number; totalAmount: number };
  profit: number;
};

export type MonthlyDashboardPayload = {
  from: string;
  to: string;
  rows: MonthlyDashboardRow[];
};

/** 棚卸時点レポートの明細1行 */
export type InventoryAsOfRow = {
  id: number;
  order_id: string;
  order_date: string | null;
  settled_at: string | null;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  asin: string | null;
  effective_unit_price: number;
};

/** GET /api/dashboard/inventory-as-of */
export type InventoryAsOfPayload = {
  asOfDate: string;
  asOfIso: string;
  label: string;
  /** 販売中 + 引当済（決済待ち）※注文日不明の引当も含む */
  unsettled: { count: number; totalAmount: number };
  /** 注文日 < 基準 かつ 決済日なし or 決済日 >= 基準 */
  allocatedPending: { count: number; totalAmount: number };
  /** 未決済から引当済・注文日不明を除いた販売中相当 */
  onSale: { count: number };
  /** order_id はあるが注文日が取れない件数 */
  allocatedOrderDateUnknown: number;
  allocatedRows: InventoryAsOfRow[];
  unknownOrderDateRows: InventoryAsOfRow[];
};
