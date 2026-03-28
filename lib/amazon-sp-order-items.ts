/**
 * Amazon Orders API v0: getOrderItems から明細行の ConditionId 等を取得する。
 * CSV インポートで欠落したコンディションを SP-API で補完する用途。
 */
import { sleep } from "@/lib/amazon-sp-try-client";

export type SpClientLike = {
  callAPI: (params: Record<string, unknown>) => Promise<unknown>;
};

/** SP-API OrderItems の 1 行（必要フィールドのみ） */
export type AmazonOrderItemLine = {
  ASIN?: string;
  SellerSKU?: string;
  QuantityOrdered?: number;
  ConditionId?: string;
};

type GetOrderItemsResponse = {
  OrderItems?: AmazonOrderItemLine[];
  NextToken?: string;
};

/**
 * OrderItem の ConditionId（New / Used / UsedLikeNew 等）を DB 保存用に New | Used に寄せる。
 * fetch-orders の normalizeConditionId と同じ前提。
 */
export function normalizeOrderItemConditionId(conditionId: string | null | undefined): "New" | "Used" {
  const c = String(conditionId ?? "").trim().toLowerCase();
  if (c === "new" || c === "newitem" || c === "new_item") return "New";
  return "Used";
}

async function fetchAllOrderItemLines(spClient: SpClientLike, amazonOrderId: string): Promise<AmazonOrderItemLine[]> {
  const out: AmazonOrderItemLine[] = [];
  let nextToken: string | undefined;
  const oid = String(amazonOrderId ?? "").trim();
  if (!oid) return out;

  do {
    const query: Record<string, string> = {};
    if (nextToken) query.NextToken = nextToken;

    const res = (await spClient.callAPI({
      operation: "getOrderItems",
      endpoint: "orders",
      path: { orderId: oid },
      query,
    })) as GetOrderItemsResponse;

    out.push(...(res.OrderItems ?? []));
    nextToken = res.NextToken?.trim() || undefined;
  } while (nextToken);

  return out;
}

/**
 * 注文 ID ごとに getOrderItems を 1 回（ページネーション込み）、
 * キー `amazon_order_id + '\t' + seller_sku` → condition_id（New|Used）の Map を構築する。
 */
export async function buildAmazonOrderSkuToConditionMap(
  spClient: SpClientLike | null,
  uniqueAmazonOrderIds: string[],
  sleepMs = 250
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!spClient || uniqueAmazonOrderIds.length === 0) return map;

  const seen = [...new Set(uniqueAmazonOrderIds.map((id) => String(id ?? "").trim()).filter(Boolean))];

  for (const orderId of seen) {
    try {
      const lines = await fetchAllOrderItemLines(spClient, orderId);
      for (const item of lines) {
        const sku = String(item.SellerSKU ?? "").trim() || "UNKNOWN";
        const key = `${orderId}\t${sku}`;
        map.set(key, normalizeOrderItemConditionId(item.ConditionId));
      }
    } catch (e) {
      console.warn(`[amazon-sp-order-items] getOrderItems failed orderId=${orderId}`, e);
    }
    await sleep(sleepMs);
  }

  return map;
}
