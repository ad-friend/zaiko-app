/**
 * Principal/Tax 4行相殺グループの手動確定。
 * - offset: status のみ reconciled（在庫・stock_id は触らない）
 * - release_inbound: inbound の注文引当解除後、同じく reconciled
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isPrincipalTaxOffsetQuad, type PrincipalTaxQuadRowLike } from "@/lib/amazon-principal-tax-quad";
import { releaseInboundItemsForAmazonOrder } from "@/lib/amazon-order-inventory-release";

async function markSalesTxReconciled(ids: number[]): Promise<void> {
  if (!ids.length) return;

  const { error: err1 } = await supabase
    .from("sales_transactions")
    .update({ status: "reconciled" } as Record<string, unknown>)
    .in("id", ids);
  if (!err1) return;

  const code = (err1 as { code?: string })?.code;
  const msg = (err1 as { message?: string })?.message ?? "";
  if (code === "42703" || msg.includes("status")) return;
  throw err1;
}

type Body = {
  action?: string;
  salesTransactionIds?: unknown;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Body;
    const action = body.action === "release_inbound" ? "release_inbound" : body.action === "offset" ? "offset" : "";
    const rawIds = body.salesTransactionIds;
    const ids = Array.isArray(rawIds)
      ? rawIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1)
      : [];

    if (action !== "offset" && action !== "release_inbound") {
      return NextResponse.json({ error: "action は offset または release_inbound を指定してください。" }, { status: 400 });
    }
    if (ids.length !== 4) {
      return NextResponse.json({ error: "salesTransactionIds はちょうど4件の数値IDを指定してください。" }, { status: 400 });
    }
    const unique = new Set(ids);
    if (unique.size !== 4) {
      return NextResponse.json({ error: "重複のない4件のIDを指定してください。" }, { status: 400 });
    }

    let rows: Record<string, unknown>[] | null = null;
    {
      const res = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, stock_id, status, transaction_type, amount_type, amount_description, amount")
        .in("id", ids);
      if (!res.error) {
        rows = (res.data ?? []) as Record<string, unknown>[];
      } else {
        const code = (res.error as { code?: string })?.code;
        const msg = (res.error as { message?: string })?.message ?? "";
        if (code !== "42703" && !msg.includes("status")) throw res.error;
      }
    }
    if (rows == null) {
      const res = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, stock_id, transaction_type, amount_type, amount_description, amount")
        .in("id", ids);
      if (res.error) throw res.error;
      rows = (res.data ?? []) as Record<string, unknown>[];
    }
    const list = rows;
    if (list.length !== 4) {
      return NextResponse.json({ error: "指定した売上明細が4件揃いません。" }, { status: 400 });
    }

    const orderIds = new Set(list.map((r) => String((r as { amazon_order_id?: string | null }).amazon_order_id ?? "").trim()));
    if (orderIds.size !== 1) {
      return NextResponse.json({ error: "同一の amazon_order_id の明細のみ処理できます。" }, { status: 400 });
    }
    const amazonOrderId = [...orderIds][0];
    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id が空の明細は処理できません。" }, { status: 400 });
    }

    for (const r of list) {
      const row = r as { stock_id?: unknown; status?: string | null };
      if (row.stock_id != null) {
        return NextResponse.json({ error: "在庫に紐付いている明細は処理できません。" }, { status: 400 });
      }
      if (String(row.status ?? "").trim() === "reconciled") {
        return NextResponse.json({ error: "既に消込済みの明細が含まれています。" }, { status: 400 });
      }
    }

    if (!isPrincipalTaxOffsetQuad(list as PrincipalTaxQuadRowLike[])) {
      return NextResponse.json({ error: "Principal/Tax の4行相殺パターンではありません。" }, { status: 400 });
    }

    if (action === "release_inbound") {
      const rel = await releaseInboundItemsForAmazonOrder(amazonOrderId, "cancel");
      if (!rel.ok) {
        return NextResponse.json({ error: rel.message }, { status: 400 });
      }
    }

    await markSalesTxReconciled(ids);

    return NextResponse.json({
      ok: true,
      message:
        action === "offset"
          ? "相殺のみ完結として消込しました（在庫は変更していません）。"
          : "注文引当を解除し、相殺として消込しました。",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[manual-finance-principal-tax-settle]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
