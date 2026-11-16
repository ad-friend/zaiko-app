export type TrafficDaily = {
  date: string; sessions: number; page_views: number; buy_box_percentage: number;
  unit_session_percentage: number; ordered_product_sales: number; total_order_items: number;
  units_ordered: number; source_report_id?: string | null;
};
export type AsinTotal = { asin: string; window_start: string; window_end: string; units_ordered: number; ordered_sales: number };
export type TrendDaily = { date: string; keyword: string; trend_value: number };
export type SaleEventInput = { label: string; start_date: string; end_date: string; note: string | null };
export type SaleEvent = SaleEventInput & { id: number };
export type InboundRecord = { asin: string | null; registered_at: string | null; order_id: string | null; settled_at: string | null; exit_at: string | null; return_amazon_order_id: string | null };
export type OrderRecord = { amazon_order_id: string; created_at: string | null };
export type AnalysisDay = { date: string; salesTotal: number | null; orderCount: number | null; sessions: number | null; buyBoxPercentage: number | null; trendValue: number | null; topStockoutCount: number | null; saleEvents: string[] };
export type SalesAnalysis = {
  timezone: "Asia/Tokyo"; requestedStart: string; requestedEnd: string; latestAvailableDate: string | null;
  topAsinWindow: { start: string | null; end: string | null; trackedCount: number; totalCount: number };
  days: AnalysisDay[];
};
export type WeekMetrics = { label: string; rangeStart: string; rangeEnd: string; presentWeekdays: string[]; salesTotal: number | null; orderCount: number | null; buyBoxPercentage: number | null; topStockoutAvg: number | null; trackedAsinCount: number };
export type WeeklySummary = {
  thisWeek: WeekMetrics; lastWeek: WeekMetrics; comparable: boolean; dataAsOf: string | null; note: string;
  delta: { salesTotal: number | null; orderCount: number | null; buyBoxPercentagePoint: number | null; topStockoutAvg: number | null };
  deltaPercent: { salesTotal: number | null; orderCount: number | null };
};
