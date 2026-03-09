"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Pencil, Save, X, ChevronLeft } from "lucide-react";

type RecordRow = {
  id: number;
  jan_code: string | null;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  condition_type: string | null;
  base_price: number;
  effective_unit_price: number;
  created_at: string;
  header: {
    id: number;
    purchase_date: string;
    supplier: string | null;
    genre: string | null;
    created_at: string;
  } | null;
};

function BarcodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m-4-8v8m8-8v8M4 4h2v16H4V4zm14 0h2v16h-2V4zM8 4h1v16H8V4zm6 0h1v16h-1V4z" />
    </svg>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
// px-4 -> px-6
const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

type EditDraft = {
  brand: string;
  product_name: string;
  model_number: string;
  created_at: string;
  supplier: string;
  genre: string;
  base_price: number;
  effective_unit_price: number;
};

export default function HistoryPage() {
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [bulkSnapshot, setBulkSnapshot] = useState<RecordRow[] | null>(null);
  const [bulkAction, setBulkAction] = useState<string>("bulk_delete");
  const [saving, setSaving] = useState(false);

  const fetchRecords = useCallback(async () => {
    try {
      const res = await fetch("/api/records");
      if (!res.ok) throw new Error("取得に失敗しました");
      const data = await res.json();
      setRows(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const formatDate = (iso: string) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      return iso;
    }
  };

  const toDateValue = (iso: string) => (iso ? iso.slice(0, 10) : "");

  const toggleSelect = (id: number, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      
      // Shiftキー範囲選択ロジック
      if (shiftKey && lastCheckedId !== null) {
        const currentIndex = rows.findIndex(r => r.id === id);
        const lastIndex = rows.findIndex(r => r.id === lastCheckedId);
        
        if (currentIndex !== -1 && lastIndex !== -1) {
          const start = Math.min(currentIndex, lastIndex);
          const end = Math.max(currentIndex, lastIndex);
          const targetValue = !prev.has(id); // クリックした行の状態に合わせるか、常に選択にするか。
          // 通常Shift選択は「選択範囲をActiveにする」なので、addする方向で実装
          
          for (let i = start; i <= end; i++) {
             next.add(rows[i].id);
          }
          return next;
        }
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      
      setLastCheckedId(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (rows.length === 0) return;
    if (selectedIds.size >= rows.length) {
        setSelectedIds(new Set());
        setLastCheckedId(null);
    } else {
        setSelectedIds(new Set(rows.map((r) => r.id)));
        setLastCheckedId(null);
    }
  };

  const startIndividualEdit = (row: RecordRow) => {
    setEditingId(row.id);
    setEditDraft({
      brand: row.brand ?? "",
      product_name: row.product_name ?? "",
      model_number: row.model_number ?? "",
      created_at: toDateValue(row.created_at),
      supplier: row.header?.supplier ?? "",
      genre: row.header?.genre ?? "",
      base_price: row.base_price,
      effective_unit_price: row.effective_unit_price,
    });
  };

  const cancelIndividualEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const saveIndividualEdit = useCallback(async () => {
    if (editingId == null || !editDraft) return;
    setSaving(true);
    try {
      const created_at = editDraft.created_at ? `${editDraft.created_at}T00:00:00.000Z` : "";
      const res = await fetch("/api/infer-jan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          brand: editDraft.brand,
          product_name: editDraft.product_name,
          model_number: editDraft.model_number,
          supplier: editDraft.supplier,
          genre: editDraft.genre,
          base_price: editDraft.base_price,
          effective_unit_price: editDraft.effective_unit_price,
          ...(created_at && { created_at }),
        }),
      });
      if (!res.ok) throw new Error("更新に失敗しました");
      
      setRows((prev) =>
        prev.map((r) => {
            if (r.id !== editingId) return r;
            const newHeader = r.header ? { ...r.header, supplier: editDraft.supplier, genre: editDraft.genre } : r.header;
            return {
                ...r,
                brand: editDraft.brand || null,
                product_name: editDraft.product_name || null,
                model_number: editDraft.model_number || null,
                created_at: created_at || r.created_at,
                base_price: editDraft.base_price,
                effective_unit_price: editDraft.effective_unit_price,
                header: newHeader
            };
        })
      );
      setEditingId(null);
      setEditDraft(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [editingId, editDraft]);

  const startBulkEdit = () => {
    // deep copy for snapshot including header
    setBulkSnapshot(rows.map(r => ({...r, header: r.header ? {...r.header} : null})));
    setIsBulkEditing(true);
  };

  const cancelBulkEdit = () => {
    if (bulkSnapshot) setRows(bulkSnapshot);
    setBulkSnapshot(null);
    setIsBulkEditing(false);
  };

  const saveBulkEdit = useCallback(async () => {
    setSaving(true);
    try {
      const items = rows.map((r) => ({
        id: r.id,
        brand: r.brand ?? "",
        product_name: r.product_name ?? "",
        model_number: r.model_number ?? "",
        base_price: r.base_price,
        effective_unit_price: r.effective_unit_price,
        supplier: r.header?.supplier ?? "",
        genre: r.header?.genre ?? "",
        ...(r.created_at && { created_at: r.created_at }),
      }));
      const res = await fetch("/api/infer-jan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error("一括更新に失敗しました");
      setBulkSnapshot(null);
      setIsBulkEditing(false);
      await fetchRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "一括更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [rows, fetchRecords]);

  // RecordRowのフィールド更新用
  const updateRowField = useCallback((id: number, field: keyof RecordRow, value: string | number) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }, []);

  // Header情報のフィールド更新用
  const updateRowHeaderField = useCallback((id: number, field: "supplier" | "genre", value: string) => {
      setRows((prev) => prev.map((r) => {
          if (r.id !== id || !r.header) return r;
          return { ...r, header: { ...r.header, [field]: value } };
      }));
  }, []);


  const executeBulkAction = useCallback(async () => {
    if (bulkAction === "bulk_delete" && selectedIds.size > 0) {
      if (!confirm(`選択した ${selectedIds.size} 件を削除しますか？`)) return;
      setSaving(true);
      try {
        const res = await fetch("/api/records", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: Array.from(selectedIds) }),
        });
        if (!res.ok) throw new Error("削除に失敗しました");
        setSelectedIds(new Set());
        await fetchRecords();
      } catch (e) {
        alert(e instanceof Error ? e.message : "削除に失敗しました");
      } finally {
        setSaving(false);
      }
    }
  }, [bulkAction, selectedIds, fetchRecords]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-30 w-full border-b bg-white/80 backdrop-blur-md shadow-sm">
        <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 text-slate-900 hover:opacity-80 transition-opacity">
              <div className="rounded-lg bg-primary p-1.5 text-white shadow-md shadow-primary/30">
                <BarcodeIcon className="h-5 w-5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Zaiko Manager <span className="text-xs font-normal text-slate-500 ml-2 bg-slate-100 px-2 py-0.5 rounded-full">Professional</span></h1>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 h-10 px-6 py-2 shadow-sm bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300"
            >
              <ChevronLeft className="mr-2 h-4 w-4" />
              入庫画面へ戻る
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 py-8 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <DocumentIcon className="h-5 w-5 text-primary" />
              在庫一覧
            </h2>
          </div>

          {!loading && !error && rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white">
              {!isBulkEditing ? (
                <>
                  {/* 左側固定：全選択、操作プルダウン、実行ボタン */}
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-600">
                        <input
                        type="checkbox"
                        checked={rows.length > 0 && selectedIds.size === rows.length}
                        onChange={toggleSelectAll}
                        className="rounded border-slate-300 text-primary focus:ring-primary"
                        />
                        全選択/解除
                    </label>
                    <select
                        value={bulkAction}
                        onChange={(e) => setBulkAction(e.target.value)}
                        className={`${inputClass} w-auto min-w-[120px] h-9 py-1`}
                    >
                        <option value="bulk_delete">一括削除</option>
                    </select>
                    <button
                        type="button"
                        onClick={executeBulkAction}
                        disabled={selectedIds.size === 0 || saving}
                        className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50`}
                    >
                        実行
                    </button>
                  </div>
                  
                  {/* 右側：一括編集ボタン */}
                  <div className="ml-auto">
                    <button
                        type="button"
                        onClick={startBulkEdit}
                        className={`${buttonClass} bg-white text-primary border border-primary/20 hover:bg-primary/5`}
                    >
                        一括編集
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* 右側：保存、解除ボタン */}
                  <div className="ml-auto flex items-center gap-3">
                    <button
                        type="button"
                        onClick={saveBulkEdit}
                        disabled={saving}
                        className={`${buttonClass} bg-primary text-white hover:bg-primary/90`}
                    >
                        {saving ? "保存中..." : "全保存"}
                    </button>
                    <button
                        type="button"
                        onClick={cancelBulkEdit}
                        className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
                    >
                        全解除
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="p-6">
            {loading && (
              <p className="text-sm text-slate-500 py-8 text-center">読み込み中...</p>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                {error}
              </div>
            )}
            {!loading && !error && rows.length === 0 && (
              <p className="text-sm text-slate-400 py-8 text-center">登録データがありません</p>
            )}
            {!loading && !error && rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[800px]">
                  <thead className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                    <tr>
                      <th className="px-6 py-4 w-[44px] text-center"></th>
                      <th className="px-6 py-4">登録日</th>
                      <th className="px-6 py-4">仕入先</th>
                      <th className="px-6 py-4">ジャンル</th>
                      <th className="px-6 py-4 w-[140px]">JAN</th>
                      <th className="px-6 py-4 min-w-[180px]">商品名</th>
                      <th className="px-6 py-4">ブランド</th>
                      <th className="px-6 py-4">型番</th>
                      <th className="px-6 py-4 text-right">基準価格</th>
                      <th className="px-6 py-4 text-right">実質単価</th>
                      <th className="px-6 py-4">状態</th>
                      <th className="px-6 py-4 w-[100px] text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {rows.map((row) => {
                      const isIndividualEdit = editingId === row.id;
                      const isEditMode = isIndividualEdit || isBulkEditing;
                      const displayDate = formatDate(row.header?.created_at ?? row.created_at);

                      return (
                        <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4 text-center align-middle">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.id)}
                              onChange={(e) => {
                                // Shiftキーは nativeEvent で取得
                                const nativeEvent = e.nativeEvent as MouseEvent;
                                toggleSelect(row.id, nativeEvent.shiftKey);
                              }}
                              className="rounded border-slate-300 text-primary focus:ring-primary"
                            />
                          </td>
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap">
                            {isEditMode ? (
                              <input
                                type="date"
                                value={isIndividualEdit && editDraft ? editDraft.created_at : toDateValue(row.created_at)}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, created_at: e.target.value } : d))
                                    : updateRowField(row.id, "created_at", e.target.value ? `${e.target.value}T00:00:00.000Z` : "")
                                }
                                className={`${inputClass} h-9 text-xs`}
                              />
                            ) : (
                              displayDate
                            )}
                          </td>
                          <td className="px-6 py-4 text-slate-700">
                             {isEditMode ? (
                                <input
                                    value={isIndividualEdit && editDraft ? editDraft.supplier : row.header?.supplier ?? ""}
                                    onChange={(e) =>
                                        isIndividualEdit && editDraft
                                          ? setEditDraft((d) => (d ? { ...d, supplier: e.target.value } : d))
                                          : updateRowHeaderField(row.id, "supplier", e.target.value)
                                    }
                                    className={`${inputClass} h-9 text-xs`}
                                    placeholder="仕入先"
                                />
                             ) : (
                                row.header?.supplier ?? "—"
                             )}
                          </td>
                          <td className="px-6 py-4 text-slate-600">
                             {isEditMode ? (
                                <input
                                    value={isIndividualEdit && editDraft ? editDraft.genre : row.header?.genre ?? ""}
                                    onChange={(e) =>
                                        isIndividualEdit && editDraft
                                          ? setEditDraft((d) => (d ? { ...d, genre: e.target.value } : d))
                                          : updateRowHeaderField(row.id, "genre", e.target.value)
                                    }
                                    className={`${inputClass} h-9 text-xs`}
                                    placeholder="ジャンル"
                                />
                             ) : (
                                row.header?.genre ?? "—"
                             )}
                          </td>
                          <td className="px-6 py-4 font-mono text-xs">{row.jan_code ?? "—"}</td>
                          <td className="px-6 py-4 font-medium text-slate-900">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.product_name : row.product_name ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, product_name: e.target.value } : d))
                                    : updateRowField(row.id, "product_name", e.target.value)
                                }
                                className={`${inputClass} h-9 font-medium`}
                                placeholder="商品名"
                              />
                            ) : (
                              row.product_name ?? "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-slate-600">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.brand : row.brand ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, brand: e.target.value } : d))
                                    : updateRowField(row.id, "brand", e.target.value)
                                }
                                className={`${inputClass} h-9`}
                                placeholder="ブランド"
                              />
                            ) : (
                              row.brand ?? "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-slate-600">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.model_number : row.model_number ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, model_number: e.target.value } : d))
                                    : updateRowField(row.id, "model_number", e.target.value)
                                }
                                className={`${inputClass} h-9`}
                                placeholder="型番"
                              />
                            ) : (
                              row.model_number ?? "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-right tabular-nums">
                            {isEditMode ? (
                                <input
                                type="number"
                                value={isIndividualEdit && editDraft ? editDraft.base_price : row.base_price}
                                onChange={(e) =>
                                    isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, base_price: Number(e.target.value) } : d))
                                    : updateRowField(row.id, "base_price", Number(e.target.value))
                                }
                                className={`${inputClass} h-9 text-right`}
                                />
                            ) : (
                                row.base_price > 0 ? row.base_price.toLocaleString() + " 円" : "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-right font-medium tabular-nums">
                             {isEditMode ? (
                                <input
                                type="number"
                                value={isIndividualEdit && editDraft ? editDraft.effective_unit_price : row.effective_unit_price}
                                onChange={(e) =>
                                    isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, effective_unit_price: Number(e.target.value) } : d))
                                    : updateRowField(row.id, "effective_unit_price", Number(e.target.value))
                                }
                                className={`${inputClass} h-9 text-right`}
                                />
                             ) : (
                                row.effective_unit_price > 0 ? Math.round(row.effective_unit_price).toLocaleString() + " 円" : "—"
                             )}
                          </td>
                          <td className="px-6 py-4 text-slate-600">{row.condition_type === "new" ? "新品" : row.condition_type === "used" ? "中古" : row.condition_type ?? "—"}</td>
                          <td className="px-6 py-4 text-center">
                            {isIndividualEdit ? (
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  onClick={saveIndividualEdit}
                                  disabled={saving}
                                  className={`${buttonClass} h-9 px-2 bg-primary text-white hover:bg-primary/90`}
                                  title="保存"
                                >
                                  <Save className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelIndividualEdit}
                                  className={`${buttonClass} h-9 px-2 bg-white text-slate-700 border border-slate-200 hover:bg-slate-50`}
                                  title="取消"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : !isBulkEditing ? (
                              <button
                                type="button"
                                onClick={() => startIndividualEdit(row)}
                                className={`${buttonClass} h-9 px-2 bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
                                title="編集"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && !error && rows.length > 0 && isBulkEditing && (
              <div className="flex items-center gap-3 pt-4 mt-4 border-t border-slate-100">
                <div className="ml-auto flex items-center gap-3">
                    <button
                        type="button"
                        onClick={saveBulkEdit}
                        disabled={saving}
                        className={`${buttonClass} bg-primary text-white hover:bg-primary/90`}
                    >
                        {saving ? "保存中..." : "保存"}
                    </button>
                    <button
                        type="button"
                        onClick={cancelBulkEdit}
                        className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
                    >
                        解除
                    </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
