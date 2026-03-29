/**
 * Orders API: getOrderItems の取得（ページング対応）。
 * カタログ API は含まない。
 */
export type OrderItemLite = {
  SellerSKU?: string;
  ASIN?: string;
  ConditionId?: string;
};

export type SpClientInstance = {
  callAPI: (req: Record<string, unknown>) => Promise<unknown>;
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tryCreateAmazonSpClient(): SpClientInstance | null {
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;
  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) return null;
  try {
    const SellingPartnerAPI = require("amazon-sp-api") as new (opts: unknown) => SpClientInstance;
    return new SellingPartnerAPI({
      region: "fe",
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: secretKey,
        AWS_SELLING_PARTNER_ROLE: "",
      },
    });
  } catch {
    return null;
  }
}

/** fetch-orders と同じ New/Used 正規化（OrderItems.ConditionId 用） */
export function normalizeOrderItemConditionId(conditionId: string | null | undefined): "New" | "Used" {
  const c = String(conditionId ?? "").trim().toLowerCase();
  if (c === "new" || c === "newitem" || c === "new_item") return "New";
  return "Used";
}

export async function fetchAllOrderItems(sp: SpClientInstance, amazonOrderId: string): Promise<OrderItemLite[]> {
  const out: OrderItemLite[] = [];
  let nextToken: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const query: Record<string, string> = {};
    if (nextToken) query.NextToken = nextToken;
    const res = (await sp.callAPI({
      operation: "getOrderItems",
      endpoint: "orders",
      path: { orderId: amazonOrderId },
      ...(Object.keys(query).length ? { query } : {}),
    })) as { OrderItems?: OrderItemLite[]; NextToken?: string };
    out.push(...(res?.OrderItems ?? []));
    nextToken = res?.NextToken;
    if (!nextToken) break;
    await sleep(350);
  }
  return out;
}

export function skuMatchesOrderLine(orderSku: string, itemSku: string): boolean {
  return String(orderSku).trim().toLowerCase() === String(itemSku ?? "").trim().toLowerCase();
}
