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

/** 棚卸時点レポートの商品（JAN）集計1行 */
export type InventoryAsOfProductRow = {
  jan_code: string;
  brand: string | null;
  product_name: string | null;
  model_number: string | null;
  /** 現在在庫数（販売中＋未決済）＝販売中＋引当済 */
  currentCount: number;
  /** 未決済在庫＝引当済（決済待ち） */
  pendingCount: number;
  /** 実在庫＝ currentCount − pendingCount */
  physicalCount: number;
};

/** GET /api/dashboard/inventory-as-of */
export type InventoryAsOfPayload = {
  asOfDate: string;
  /** 翌 0:00 JST の exclusive 境界（指定日 23:59:59 時点の比較用） */
  asOfIso: string;
  label: string;
  /** 販売中 + 引当済（決済待ち） */
  unsettled: { count: number; totalAmount: number };
  /** order_id あり（決済日が基準以降または未設定） */
  allocatedPending: { count: number; totalAmount: number };
  /** 未決済から引当済を除いた販売中 */
  onSale: { count: number };
  productRows: InventoryAsOfProductRow[];
};
