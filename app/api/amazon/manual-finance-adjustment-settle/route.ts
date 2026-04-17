/**
 * 補填（adjustment 系）の手動完結。
 * - 財務: 指定明細を reconciled に（在庫紐付けなしでも可）
 * - 任意: stockId 指定時、金額が正で経費スキップ対象でない行に stock_id / unit_cost を付与し、
 *   inbound_items.settled_at のみ更新（order_id は補填では変更しない）
 * POST body: { salesTransactionIds: number[], stockId?: number | null, internal_note?: string | null,
 *   allocations?: { salesTransactionId: number; stockId: number }[] }
 * - allocations が指定され、かつ1件以上のとき: 正の経費以外の各行ごとに在庫を割り当て（stockId は無視）
 * - それ以外で stockId あり: 従来どおり全 attach 行に同一在庫
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isAdjustmentLike } from "@/lib/pending-finance-group-kind";
import { isExpenseSkipTxForRefundOffset, toNumberAmount } from "@/lib/amazon-refund-offset-like";
import { markSalesTransactionsReconciled } from "@/lib/amazon-sales-tx-mark-reconciled";
import { earliestPostedDateIso } from "@/lib/settlement-posted-date";

type TxRow = {
  id: number;
  transaction_type: string | null;
  amount_type: string | null;
  amount_description: string | null;
  amount: unknown;
  posted_date: string | null;
  stock_id: unknown;
  status?: string | null;
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rawIds = body.salesTransactionIds;
    const ids = Array.isArray(rawIds)
      ? rawIds.map((x: unknown) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1)
      : [];
    const stockIdRaw = body.stockId;
    const stockId =
      stockIdRaw == null || stockIdRaw === ""
        ? null
        : Number.isFinite(Number(stockIdRaw)) && Number(stockIdRaw) >= 1
          ? Number(stockIdRaw)
          : null;

    const rawAlloc = (body as { allocations?: unknown }).allocations;
    type AllocRow = { salesTransactionId: number; stockId: number };
    let allocations: AllocRow[] | null = null;
    if (Array.isArray(rawAlloc) && rawAlloc.length > 0) {
      const parsed: AllocRow[] = [];
      for (const a of rawAlloc) {
        if (typeof a !== "object" || a == null) continue;
        const o = a as Record<string, unknown>;
        const sid = Number(o.salesTransactionId);
        const inv = Number(o.stockId);
        if (Number.isFinite(sid) && sid >= 1 && Number.isFinite(inv) && inv >= 1) {
          parsed.push({ salesTransactionId: sid, stockId: inv });
        }
      }
      if (parsed.length > 0) allocations = parsed;
    }

    const noteRaw = (body as { internal_note?: unknown }).internal_note;
    const internal_note =
      noteRaw == null ? null : typeof noteRaw === "string" ? noteRaw.trim() || null : String(noteRaw).trim() || null;

    if (ids.length === 0) {
      return NextResponse.json({ error: "salesTransactionIds を1件以上指定してください。" }, { status: 400 });
    }
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      return NextResponse.json({ error: "salesTransactionIds に重複があります。" }, { status: 400 });
    }

    let rows: TxRow[] | null = null;
    {
      const res = await supabase
        .from("sales_transactions")
        .select("id, transaction_type, amount_type, amount_description, amount, posted_date, stock_id, status, internal_note")
        .in("id", ids);
      if (!res.error) rows = (res.data ?? []) as TxRow[];
      else {
        const code = (res.error as { code?: string })?.code;
        const msg = (res.error as { message?: string })?.message ?? "";
        if (code !== "42703" && !msg.includes("status") && !msg.includes("internal_note")) throw res.error;
      }
    }
    if (rows == null) {
      const { data, error } = await supabase
        .from("sales_transactions")
        .select("id, transaction_type, amount_type, amount_description, amount, posted_date, stock_id, internal_note")
        .in("id", ids);
      if (error) throw error;
      rows = (data ?? []) as TxRow[];
    }

    if ((rows ?? []).length !== ids.length) {
      return NextResponse.json({ error: "指定した売上明細の一部が見つかりません。" }, { status: 400 });
    }

    if (!isAdjustmentLike(rows as Parameters<typeof isAdjustmentLike>[0])) {
      return NextResponse.json({ error: "補填（adjustment）系の明細ではありません。" }, { status: 400 });
    }

    for (const r of rows ?? []) {
      if (r.stock_id != null) {
        return NextResponse.json({ error: "既に在庫に紐付いている明細が含まれています。" }, { status: 400 });
      }
      if (String(r.status ?? "").trim() === "reconciled") {
        return NextResponse.json({ error: "既に消込済みの明細が含まれています。" }, { status: 400 });
      }
    }

    const attachIds = (rows ?? [])
      .filter(
        (r) =>
          toNumberAmount(r.amount) > 0 &&
          !isExpenseSkipTxForRefundOffset({
            amount_type: r.amount_type,
            transaction_type: r.transaction_type,
            amount_description: r.amount_description,
          })
      )
      .map((r) => r.id);

    if (stockId != null && allocations != null) {
      return NextResponse.json({ error: "stockId と allocations は同時に指定できません。" }, { status: 400 });
    }

    if (stockId != null || allocations != null) {
      if (attachIds.length === 0) {
        return NextResponse.json(
          { error: "在庫に紐付けられる正の金額行がありません（経費のみ等）。" },
          { status: 400 }
        );
      }

      const settledAt = earliestPostedDateIso(rows ?? []);
      if (!settledAt) {
        return NextResponse.json({ error: "posted_date が無いため settled_at を決められません。" }, { status: 400 });
      }

      if (allocations != null) {
        const attachSet = new Set(attachIds);
        const seenTx = new Set<number>();
        for (const a of allocations) {
          if (seenTx.has(a.salesTransactionId)) {
            return NextResponse.json({ error: "allocations に同一明細 ID が重複しています。" }, { status: 400 });
          }
          seenTx.add(a.salesTransactionId);
          if (!attachSet.has(a.salesTransactionId)) {
            return NextResponse.json(
              { error: "allocations に在庫紐付け対象外の明細 ID が含まれています。" },
              { status: 400 }
            );
          }
        }
        if (allocations.length !== attachIds.length) {
          return NextResponse.json(
            { error: "在庫紐付け対象の正の明細と allocations の件数が一致しません。" },
            { status: 400 }
          );
        }

        const uniqueInbound = new Set<number>();
        for (const a of allocations) {
          const { data: stock, error: stockErr } = await supabase
            .from("inbound_items")
            .select("id, effective_unit_price")
            .eq("id", a.stockId)
            .single();
          if (stockErr || !stock) {
            return NextResponse.json({ error: `在庫 id=${a.stockId} が見つかりません。` }, { status: 404 });
          }
          const unitCost = Number(stock.effective_unit_price ?? 0);
          const { error: uErr } = await supabase
            .from("sales_transactions")
            .update({ stock_id: a.stockId, unit_cost: unitCost })
            .eq("id", a.salesTransactionId);
          if (uErr) throw uErr;
          uniqueInbound.add(a.stockId);
        }
        for (const invId of uniqueInbound) {
          const { error: invErr } = await supabase.from("inbound_items").update({ settled_at: settledAt }).eq("id", invId);
          if (invErr) throw invErr;
        }
      } else if (stockId != null) {
        const { data: stock, error: stockErr } = await supabase
          .from("inbound_items")
          .select("id, effective_unit_price")
          .eq("id", stockId)
          .single();
        if (stockErr || !stock) {
          return NextResponse.json({ error: "指定した在庫が見つかりません。" }, { status: 404 });
        }
        const unitCost = Number(stock.effective_unit_price ?? 0);

        const { error: uErr } = await supabase
          .from("sales_transactions")
          .update({ stock_id: stockId, unit_cost: unitCost })
          .in("id", attachIds);
        if (uErr) throw uErr;

        const { error: invErr } = await supabase.from("inbound_items").update({ settled_at: settledAt }).eq("id", stockId);
        if (invErr) throw invErr;
      }
    }

    await markSalesTransactionsReconciled(ids);

    if (internal_note != null) {
      const { error: noteErr } = await supabase.from("sales_transactions").update({ internal_note }).in("id", ids);
      if (noteErr) {
        const msg = (noteErr as { message?: string })?.message ?? "";
        if (msg.toLowerCase().includes("internal_note")) {
          return NextResponse.json(
            {
              error:
                "internal_note 列がありません。docs/migration_sales_transactions_internal_note.sql を Supabase で実行してください。",
            },
            { status: 500 }
          );
        }
        throw noteErr;
      }
    }

    return NextResponse.json({
      ok: true,
      message:
        allocations != null
          ? "補填を在庫紐付け付きで消込しました（明細ごとに在庫を割当）。"
          : stockId != null
            ? "補填を在庫紐付け付きで消込しました。"
            : "補填明細を財務のみ消込しました（在庫は変更していません）。",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[manual-finance-adjustment-settle]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
