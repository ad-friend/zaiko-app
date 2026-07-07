import { normalizeOtherPlatformJan } from "@/lib/other-platform-jan";

export type OtherOrderLineInput = {
  order_id: string;
  platform: string;
  sku: string;
  jan_code: string | null;
};

/** 明細行の識別子（SKU 優先、なければ正規化 JAN） */
export function otherOrderLineIdentity(o: { sku: string; jan_code: string | null }): {
  sku: string;
  jan_code: string | null;
  lineKey: string;
} {
  const sku = String(o.sku ?? "").trim();
  const jan = normalizeOtherPlatformJan(o.jan_code);
  const lineKey = sku || jan || "__EMPTY__";
  return { sku, jan_code: jan, lineKey };
}

export function otherOrderLineKey(o: OtherOrderLineInput): string {
  const orderId = String(o.order_id ?? "").trim();
  const platform = String(o.platform ?? "").trim();
  const { lineKey } = otherOrderLineIdentity({ sku: o.sku, jan_code: o.jan_code });
  return `${orderId}\t${platform}\t${lineKey}`;
}
