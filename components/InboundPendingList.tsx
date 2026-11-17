"use client";

/**
 * 相談-13：入庫画面の「入庫待ち」一覧。押すとその伝票を入庫画面に呼び出す。
 * 登録済みは出さない。重複の疑いがあるものは呼び出せず、「別の伝票です」で人が外す。
 */
import { useCallback, useEffect, useState } from "react";
import { pendingSourceLabel, type PendingRow } from "@/lib/inbound-pending";

type Props = {
  activeId: string | null;
  reloadKey: number;
  onSelect: (row: PendingRow) => void;
};

const STATUS_STYLE: Record<string, string> = {
  "そろった（入庫待ち）": "bg-emerald-50 text-emerald-700 border-emerald-200",
  単価待ち: "bg-amber-50 text-amber-700 border-amber-200",
  出品待ち: "bg-sky-50 text-sky-700 border-sky-200",
};

function yen(n: number | null | undefined) {
  return n == null ? "—" : `${Math.round(n).toLocaleString()}円`;
}

export default function InboundPendingList({ activeId, reloadKey, onSelect }: Props) {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/inbound-pending", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "読み込みに失敗しました");
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const pick = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/inbound-pending/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (res.status === 409 && data.registered) {
          alert(`この伝票はもう登録済みです（伝票ID: ${data.headerId}）。一覧を読み直します。`);
          await load();
          return;
        }
        if (!res.ok) throw new Error(data.error || "呼び出しに失敗しました");
        onSelect(data.row as PendingRow);
      } catch (e) {
        alert(e instanceof Error ? e.message : "呼び出しに失敗しました");
      } finally {
        setBusyId(null);
      }
    },
    [load, onSelect]
  );

  const notDuplicate = useCallback(
    async (row: PendingRow) => {
      const nums = [row.orderNumber ? `注文番号 ${row.orderNumber}` : "", row.documentNumber ? `伝票番号 ${row.documentNumber}` : ""]
        .filter(Boolean)
        .join("・");
      if (!confirm(`「${pendingSourceLabel(row)}」（${nums || "番号なし"}）は、ほかの伝票とは別の伝票ですか？\n（分納なら OK。同じ紙を2回スキャンしたものなら「キャンセル」）`)) return;
      setBusyId(row.id);
      try {
        const res = await fetch(`/api/inbound-pending/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // 画面で見た番号を送る。番号が変わっていたら外さない
          body: JSON.stringify({
            action: "not_duplicate",
            expected: { supplierKey: row.supplierKey, orderNumber: row.orderNumber, documentNumber: row.documentNumber },
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.conflict) {
            alert(data.error);
            await load();
            return;
          }
          throw new Error(data.error || "保存に失敗しました");
        }
        await load();
      } catch (e) {
        alert(e instanceof Error ? e.message : "保存に失敗しました");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const readyCount = rows.filter((r) => r.status === "そろった（入庫待ち）" && !r.reviewRequired).length;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between bg-slate-50/80 px-6 py-3 border-b border-slate-100 text-left"
      >
        <span className="text-base font-bold text-slate-800">
          入庫待ち
          <span className="ml-2 text-xs font-normal text-slate-500">
            {loading ? "読み込み中…" : `${rows.length}件（そろった ${readyCount}件）`}
          </span>
        </span>
        <span className="text-xs text-slate-400">{open ? "閉じる" : "開く"}</span>
      </button>
      {open && (
        <div className="max-h-80 overflow-auto divide-y divide-slate-100">
          {error && <p className="px-6 py-3 text-xs text-red-600">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="px-6 py-3 text-xs text-slate-500">入庫待ちはありません</p>
          )}
          {rows.map((r) => {
            const h = r.payload.header;
            const qty = r.payload.items.reduce((s, it) => s + (it.quantity ?? 0), 0);
            const active = r.id === activeId;
            return (
              <div key={r.id} className={`px-4 py-3 text-sm ${active ? "bg-primary/5" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 truncate">
                      {h.supplierName || h.supplierKana || r.supplierKey || "仕入先不明"}
                      <span className="ml-2 text-xs font-normal text-slate-500">{r.purchaseDate ?? "日付不明"}</span>
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {qty}点・{yen(h.totalPurchase)}
                      {r.orderNumber ? `・注文 ${r.orderNumber}` : ""}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">{pendingSourceLabel(r)}</div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLE[r.status] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}>
                    {r.status}
                  </span>
                </div>
                {r.blockers.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-[11px] text-amber-700">
                    {r.blockers.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex gap-2">
                  {r.reviewRequired ? (
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => notDuplicate(r)}
                      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      分納です／別の伝票です
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => pick(r.id)}
                      className="rounded-md border border-primary/30 bg-white px-3 py-1 text-xs font-medium text-primary hover:bg-primary/5 disabled:opacity-50"
                    >
                      {active ? "呼び出し中" : "画面に呼び出す"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
