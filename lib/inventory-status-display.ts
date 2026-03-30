/**
 * 在庫一覧の「進捗」バッジ: DB の真実に合わせた厳密な表示優先順位
 * 1. exit_type または stock_status=disposed → イレギュラー/廃棄（グレー）
 * 2. stock_status=return_inspection → 返品・検品待ち（オレンジ）
 * 3. order_id あり + settled_at あり → 販売済（決済完了）（ブルー）
 * 4. order_id あり + settled_at なし → 引当済（決済待ち）（赤系）
 * 5. それ以外 → 販売中（緑系）
 */
import { STOCK_STATUS_DISPOSED, STOCK_STATUS_RETURN_INSPECTION } from "@/lib/inbound-stock-status";

export type InventoryRowForStatus = {
  order_id?: string | null;
  settled_at?: string | null;
  exit_type?: string | null;
  stock_status?: string | null;
};

function nonempty(s: string | null | undefined): boolean {
  return s != null && String(s).trim().length > 0;
}

/** exit_type 値 → 画面ラベル（レガシー damaged 等と新スキーマを両対応） */
export function exitTypeToDisplayLabel(exitType: string | null | undefined): string {
  const key = String(exitType ?? "").trim().toLowerCase();
  switch (key) {
    case "internal_damage":
    case "damaged":
      return "破損";
    case "loss":
    case "lost":
      return "紛失";
    case "internal_use":
      return "社内使用";
    case "promo_entertainment":
      return "販促";
    case "entertainment":
      return "接待";
    case "junk_return":
      return "ジャンク廃棄";
    default:
      if (!key) return "イレギュラー除外";
      return String(exitType).trim();
  }
}

export type InventoryStatusDisplay = {
  label: string;
  /** Tailwind クラス（バッジ本体） */
  badgeClassName: string;
};

/**
 * 在庫1行分の表示用ステータス（ラベル + バッジ色）
 */
export function getInventoryStatusDisplay(row: InventoryRowForStatus): InventoryStatusDisplay {
  const hasExit = nonempty(row.exit_type);
  const stock = String(row.stock_status ?? "").trim().toLowerCase();

  if (hasExit || stock === STOCK_STATUS_DISPOSED) {
    const label = hasExit ? exitTypeToDisplayLabel(row.exit_type) : "廃棄済";
    return {
      label,
      badgeClassName: "bg-slate-200/90 text-slate-700 ring-1 ring-slate-300/60",
    };
  }

  if (stock === STOCK_STATUS_RETURN_INSPECTION) {
    return {
      label: "返品・検品待ち",
      badgeClassName: "bg-orange-100 text-orange-900 ring-1 ring-orange-200/80",
    };
  }

  const hasOrder = nonempty(row.order_id);
  const hasSettled = nonempty(row.settled_at);

  if (hasOrder && hasSettled) {
    return {
      label: "販売済（決済完了）",
      badgeClassName: "bg-sky-100 text-sky-900 ring-1 ring-sky-200/70",
    };
  }

  if (hasOrder && !hasSettled) {
    return {
      label: "引当済（決済待ち）",
      badgeClassName: "bg-rose-100 text-rose-900 ring-1 ring-rose-200/70",
    };
  }

  return {
    label: "販売中",
    badgeClassName: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200/60",
  };
}

/** CSV 等で「在庫ステータス」列に使う短文 */
export function getInventoryStatusLabel(row: InventoryRowForStatus): string {
  return getInventoryStatusDisplay(row).label;
}
