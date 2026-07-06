/**
 * 他販路 統合CSV → other_orders 行 + sales_transactions upsert 行
 */
import { createHash } from "crypto";
import { parseFlexiblePostedDateToIso } from "@/lib/settlement-posted-date";
import { attachSalesTransactionIdempotency } from "@/lib/sales-transaction-idempotency";
import { normalizeOtherPlatformJan } from "@/lib/other-platform-jan";

export type OtherPlatformSalesUpsertRow = {
  amazon_order_id: string;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  amazon_event_hash: string;
  item_quantity: number;
  finance_line_group_id: string | null;
  needs_quantity_review: boolean;
  dedupe_slot: number;
  idempotency_key: string;
};

export type OtherPlatformOrderRow = {
  order_id: string;
  platform: string;
  sku: string;
  quantity: number;
  condition_id: string;
  jan_code: string | null;
  sell_price: number;
  order_date: string | null;
  posted_date: string | null;
  reconciliation_status: string;
  status: string;
};

type AmountKind = "Principal" | "Tax" | "Shipping" | "Commission" | "Other";

const CORE_HEADERS: Record<string, string[]> = {
  orderId: ["注文番号", "orderid", "order_id"],
  platform: ["プラットフォーム", "platform"],
  sku: ["sku", "SKU"],
  quantity: ["数量", "quantity", "qty"],
  condition: ["コンディション", "condition", "condition_id"],
  orderDate: ["注文日", "orderdate", "order_date"],
  postedDate: ["決済日", "posteddate", "posted_date", "入金日"],
  jan: ["jan", "JAN", "jan_code"],
};

const AMOUNT_HEADERS: Record<AmountKind, string[]> = {
  Principal: ["商品売上", "売上", "販売価格", "principal", "商品の売上"],
  Tax: ["消費税", "税", "tax", "商品の売上税"],
  Shipping: ["送料", "shipping", "配送料"],
  Commission: ["プラットフォーム手数料", "手数料", "commission", "システム手数料"],
  Other: ["その他手数料", "other", "決済手数料"],
};

const CONDITION_ALIASES: Record<string, string> = {
  新品: "New",
  new: "New",
  中古: "Used",
  used: "Used",
};

function normalizeHeader(s: string): string {
  return s.replace(/\s/g, "").toLowerCase();
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function parseMoneyToNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => normalizeHeader(h));
  for (const c of candidates) {
    const i = norm.indexOf(normalizeHeader(c));
    if (i >= 0) return i;
  }
  return -1;
}

function logicalToAmountTypes(kind: AmountKind): { amount_type: "Charge" | "Fee"; amount_description: string } {
  switch (kind) {
    case "Principal":
      return { amount_type: "Charge", amount_description: "Principal" };
    case "Tax":
      return { amount_type: "Charge", amount_description: "Tax" };
    case "Shipping":
      return { amount_type: "Charge", amount_description: "Shipping" };
    case "Commission":
      return { amount_type: "Fee", amount_description: "Commission" };
    case "Other":
    default:
      return { amount_type: "Fee", amount_description: "Other" };
  }
}

function buildEventHash(payload: {
  orderId: string;
  platform: string;
  kind: AmountKind;
  amount: number;
}): string {
  const raw = [payload.orderId, payload.platform, payload.kind, String(payload.amount), "OtherPlatformV1"].join("_");
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeCondition(raw: string): string {
  const t = raw.trim();
  if (!t) return "New";
  const key = Object.keys(CONDITION_ALIASES).find((k) => k.toLowerCase() === t.toLowerCase()) ?? t;
  return CONDITION_ALIASES[key] ?? t;
}

export type ParseOtherPlatformCsvResult = {
  orders: OtherPlatformOrderRow[];
  salesRows: OtherPlatformSalesUpsertRow[];
  rowErrors: string[];
};

export function parseOtherPlatformCsv(csvText: string): ParseOtherPlatformCsvResult {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    throw new Error("CSVにデータ行がありません。");
  }

  const header = parseCsvLine(lines[0]);
  const idx = (key: keyof typeof CORE_HEADERS) => findHeaderIndex(header, CORE_HEADERS[key]);
  const amountIdx: Partial<Record<AmountKind, number>> = {};
  for (const kind of Object.keys(AMOUNT_HEADERS) as AmountKind[]) {
    const i = findHeaderIndex(header, AMOUNT_HEADERS[kind]);
    if (i >= 0) amountIdx[kind] = i;
  }

  const iOrder = idx("orderId");
  const iPlatform = idx("platform");
  const iSku = idx("sku");
  const iQty = idx("quantity");
  const iCond = idx("condition");
  const iOrderDate = idx("orderDate");
  const iPosted = idx("postedDate");
  const iJan = idx("jan");

  if (iOrder < 0 || iPlatform < 0) {
    throw new Error("ヘッダーが不正です。注文番号・プラットフォーム列が必要です。");
  }
  if (iPosted < 0 && iOrderDate < 0) {
    throw new Error("ヘッダーに「決済日」または「注文日」列が必要です。");
  }
  const hasAmountColumn = (Object.keys(AMOUNT_HEADERS) as AmountKind[]).some((k) => amountIdx[k] != null);
  if (!hasAmountColumn) {
    throw new Error("金額列がありません。「商品売上」または「販売価格」列を追加してください。");
  }

  const orders: OtherPlatformOrderRow[] = [];
  const salesRows: OtherPlatformSalesUpsertRow[] = [];
  const rowErrors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const orderId = (cols[iOrder] ?? "").trim();
    const platform = (cols[iPlatform] ?? "").trim();
    const sku = iSku >= 0 ? (cols[iSku] ?? "").trim() : "";
    const jan_code = iJan >= 0 ? normalizeOtherPlatformJan((cols[iJan] ?? "").trim()) : null;

    if (!orderId || !platform) continue;
    if (!sku && !jan_code) {
      rowErrors.push(`行 ${i + 1}: SKU または JAN のどちらかが必要です`);
      continue;
    }

    const orderDateRaw = iOrderDate >= 0 ? (cols[iOrderDate] ?? "").trim() : "";
    const postedRaw = iPosted >= 0 ? (cols[iPosted] ?? "").trim() : "";
    const saleDateRaw = postedRaw || orderDateRaw;
    if (!saleDateRaw) {
      rowErrors.push(`行 ${i + 1}: 決済日/注文日が空です`);
      continue;
    }

    const postedIso = parseFlexiblePostedDateToIso(saleDateRaw);
    if (!postedIso) {
      rowErrors.push(`行 ${i + 1}: 日付を解釈できません (${saleDateRaw})`);
      continue;
    }

    const orderDateIso = orderDateRaw ? parseFlexiblePostedDateToIso(orderDateRaw) : null;
    const qtyRaw = iQty >= 0 ? parseMoneyToNumber((cols[iQty] ?? "").trim()) : null;
    const quantity = qtyRaw != null && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;
    const condition_id = iCond >= 0 ? normalizeCondition(cols[iCond] ?? "") : "New";

    let principalAmount = 0;
    let hasAnyAmount = false;

    for (const kind of Object.keys(AMOUNT_HEADERS) as AmountKind[]) {
      const col = amountIdx[kind];
      if (col == null) continue;
      const raw = (cols[col] ?? "").trim();
      if (!raw) continue;
      const amount = parseMoneyToNumber(raw);
      if (amount == null || amount === 0) continue;

      hasAnyAmount = true;
      if (kind === "Principal") principalAmount = amount;

      let signed = amount;
      const { amount_type, amount_description } = logicalToAmountTypes(kind);
      if (amount_type === "Fee" && signed > 0) signed = -signed;

      const base = {
        amazon_order_id: orderId,
        sku: sku || null,
        transaction_type: "Order",
        amount_type,
        amount_description,
        amount: Math.round(signed * 100) / 100,
        posted_date: postedIso,
        amazon_event_hash: buildEventHash({ orderId, platform, kind, amount: signed }),
        item_quantity: 1,
        finance_line_group_id: null,
        needs_quantity_review: false,
        dedupe_slot: 0,
      };
      salesRows.push(attachSalesTransactionIdempotency(base));
    }

    if (!hasAnyAmount) {
      rowErrors.push(`行 ${i + 1}: 有効な金額がありません`);
      continue;
    }

    orders.push({
      order_id: orderId,
      platform,
      sku,
      quantity,
      condition_id,
      jan_code,
      sell_price: Math.round(principalAmount),
      order_date: orderDateIso,
      posted_date: postedIso,
      reconciliation_status: "pending",
      status: "pending",
    });
  }

  return { orders, salesRows, rowErrors };
}
