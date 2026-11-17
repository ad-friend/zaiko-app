/**
 * 相談-13：入庫待ち（納品書1枚＝1伝票）の型と、入庫画面への展開。
 * ブラウザとサーバーの両方から読む（秘密の値は持たない）。
 */

export const PENDING_STATUSES = ["単価待ち", "出品待ち", "そろった（入庫待ち）", "登録済み"] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];
/** 取込で入れてよい状態（登録済みは人の登録だけが付ける） */
export const IMPORTABLE_STATUSES: PendingStatus[] = ["単価待ち", "出品待ち", "そろった（入庫待ち）"];

/** 分からない値は null のまま（0・今日・新品で埋めない） */
export type PendingHeader = {
  purchaseDate: string | null; // YYYY-MM-DD
  dateKind?: string | null; // 出荷日・注文日・伝票日付など
  supplierName?: string | null; // 書類に書かれた名前
  supplierKana: string | null; // 仕入先マスターのカナ（確かめたものだけ）
  genre: string | null;
  totalPurchase: number | null; // 商品の合計（送料・値引きを含まない）
  shipping: number | null;
  discount: number | null;
  orderNumber?: string | null;
  documentNumber?: string | null;
};

export type PendingItem = {
  rawName?: string | null; // 書類の品名
  rawModel?: string | null; // 書類の型番・店の商品番号
  refJan?: string | null; // 書類に印字されたJAN（手がかりだけ。登録には使わない）
  quantity: number | null;
  unitPrice: number | null; // 書類・請求書の単価
  sku?: string | null;
  asin?: string | null;
  jan?: string | null; // Amazon の自分の出品から確かめたJAN（登録に使う）
  brand?: string | null;
  productName?: string | null;
  modelNumber?: string | null;
  condition?: "new" | "used" | null;
  fixedUnitPrice?: boolean; // 按分対象
  basePrice?: number | null; // 按分の基準価格（按分対象のとき）
  isSet?: boolean;
  note?: string | null;
};

export type PendingPayload = {
  header: PendingHeader;
  items: PendingItem[];
  notes?: string[];
};

/** 一覧・呼び出しで返す形 */
export type PendingRow = {
  id: string;
  status: PendingStatus;
  supplierKey: string | null;
  documentNumber: string | null;
  orderNumber: string | null;
  purchaseDate: string | null;
  blockers: string[];
  reviewRequired: boolean;
  sourceRefs: unknown[];
  payload: PendingPayload;
  registeredHeaderId: number | null;
  createdAt: string;
};

export function toPendingRow(r: Record<string, unknown>): PendingRow {
  const payload = (r.payload ?? {}) as Partial<PendingPayload>;
  return {
    id: String(r.id),
    status: r.status as PendingStatus,
    supplierKey: (r.supplier_key as string | null) ?? null,
    documentNumber: (r.document_number as string | null) ?? null,
    orderNumber: (r.order_number as string | null) ?? null,
    purchaseDate: (r.purchase_date as string | null) ?? null,
    blockers: Array.isArray(r.blockers) ? (r.blockers as unknown[]).map(String) : [],
    reviewRequired: r.review_required === true,
    sourceRefs: Array.isArray(r.source_refs) ? (r.source_refs as unknown[]) : [],
    payload: {
      header: (payload.header ?? {
        purchaseDate: null,
        supplierKana: null,
        genre: null,
        totalPurchase: null,
        shipping: null,
        discount: null,
      }) as PendingHeader,
      items: Array.isArray(payload.items) ? (payload.items as PendingItem[]) : [],
      notes: Array.isArray(payload.notes) ? payload.notes.map(String) : [],
    },
    registeredHeaderId: r.registered_header_id == null ? null : Number(r.registered_header_id),
    createdAt: String(r.created_at ?? ""),
  };
}

/** 書類の名前（一覧の表示用） */
export function pendingSourceLabel(row: PendingRow): string {
  const first = row.sourceRefs[0] as { path?: string; currentPath?: string } | undefined;
  const p = first?.currentPath ?? first?.path ?? "";
  const name = p.split(/[\\/]/).pop();
  return name || "（書類名なし）";
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** 取込の入力を確かめて整える。おかしければ理由の文字列を返す */
export function parseImportBody(body: unknown):
  | { ok: true; value: {
      sourceHash: string;
      sourcePage: number;
      sourceRefs: unknown[];
      supplierKey: string | null;
      documentNumber: string | null;
      orderNumber: string | null;
      purchaseDate: string | null;
      payload: PendingPayload;
      status: PendingStatus;
      blockers: string[];
      reviewRequired: boolean;
    } }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "本文がありません" };
  const b = body as Record<string, unknown>;
  const sourceHash = strOrNull(b.sourceHash);
  if (!sourceHash || !/^[0-9a-f]{64}$/i.test(sourceHash)) return { ok: false, error: "sourceHash は SHA-256（16進64文字）にしてください" };
  const sourcePage = Number(b.sourcePage ?? 1);
  if (!Number.isInteger(sourcePage) || sourcePage < 1) return { ok: false, error: "sourcePage は1以上の整数にしてください" };
  const status = (b.status ?? "単価待ち") as PendingStatus;
  if (!IMPORTABLE_STATUSES.includes(status)) return { ok: false, error: "status は 単価待ち・出品待ち・そろった（入庫待ち） のどれかにしてください" };
  if ("registeredHeaderId" in b || "registered_header_id" in b) return { ok: false, error: "登録済みの印は取込では付けられません" };
  const purchaseDate = strOrNull(b.purchaseDate);
  if (purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) return { ok: false, error: "purchaseDate は YYYY-MM-DD にしてください" };

  const p = (b.payload ?? {}) as Record<string, unknown>;
  const h = (p.header ?? {}) as Record<string, unknown>;
  if (!Array.isArray(p.items) || p.items.length === 0) return { ok: false, error: "payload.items が空です" };
  const items: PendingItem[] = [];
  for (const raw of p.items as unknown[]) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const quantity = numOrNull(it.quantity);
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) return { ok: false, error: "数量は1以上の整数か null にしてください" };
    const cond = it.condition;
    items.push({
      rawName: strOrNull(it.rawName),
      rawModel: strOrNull(it.rawModel),
      refJan: strOrNull(it.refJan),
      quantity,
      unitPrice: numOrNull(it.unitPrice),
      sku: strOrNull(it.sku),
      asin: strOrNull(it.asin),
      jan: strOrNull(it.jan),
      brand: strOrNull(it.brand),
      productName: strOrNull(it.productName),
      modelNumber: strOrNull(it.modelNumber),
      condition: cond === "new" || cond === "used" ? cond : null,
      fixedUnitPrice: it.fixedUnitPrice === true,
      basePrice: numOrNull(it.basePrice),
      isSet: it.isSet === true,
      note: strOrNull(it.note),
    });
  }
  const header: PendingHeader = {
    purchaseDate: strOrNull(h.purchaseDate) ?? purchaseDate,
    dateKind: strOrNull(h.dateKind),
    supplierName: strOrNull(h.supplierName),
    supplierKana: strOrNull(h.supplierKana),
    genre: strOrNull(h.genre),
    totalPurchase: numOrNull(h.totalPurchase),
    shipping: numOrNull(h.shipping),
    discount: numOrNull(h.discount),
    orderNumber: strOrNull(h.orderNumber) ?? strOrNull(b.orderNumber),
    documentNumber: strOrNull(h.documentNumber) ?? strOrNull(b.documentNumber),
  };

  return {
    ok: true,
    value: {
      sourceHash: sourceHash.toLowerCase(),
      sourcePage,
      sourceRefs: Array.isArray(b.sourceRefs) ? b.sourceRefs : [],
      supplierKey: strOrNull(b.supplierKey),
      documentNumber: header.documentNumber ?? null,
      orderNumber: header.orderNumber ?? null,
      purchaseDate: header.purchaseDate,
      payload: { header, items, notes: Array.isArray(p.notes) ? p.notes.map(String) : [] },
      status,
      blockers: Array.isArray(b.blockers) ? b.blockers.map(String) : [],
      reviewRequired: b.reviewRequired === true,
    },
  };
}
