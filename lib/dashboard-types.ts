export type DashboardPeriod = {
  label: string;
  startIso: string;
  endExclusiveIso: string;
  dateStart: string;
  dateEndExclusive: string;
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
};
