/**
 * 相談-13 段階4：PC の照合プログラム（取込と同じ合い言葉）が、freee の仕入と入庫伝票を照らすために読む入口。
 * 読むだけ（inbound_headers の select だけ）。どの表にも書かない。
 * GET ?from=YYYY-MM-DD → { headers: [{ id, purchaseDate, supplier, orderNumber, totalCost, ... }] }
 *   仕入日が from 以降か、from 以降に登録した入庫伝票（仕入日の古い順・最大 5,000 件）。
 */
import { NextRequest, NextResponse } from "next/server";
import { createInboundPendingClient, requireInboundImportAuth } from "@/lib/inbound-pending-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 1000;
const MAX_ROWS = 5000;
const COLUMNS =
  "id,purchase_date,supplier,order_number,total_purchase_amount,shipping_cost,discount_amount,total_cost,created_at,pending_id,inbound_items(effective_unit_price)";

type Row = {
  id: number;
  purchase_date: string | null;
  supplier: string | null;
  order_number: string | null;
  total_purchase_amount: number | string | null;
  shipping_cost: number | string | null;
  discount_amount: number | string | null;
  total_cost: number | string | null;
  created_at: string | null;
  pending_id: string | null;
  inbound_items: { effective_unit_price: number | string | null }[] | null;
};

const num = (v: number | string | null) => (v === null || v === "" ? null : Number(v));

export async function GET(req: NextRequest) {
  const auth = requireInboundImportAuth(req.headers.get("authorization"));
  if (auth === 500) return NextResponse.json({ error: "取込の合い言葉が設定されていません" }, { status: 500 });
  if (auth === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const from = req.nextUrl.searchParams.get("from") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || from < "2026-01-01") {
    return NextResponse.json({ error: "from は 2026-01-01 以降の YYYY-MM-DD で指定してください" }, { status: 400 });
  }

  try {
    const supabase = createInboundPendingClient();
    const rows: Row[] = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const { data, error } = await supabase
        .from("inbound_headers")
        .select(COLUMNS)
        // 仕入日が古くても from 以降に登録した伝票は返す（照合の余りを取りこぼさない）
        .or(`purchase_date.gte.${from},created_at.gte."${from}T00:00:00+09:00"`)
        .order("purchase_date", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Row[]));
      if (!data || data.length < PAGE) {
        return NextResponse.json({
          headers: rows.map((r) => ({
            id: r.id,
            purchaseDate: r.purchase_date,
            supplier: r.supplier,
            orderNumber: r.order_number,
            totalPurchase: num(r.total_purchase_amount),
            shipping: num(r.shipping_cost),
            discount: num(r.discount_amount),
            totalCost: num(r.total_cost),
            createdAt: r.created_at,
            fromPending: r.pending_id !== null,
            // 手入力の伝票は見出しの合計が 0 のことがあるため、商品の行の実質単価の合計も返す（送料・値引きを按分した後の値）
            itemCount: (r.inbound_items ?? []).length,
            itemsTotal: (r.inbound_items ?? []).reduce((a, it) => a + (num(it.effective_unit_price) ?? 0), 0),
          })),
        });
      }
    }
    // 全部読み切れないときは途中の結果を返さない（照合を「全部見た」と誤らせない）
    return NextResponse.json({ error: `入庫伝票が ${MAX_ROWS} 件を超えました。from を後ろにしてください` }, { status: 413 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "入庫伝票を読めませんでした" }, { status: 502 });
  }
}
