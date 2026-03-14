"use client";

import AmazonReconcileManager from "@/components/AmazonReconcileManager";
import { PackageCheck } from "lucide-react";

export default function AmazonReconcilePage() {
  return (
    <main className="flex-1 py-8 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3 mb-8">
        <div className="rounded-xl bg-primary/10 p-3 text-primary">
          <PackageCheck className="h-8 w-8" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Amazon 注文消込</h1>
          <p className="text-sm text-slate-500">自動消込の実行と手動確認対象のマッチング</p>
        </div>
      </div>
      <AmazonReconcileManager />
    </main>
  );
}
