"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Pencil, Save, X, Trash2, Search } from "lucide-react";
import { normalizePartCode } from "@/lib/parts-catalog";

type PartRow = {
  code: string;
  name: string;
  brand: string | null;
  note: string | null;
  created_at?: string;
};

const inputClass =
  "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-1 rounded-md text-sm font-medium h-10 px-4 shadow-sm border transition-colors";

export default function PartsCatalogPage() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PartRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/parts-catalog");
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error || "取得に失敗しました");
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = (() => {
    const t = searchTerm.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.code, r.name, r.brand ?? "", r.note ?? ""].some((v) => v.toLowerCase().includes(t))
    );
  })();

  const handleCreate = async () => {
    const normalized = normalizePartCode(code);
    if (!normalized || !name.trim()) {
      setToast("コードと正式名称は必須です");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/parts-catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized, name: name.trim(), brand, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error || "保存に失敗しました");
        return;
      }
      setCode("");
      setName("");
      setBrand("");
      setNote("");
      setToast(`登録しました: ${normalized}`);
      await fetchRows();
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editDraft || !editingCode) return;
    setSaving(true);
    try {
      const res = await fetch("/api/parts-catalog", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: editingCode,
          name: editDraft.name,
          brand: editDraft.brand,
          note: editDraft.note,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error || "更新に失敗しました");
        return;
      }
      setEditingCode(null);
      setEditDraft(null);
      setToast("更新しました");
      await fetchRows();
    } finally {
      setSaving(false);
    }
  };

  const removeRow = async (c: string) => {
    if (!confirm(`パーツコード ${c} を削除しますか？（在庫は消えません）`)) return;
    const res = await fetch("/api/parts-catalog", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codes: [c] }),
    });
    const data = await res.json();
    if (!res.ok) {
      setToast(data.error || "削除に失敗しました");
      return;
    }
    setToast("削除しました");
    await fetchRows();
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900">パーツマスタ</h2>
        <p className="mt-1 text-sm text-slate-600">
          コードで名称を固定します（例: <code className="rounded bg-slate-100 px-1">PS4-RIBBON-12P</code>）。
          入庫時はこのコードを選ぶと正式名称が入ります。
        </p>
      </div>

      {toast ? (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{toast}</div>
      ) : null}

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">新規登録</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">パーツコード *</label>
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PS4-RIBBON-12P"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-500">正式名称 *</label>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="PS4コントローラ用リボンケーブル 12ピン"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">ブランド</label>
            <input className={inputClass} value={brand} onChange={(e) => setBrand(e.target.value)} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="mb-1 block text-xs font-medium text-slate-500">メモ</label>
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              disabled={saving}
              onClick={handleCreate}
              className={`${buttonClass} w-full border-primary bg-primary text-white hover:bg-primary/90`}
            >
              <Plus className="h-4 w-4" />
              登録
            </button>
          </div>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <Search className="h-4 w-4 text-slate-400" />
        <input
          className={`${inputClass} max-w-md`}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="コード・名称で検索"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">コード</th>
              <th className="px-3 py-2">正式名称</th>
              <th className="px-3 py-2">ブランド</th>
              <th className="px-3 py-2">メモ</th>
              <th className="px-3 py-2 w-28">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                  マスタがありません。上で登録してください。
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const isEdit = editingCode === r.code;
                return (
                  <tr key={r.code} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                    <td className="px-3 py-2">
                      {isEdit && editDraft ? (
                        <input
                          className={inputClass}
                          value={editDraft.name}
                          onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                        />
                      ) : (
                        r.name
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEdit && editDraft ? (
                        <input
                          className={inputClass}
                          value={editDraft.brand ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, brand: e.target.value })}
                        />
                      ) : (
                        r.brand || "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {isEdit && editDraft ? (
                        <input
                          className={inputClass}
                          value={editDraft.note ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })}
                        />
                      ) : (
                        r.note || "—"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEdit ? (
                        <div className="flex gap-1">
                          <button type="button" onClick={saveEdit} className="rounded bg-primary p-1.5 text-white" title="保存">
                            <Save className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCode(null);
                              setEditDraft(null);
                            }}
                            className="rounded border p-1.5"
                            title="取消"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCode(r.code);
                              setEditDraft({ ...r });
                            }}
                            className="rounded border p-1.5"
                            title="編集"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => removeRow(r.code)} className="rounded border p-1.5 text-rose-600" title="削除">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
