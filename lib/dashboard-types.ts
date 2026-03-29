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
