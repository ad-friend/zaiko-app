"use client";

import { useState } from "react";
import { Link2, Unlink, Loader2 } from "lucide-react";

type Props = {
  parentId: number;
  /** 既に親に付いている場合 */
  parentItemId?: number | null;
  childCount?: number;
  assembledCost?: number;
  ownCost: number;
  /** 未引当・未決済なら操作可 */
  canMutate: boolean;
  onChanged: () => void | Promise<void>;
};

/**
 * 在庫一覧用の最小組み付けUI（1対1）。
 * 親行から子IDを指定して組み付け／この行が子なら取り外し。
 */
export default function InventoryAssembleControls({
  parentId,
  parentItemId,
  childCount = 0,
  assembledCost,
  ownCost,
  canMutate,
  onChanged,
}: Props) {
  const [childIdInput, setChildIdInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const showAssembled =
    assembledCost != null && Number.isFinite(assembledCost) && Math.round(assembledCost) !== Math.round(ownCost);

  const assemble = async () => {
    const childId = Number(childIdInput.trim());
    if (!Number.isInteger(childId) || childId < 1) {
      alert("組み付ける在庫のID（正の整数）を入力してください。");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/inventory/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId, childId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || !data.ok) {
        alert(data.error || "組み付けに失敗しました。");
        return;
      }
      setChildIdInput("");
      setOpen(false);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "組み付けに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const disassemble = async () => {
    if (!confirm(`在庫 #${parentId} を親から取り外しますか？`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/inventory/disassemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childId: parentId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        alert(data.error || "取り外しに失敗しました。");
        return;
      }
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "取り外しに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-stretch gap-0.5 text-[10px] leading-tight">
      {showAssembled ? (
        <span className="tabular-nums text-violet-800" title="自身+組み付け子の合算原価">
          合算 {Math.round(assembledCost!).toLocaleString()}円
          {childCount > 0 ? ` (${childCount})` : ""}
        </span>
      ) : childCount > 0 ? (
        <span className="text-violet-700">構成 {childCount}件</span>
      ) : null}

      {!canMutate ? null : parentItemId != null ? (
        <button
          type="button"
          disabled={busy}
          onClick={disassemble}
          className="inline-flex items-center justify-center gap-0.5 rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-violet-900 hover:bg-violet-100 disabled:opacity-50"
          title="親から取り外す"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
          外す
        </button>
      ) : open ? (
        <div className="flex flex-col gap-0.5 rounded border border-slate-200 bg-white p-1 shadow-sm">
          <input
            value={childIdInput}
            onChange={(e) => setChildIdInput(e.target.value)}
            placeholder="子在庫ID"
            className="h-7 w-full rounded border border-slate-200 px-1.5 text-[11px]"
            disabled={busy}
          />
          <div className="flex gap-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={assemble}
              className="flex-1 rounded bg-violet-600 px-1 py-0.5 text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {busy ? "…" : "付ける"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="rounded border border-slate-200 px-1 py-0.5 text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(true)}
          className="inline-flex items-center justify-center gap-0.5 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title="パーツ在庫を組み付ける"
        >
          <Link2 className="h-3 w-3" />
          組付
        </button>
      )}
    </div>
  );
}
