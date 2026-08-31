"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Search, Link2 } from "lucide-react";
import { getInventoryStatusDisplay } from "@/lib/inventory-status-display";
import InventoryAssembleControls from "@/components/InventoryAssembleControls";

type RecordRow = {
  id: number;
  part_code?: string | null;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  effective_unit_price: number;
  created_at: string;
  order_id: string | null;
  settled_at: string | null;
  exit_type: string | null;
  stock_status: string | null;
  parent_item_id?: number | null;
  item_kind?: string | null;
  assembled_cost?: number;
  child_count?: number;
  header: { supplier: string | null; purchase_date: string } | null;
};

export default function PartsInventoryPage() {
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [loading, setLoading] = useState(true);
  const pageSize = 100;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const u = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        itemKind: "part",
      });
      if (appliedQ.trim()) u.set("q", appliedQ.trim());
      const res = await fetch(`/api/records?${u}`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "取得に失敗しました");
        setRows([]);
        setTotal(0);
        return;
      }
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setTotal(typeof data.total === "number" ? data.total : 0);
    } finally {
      setLoading(false);
    }
  }, [page, appliedQ]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">パーツ在庫</h2>
          <p className="mt-1 text-sm text-slate-600">
            商品在庫一覧には表示されません。組み付けは在庫IDで商品側から行えます。{" "}
            <Link href="/parts-catalog" className="text-primary underline-offset-2 hover:underline">
              パーツマスタ
            </Link>
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setAppliedQ(q);
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="コード・品名で検索"
              className="h-10 w-64 rounded-md border border-slate-200 bg-white pl-8 pr-3 text-sm shadow-sm"
            />
          </div>
          <button type="submit" className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white">
            検索
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">コード</th>
              <th className="px-3 py-2">名称</th>
              <th className="px-3 py-2">ブランド</th>
              <th className="px-3 py-2 text-right">原価</th>
              <th className="px-3 py-2">進捗</th>
              <th className="px-3 py-2">仕入日</th>
              <th className="px-3 py-2">組付</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="py-10 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-slate-500">
                  パーツ在庫がありません。入庫で「パーツ」モードから登録してください。
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const status = getInventoryStatusDisplay(row);
                const canMutate =
                  !row.order_id &&
                  !row.settled_at &&
                  !row.exit_type &&
                  (row.stock_status == null ||
                    String(row.stock_status).trim() === "" ||
                    String(row.stock_status).trim().toLowerCase() === "available");
                return (
                  <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.part_code || row.model_number || "—"}</td>
                    <td className="px-3 py-2 font-medium">{row.product_name || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{row.brand || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.effective_unit_price > 0 ? `${Math.round(row.effective_unit_price).toLocaleString()}円` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${status.badgeClassName}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {row.header?.purchase_date
                        ? new Date(row.header.purchase_date).toLocaleDateString("ja-JP")
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <InventoryAssembleControls
                        parentId={row.id}
                        parentItemId={row.parent_item_id}
                        childCount={row.child_count}
                        assembledCost={row.assembled_cost}
                        ownCost={row.effective_unit_price}
                        canMutate={canMutate}
                        onChanged={load}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
        <span>
          {total.toLocaleString()} 件 / {page} / {totalPages} ページ
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded border px-3 py-1.5 disabled:opacity-40"
          >
            前へ
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border px-3 py-1.5 disabled:opacity-40"
          >
            次へ
          </button>
        </div>
      </div>

      <p className="mt-6 flex items-start gap-2 text-xs text-slate-500">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        商品に組み付けるときは、商品在庫一覧の「組付」に、この画面のパーツIDを入力してください。
      </p>
    </div>
  );
}
