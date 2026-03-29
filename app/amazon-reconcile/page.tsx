"use client";

import Link from "next/link";
import AmazonReconcileManager from "@/components/AmazonReconcileManager";
import { PackageCheck, FileSpreadsheet } from "lucide-react";

export default function AmazonReconcilePage() {
  return (
    <main className="flex-1 py-8 w-full max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-10">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <PackageCheck className="h-8 w-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Amazon 注文消込</h1>
            <p className="text-sm text-slate-500">自動消込の実行と手動確認対象のマッチング</p>
          </div>
        </div>
        <Link
          href="/amazon-listing-report"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 hover:border-slate-300 transition-colors shrink-0"
        >
          <FileSpreadsheet className="h-4 w-4 text-primary" />
          出品レポートで辞書更新
        </Link>
      </div>
      <AmazonReconcileManager />
    </main>
  );
}
