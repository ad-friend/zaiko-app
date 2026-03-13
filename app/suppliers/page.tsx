"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Save, X, Download, Search, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { normalizeToFullWidthKatakana } from "@/lib/kana";

type SupplierRow = { id: number; name: string; kana: string; phone: string | null; address: string | null; created_at: string };

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 transition-all shadow-sm";
const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function SuppliersPage() {
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [kana, setKana] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<SupplierRow | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string | null; direction: "asc" | "desc" }>({ key: null, direction: "asc" });
  const [searchTerm, setSearchTerm] = useState("");
  const [saving, setSaving] = useState(false);
  const [isInferring, setIsInferring] = useState(false);

  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch("/api/suppliers");
      if (res.ok) setRows(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const requestSort = (key: string) => {
    setSortConfig((p) => (p.key !== key ? { key, direction: "asc" } : p.direction === "asc" ? { key, direction: "desc" } : { key: null, direction: "asc" }));
  };

  const processedRows = (() => {
    let list = rows;
    const t = searchTerm.trim().toLowerCase();
    if (t) list = list.filter((r) => [r.name, r.kana, r.phone ?? "", r.address ?? ""].some((v) => v.toLowerCase().includes(t)));
    const { key, direction } = sortConfig;
    if (key) {
      list = [...list].sort((a, b) => {
        const va = String((a as any)[key] ?? "");
        const vb = String((b as any)[key] ?? "");
        const c = va.localeCompare(vb, "ja");
        return direction === "asc" ? c : -c;
      });
    }
    return list;
  })();

 // 仕入先名からマウスが外れた時（フォーカスアウト）にAIを呼ぶ
 const handleNameBlur = async () => {
  // 名前が空、または既にカナが入っている場合は実行しない（手動入力を優先）
  if (!name.trim() || kana.trim()) return;

  setIsInferring(true);
  try {
    const res = await fetch("/api/infer-kana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: name.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.kana) setKana(data.kana);
    }
  } catch (e) {
    console.error("AIフリガナ取得エラー", e);
  } finally {
    setIsInferring(false);
  }
};

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !kana.trim()) {
      alert("仕入先名とカナは必須です");
      return;
    }
    if (!/^[ア-ンヴー・\s]+$/.test(kana.trim())) {
      alert("カナは全角カタカナで入力してください（英数字や漢字、ひらがなは使用できません）。");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kana: normalizeToFullWidthKatakana(kana.trim()), phone: phone.trim() || null, address: address.trim() || null }),
      });
      if (!res.ok) throw new Error("登録に失敗しました");
      setName("");
      setKana("");
      setPhone("");
      setAddress("");
      await fetchRows();
    } catch (e) {
      alert(e instanceof Error ? e.message : "登録に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const escapeCsv = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const handleCsvExport = () => {
    const h = "id,name,kana,phone,address,created_at";
    const lines = processedRows.map((r) => [r.id, r.name, r.kana, r.phone ?? "", r.address ?? "", r.created_at].map(escapeCsv).join(","));
    const blob = new Blob(["\uFEFF" + [h, ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `suppliers_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const executeDelete = async () => {
    if (selectedIds.size === 0 || !confirm(`${selectedIds.size} 件削除しますか？`)) return;
    setSaving(true);
    try {
      const res = await fetch("/api/suppliers", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(selectedIds) }) });
      if (!res.ok) throw new Error("削除に失敗しました");
      setSelectedIds(new Set());
      await fetchRows();
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editDraft) return;
    if (!/^[ア-ンヴー・\s]+$/.test(editDraft.kana.trim())) {
      alert("カナは全角カタカナで入力してください（英数字や漢字、ひらがなは使用できません）。");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editDraft.id, name: editDraft.name, kana: normalizeToFullWidthKatakana(editDraft.kana), phone: editDraft.phone, address: editDraft.address }),
      });
      if (!res.ok) throw new Error("更新に失敗しました");
      setEditingId(null);
      setEditDraft(null);
      await fetchRows();
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const SortBtn = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <button type="button" onClick={() => requestSort(k)} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
      {children}
      {sortConfig.key === k ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col">
      <main className="flex-1 py-8 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <DocumentIcon className="h-5 w-5 text-primary" />
              仕入先管理
            </h2>
          </div>

          {/* 新規登録フォーム */}
          <div className="p-6 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">新規登録</h3>
            <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">仕入先名（必須）</label>
                {/* 🌟 変更：onChangeをシンプルにして、onBlur（入力から離れた時）にAI関数を呼ぶ */}
                <input 
                  value={name} 
                  onChange={(e) => setName(e.target.value)} 
                  onBlur={handleNameBlur}
                  className={inputClass} 
                  required 
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">カナ（必須）</label>
                {/* 🌟 変更：AIが考え中の時は「AI変換中...」と表示して操作できないようにする */}
                <input
                  value={isInferring ? "AI変換中..." : kana}
                  onChange={(e) => setKana(e.target.value)}
                  onBlur={(e) => setKana(normalizeToFullWidthKatakana(e.target.value))}
                  className={inputClass}
                  required
                  disabled={isInferring}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">電話番号（任意）</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <label className="text-xs font-semibold text-slate-500 block mb-1">住所（任意）</label>
                <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputClass} />
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <button type="submit" disabled={saving} className={`${buttonClass} bg-primary text-white hover:bg-primary/90`}>{saving ? "保存中..." : "登録"}</button>
              </div>
            </form>
          </div>

          {/* リストツールバー */}
          {!loading && rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={selectedIds.size === processedRows.length && processedRows.length > 0} onChange={() => selectedIds.size >= processedRows.length ? setSelectedIds(new Set()) : setSelectedIds(new Set(processedRows.map((r) => r.id)))} className="rounded border-slate-300 text-primary" />
                  全選択
                </label>
                <button type="button" onClick={executeDelete} disabled={selectedIds.size === 0 || saving} className={`${buttonClass} bg-white text-slate-700 border border-slate-200 disabled:opacity-50`}>削除</button>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <div className="relative rounded-lg border border-slate-200 bg-white shadow-sm max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="検索..." className={`${inputClass} pl-10 border-0 focus-visible:ring-0 rounded-lg`} />
                </div>
                <button type="button" onClick={handleCsvExport} className={`${buttonClass} bg-white text-slate-700 border border-slate-200`}><Download className="mr-2 h-4 w-4" />CSV出力</button>
              </div>
            </div>
          )}

          <div className="p-6">
            {loading && <p className="text-sm text-slate-500 py-8 text-center">読み込み中...</p>}
            {!loading && rows.length === 0 && <p className="text-sm text-slate-400 py-8 text-center">仕入先を登録してください</p>}
            {!loading && rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[600px]">
                  <thead className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold">
                    <tr>
                      <th className="px-6 py-4 w-10"></th>
                      <th className="px-6 py-4"><SortBtn k="name">仕入先名</SortBtn></th>
                      <th className="px-6 py-4"><SortBtn k="kana">カナ</SortBtn></th>
                      <th className="px-6 py-4"><SortBtn k="phone">電話</SortBtn></th>
                      <th className="px-6 py-4"><SortBtn k="address">住所</SortBtn></th>
                      <th className="px-6 py-4 w-24 text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {processedRows.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4">
                          <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => setSelectedIds((p) => { const n = new Set(p); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })} className="rounded border-slate-300 text-primary" />
                        </td>
                        <td className="px-6 py-4">
                          {editingId === row.id && editDraft ? (
                            <input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} className={`${inputClass} h-9`} />
                          ) : (
                            row.name
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {/* 🌟 下の表にある編集用のカナ入力も同じように修正しました！ */}
                          {editingId === row.id && editDraft ? (
                            <input
                              value={editDraft.kana}
                              onChange={(e) => setEditDraft({ ...editDraft, kana: e.target.value })}
                              onBlur={(e) => setEditDraft((d) => d ? { ...d, kana: normalizeToFullWidthKatakana(e.target.value) } : d)}
                              className={`${inputClass} h-9`}
                            />
                          ) : (
                            row.kana
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editingId === row.id && editDraft ? (
                            <input value={editDraft.phone ?? ""} onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value || null })} className={`${inputClass} h-9`} />
                          ) : (
                            row.phone ?? "—"
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editingId === row.id && editDraft ? (
                            <input value={editDraft.address ?? ""} onChange={(e) => setEditDraft({ ...editDraft, address: e.target.value || null })} className={`${inputClass} h-9`} />
                          ) : (
                            row.address ?? "—"
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {editingId === row.id ? (
                            <div className="flex justify-center gap-1">
                              <button type="button" onClick={saveEdit} className={`${buttonClass} h-9 px-2 bg-primary text-white`}><Save className="h-4 w-4" /></button>
                              <button type="button" onClick={() => { setEditingId(null); setEditDraft(null); }} className={`${buttonClass} h-9 px-2 bg-white border border-slate-200`}><X className="h-4 w-4" /></button>
                            </div>
                          ) : (
                            <button type="button" onClick={() => { setEditingId(row.id); setEditDraft({ ...row }); }} className={`${buttonClass} h-9 px-2 bg-white border border-slate-200`}><Pencil className="h-4 w-4" /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}