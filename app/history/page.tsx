"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  );
}

export default function HistoryPage() {
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRecords() {
      try {
        const res = await fetch("/api/records");
        if (!res.ok) throw new Error("取得に失敗しました");
        const data = await res.json();
        setRows(data);
      } catch (e: any) {
        setError(e.message ?? "エラーが発生しました");
      } finally {
        setLoading(false);
      }
    }
    fetchRecords();
  }, []);

  const formatDate = (iso: string) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      return iso;
    }
  };

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
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 h-10 px-4 py-2 shadow-sm bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300"
            >
              <ChevronLeftIcon className="mr-2 h-4 w-4" />
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {rows.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-4 text-slate-600 whitespace-nowrap">{formatDate(row.header?.created_at ?? row.created_at)}</td>
                        <td className="px-6 py-4 text-slate-700">{row.header?.supplier ?? "—"}</td>
                        <td className="px-6 py-4 text-slate-600">{row.header?.genre ?? "—"}</td>
                        <td className="px-6 py-4 font-mono text-xs">{row.jan_code ?? "—"}</td>
                        <td className="px-6 py-4 font-medium text-slate-900">{row.product_name ?? "—"}</td>
                        <td className="px-6 py-4 text-slate-600">{row.brand ?? "—"}</td>
                        <td className="px-6 py-4 text-slate-600">{row.model_number ?? "—"}</td>
                        <td className="px-6 py-4 text-right tabular-nums">{row.base_price > 0 ? row.base_price.toLocaleString() : "—"} 円</td>
                        <td className="px-6 py-4 text-right font-medium tabular-nums">{row.effective_unit_price > 0 ? Math.round(row.effective_unit_price).toLocaleString() : "—"} 円</td>
                        <td className="px-6 py-4 text-slate-600">{row.condition_type === "new" ? "新品" : row.condition_type === "used" ? "中古" : row.condition_type ?? "—"}</td>
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
