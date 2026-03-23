"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Save, X, Download, Upload, Search, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

type ProductRow = { jan_code: string; brand: string | null; product_name: string; model_number: string | null; created_at: string };

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 transition-all shadow-sm";
const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function ProductsPage() {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [janCode, setJanCode] = useState("");
  const [brand, setBrand] = useState("");
  const [productName, setProductName] = useState("");
  const [modelNumber, setModelNumber] = useState("");
  const [selectedJanCodes, setSelectedJanCodes] = useState<Set<string>>(new Set());
  const [editingJanCode, setEditingJanCode] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProductRow | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string | null; direction: "asc" | "desc" }>({ key: null, direction: "asc" });
  const [searchTerm, setSearchTerm] = useState("");
  const [saving, setSaving] = useState(false);
  const [isInferring, setIsInferring] = useState(false); 
  const csvInputRef = useRef<HTMLInputElement>(null);

  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch("/api/products");
      if (res.ok) {
        // ▼ ここで1回だけ res.json() を読み込んで data に保存します
        const data = (await res.json()) as ProductRow[]; 
        
        // ▼▼▼ テスト検証用コード ▼▼▼
        const testJan = '0840356853925'; // ←ここに表示されないJANコードを入れてください
        const targetProduct = data.find((item) => item.jan_code === testJan);
        console.log('--- フロントエンド検証用 ---');
        console.log('APIから届いた全件数:', data.length);
        console.log('探している商品:', targetProduct || 'APIから届いていません！');
        console.log('-------------------');
        // ▲▲▲ ここまで ▲▲▲

        // ▼ さきほど保存した data をそのままセットします（ここで res.json() と書くとエラーになります）
        setRows(data);
      }
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
    if (t)
      list = list.filter((r) =>
        [r.jan_code, r.brand ?? "", r.product_name, r.model_number ?? ""].some((v) => v.toLowerCase().includes(t))
      );
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
// 🌟 追加：JANコードからAIで商品情報を引っ張ってくる関数
const handleJanCodeCheck = async (jan: string) => {
  const trimmed = jan.trim();
  if (!trimmed) return;
  
  setIsInferring(true);
  try {
    const res = await fetch("/api/infer-jan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jan: trimmed }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.productName) setProductName(data.productName);
      if (data.brand) setBrand(data.brand);
      if (data.modelNumber) setModelNumber(data.modelNumber);
    }
  } catch (e) {
    console.error("AI取得エラー:", e);
  } finally {
    setIsInferring(false);
  }
};
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!janCode.trim() || !productName.trim()) {
      alert("JANコードと商品名は必須です");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jan_code: janCode.trim(),
          brand: brand.trim() || null,
          product_name: productName.trim(),
          model_number: modelNumber.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "登録に失敗しました");
      }
      setJanCode("");
      setBrand("");
      setProductName("");
      setModelNumber("");
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
    const h = "jan_code,brand,product_name,model_number,created_at";
    const lines = processedRows.map((r) =>
      [r.jan_code, r.brand ?? "", r.product_name, r.model_number ?? "", r.created_at].map(escapeCsv).join(",")
    );
    const blob = new Blob(["\uFEFF" + [h, ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `products_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const parseCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") {
          out.push(cur);
          cur = "";
        } else cur += c;
      }
    }
    out.push(cur);
    return out;
  };

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSaving(true);
    try {
      const text = await file.text();
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        alert("CSVにデータ行がありません");
        return;
      }
      const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
      const idx = (name: string) => header.indexOf(name);
      const iJan = idx("jan_code");
      const iName = idx("product_name");
      if (iJan < 0 || iName < 0) {
        alert("CSVの1行目に jan_code と product_name の列が必要です");
        return;
      }
      const iBrand = idx("brand");
      const iModel = idx("model_number");
      const rowObjs: Record<string, unknown>[] = [];
      for (let r = 1; r < lines.length; r++) {
        const cols = parseCsvLine(lines[r]);
        const jan_code = (cols[iJan] ?? "").trim();
        const product_name = (cols[iName] ?? "").trim();
        if (!jan_code || !product_name) continue;
        const o: Record<string, unknown> = { jan_code, product_name };
        if (iBrand >= 0) o.brand = (cols[iBrand] ?? "").trim() || null;
        if (iModel >= 0) o.model_number = (cols[iModel] ?? "").trim() || null;
        rowObjs.push(o);
      }
      if (rowObjs.length === 0) {
        alert("取り込める行がありません");
        return;
      }
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowObjs }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "CSV取込に失敗しました");
      }
      await fetchRows();
      alert(`${rowObjs.length} 件取り込みました`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "CSV取込に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const executeDelete = async () => {
    if (selectedJanCodes.size === 0 || !confirm(`${selectedJanCodes.size} 件削除しますか？`)) return;
    setSaving(true);
    try {
      const res = await fetch("/api/products", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jan_codes: Array.from(selectedJanCodes) }),
      });
      if (!res.ok) throw new Error("削除に失敗しました");
      setSelectedJanCodes(new Set());
      await fetchRows();
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editDraft) return;
    if (!editDraft.product_name.trim()) {
      alert("商品名は必須です");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/products", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jan_code: editDraft.jan_code,
          brand: editDraft.brand,
          product_name: editDraft.product_name.trim(),
          model_number: editDraft.model_number,
        }),
      });
      if (!res.ok) throw new Error("更新に失敗しました");
      setEditingJanCode(null);
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
          <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 shrink-0">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <DocumentIcon className="h-5 w-5 text-primary" />
              商品マスター管理
            </h2>
          </div>

          {/* 新規登録フォーム：PCは横1列、スマホは縦積み */}
          <div className="p-6 border-b border-slate-100 shrink-0">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">新規登録</h3>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
              <div className="w-full lg:flex-1 lg:min-w-0">
                <label className="text-xs font-semibold text-slate-500 block mb-1">JANコード（必須）</label>
                <input 
                  value={janCode} 
                  onChange={(e) => setJanCode(e.target.value)} 
                  onBlur={() => handleJanCodeCheck(janCode)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault(); // 勝手に保存されるのを防ぐ
                      handleJanCodeCheck(janCode);
                    }
                  }}
                  className={inputClass} 
                  required 
                />
              </div>
              <div className="w-full lg:flex-1 lg:min-w-0">
                <label className="text-xs font-semibold text-slate-500 block mb-1">ブランド（任意）</label>
                <input value={brand} onChange={(e) => setBrand(e.target.value)} disabled={isInferring} className={inputClass} />
              </div>
              <div className="w-full lg:flex-1 lg:min-w-0">
                <label className="text-xs font-semibold text-slate-500 block mb-1">商品名（必須）</label>
                <input 
                  value={productName} 
                  onChange={(e) => setProductName(e.target.value)} 
                  disabled={isInferring} 
                  placeholder={isInferring ? "AIで商品情報を検索中..." : ""}
                  className={inputClass} 
                  required 
                />
              </div>
              <div className="w-full lg:flex-1 lg:min-w-0">
                <label className="text-xs font-semibold text-slate-500 block mb-1">型番（任意）</label>
                <input value={modelNumber} onChange={(e) => setModelNumber(e.target.value)} disabled={isInferring} className={inputClass} />
              </div>
              <div className="w-full lg:w-auto lg:flex-shrink-0">
                <label className="text-xs font-semibold text-slate-500 block mb-1 lg:invisible lg:pointer-events-none">登録</label>
                <button type="submit" disabled={saving || isInferring} className={`${buttonClass} w-full lg:w-auto bg-primary text-white hover:bg-primary/90`}>
                  {saving ? "保存中..." : isInferring ? "検索中..." : "登録"}
                </button>
              </div>
            </form>
          </div>

          {/* リストツールバー（CSV取込は空一覧時も利用可能） */}
          {!loading && (
            <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white shrink-0">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedJanCodes.size === processedRows.length && processedRows.length > 0}
                    onChange={() =>
                      selectedJanCodes.size >= processedRows.length
                        ? setSelectedJanCodes(new Set())
                        : setSelectedJanCodes(new Set(processedRows.map((r) => r.jan_code)))
                    }
                    className="rounded border-slate-300 text-primary"
                  />
                  全選択
                </label>
                <button type="button" onClick={executeDelete} disabled={selectedJanCodes.size === 0 || saving} className={`${buttonClass} bg-white text-slate-700 border border-slate-200 disabled:opacity-50`}>
                  削除
                </button>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <div className="relative rounded-lg border border-slate-200 bg-white shadow-sm max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="検索..." className={`${inputClass} pl-10 border-0 focus-visible:ring-0 rounded-lg`} />
                </div>
                <input type="file" accept=".csv" ref={csvInputRef} className="hidden" onChange={handleCsvImport} />
                <button type="button" onClick={() => csvInputRef.current?.click()} disabled={saving} className={`${buttonClass} bg-white text-slate-700 border border-slate-200 disabled:opacity-50`}>
                  <Upload className="mr-2 h-4 w-4" />
                  CSV取込
                </button>
                <button type="button" onClick={handleCsvExport} className={`${buttonClass} bg-white text-slate-700 border border-slate-200`}>
                  <Download className="mr-2 h-4 w-4" />
                  CSV出力
                </button>
              </div>
            </div>
          )}

          <div className="p-6">
            {loading && <p className="text-sm text-slate-500 py-8 text-center">読み込み中...</p>}
            {!loading && rows.length === 0 && <p className="text-sm text-slate-400 py-8 text-center">商品を登録してください</p>}
            {!loading && rows.length > 0 && (
              <div className="relative w-full max-h-[calc(100vh-280px)] overflow-y-auto border border-slate-200 rounded-md">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left min-w-[600px]">
                    <thead className="sticky top-0 z-10 bg-white border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold shadow-sm">
                    <tr>
                      <th className="px-6 py-4 w-10"></th>
                      <th className="px-6 py-4">
                        <SortBtn k="jan_code">JANコード</SortBtn>
                      </th>
                      <th className="px-6 py-4">
                        <SortBtn k="brand">ブランド</SortBtn>
                      </th>
                      <th className="px-6 py-4">
                        <SortBtn k="product_name">商品名</SortBtn>
                      </th>
                      <th className="px-6 py-4">
                        <SortBtn k="model_number">型番</SortBtn>
                      </th>
                      <th className="px-6 py-4 w-24 text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {processedRows.map((row) => (
                      <tr key={row.jan_code} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4">
                          <input
                            type="checkbox"
                            checked={selectedJanCodes.has(row.jan_code)}
                            onChange={() =>
                              setSelectedJanCodes((p) => {
                                const n = new Set(p);
                                if (n.has(row.jan_code)) n.delete(row.jan_code);
                                else n.add(row.jan_code);
                                return n;
                              })
                            }
                            className="rounded border-slate-300 text-primary"
                          />
                        </td>
                        <td className="px-6 py-4">{row.jan_code}</td>
                        <td className="px-6 py-4">
                          {editingJanCode === row.jan_code && editDraft ? (
                            <input value={editDraft.brand ?? ""} onChange={(e) => setEditDraft({ ...editDraft, brand: e.target.value || null })} className={`${inputClass} h-9`} />
                          ) : (
                            row.brand ?? "—"
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editingJanCode === row.jan_code && editDraft ? (
                            <input value={editDraft.product_name} onChange={(e) => setEditDraft({ ...editDraft, product_name: e.target.value })} className={`${inputClass} h-9`} />
                          ) : (
                            row.product_name
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editingJanCode === row.jan_code && editDraft ? (
                            <input value={editDraft.model_number ?? ""} onChange={(e) => setEditDraft({ ...editDraft, model_number: e.target.value || null })} className={`${inputClass} h-9`} />
                          ) : (
                            row.model_number ?? "—"
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {editingJanCode === row.jan_code ? (
                            <div className="flex justify-center gap-1">
                              <button type="button" onClick={saveEdit} className={`${buttonClass} h-9 px-2 bg-primary text-white`}>
                                <Save className="h-4 w-4" />
                              </button>
                              <button type="button" onClick={() => { setEditingJanCode(null); setEditDraft(null); }} className={`${buttonClass} h-9 px-2 bg-white border border-slate-200`}>
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ) : (
                            <button type="button" onClick={() => { setEditingJanCode(row.jan_code); setEditDraft({ ...row }); }} className={`${buttonClass} h-9 px-2 bg-white border border-slate-200`}>
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
