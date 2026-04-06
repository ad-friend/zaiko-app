"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, ArrowLeft, AlertTriangle } from "lucide-react";

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function AmazonListingReportPage() {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    ok: boolean;
    upserted: number;
    deletedStale: number;
    parseErrors?: string[];
  } | null>(null);

  const parseWarningSummary = useMemo(() => {
    if (!result?.parseErrors?.length) return null;
    return `パース警告 ${result.parseErrors.length} 件（先頭のみサーバーが返却）`;
  }, [result?.parseErrors]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setResult(null);
    setSelectedFileName(file.name);
    setBusy(true);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/amazon/sync-sku-conditions", {
        method: "POST",
        body: form,
      });

      const data = (await res.json()) as {
        error?: string;
        ok?: boolean;
        upserted?: number;
        deletedStale?: number;
        parseErrors?: string[];
      };

      if (!res.ok) {
        setError(data?.error ?? "アップロードに失敗しました");
        setResult(null);
        return;
      }

      setResult({
        ok: true,
        upserted: data.upserted ?? 0,
        deletedStale: data.deletedStale ?? 0,
        parseErrors: data.parseErrors,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "アップロードに失敗しました");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  return (
    <main className="flex-1 py-8 w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <div className="flex flex-wrap items-start gap-4">
          <Link
            href="/amazon-reconcile"
            className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            Amazon 注文消込へ戻る
          </Link>
        </div>

        <div className="flex items-center gap-3 mb-2">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <FileSpreadsheet className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">出品レポート・アップロード</h1>
            <p className="text-sm text-slate-500">
              セラーセントラルの「出品詳細レポート（Active Listings）」TSV でコンディション辞書（
              <code className="text-xs bg-slate-100 px-1 rounded">amazon_sku_conditions</code>
              ）を更新します
            </p>
          </div>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">ファイル選択</h2>
          <p className="text-sm text-slate-600 mb-4">
            必須列: <span className="font-mono">seller-sku</span>（出品者SKU）と、ASIN 列（
            <span className="font-mono">asin1</span> / <span className="font-mono">商品ID</span> など）。
            <br />
            コンディション列（<span className="font-mono">item-condition</span> / コンディション）がある場合: 11
            は新品（New）、それ以外は中古（Used）。<strong>列が無いレポートは全行 New</strong> として保存します。
            <br />
            日次の自動取得は SP-API の出品詳細相当（<span className="font-mono">GET_MERCHANT_LISTINGS_ALL_DATA</span>
            ・en_US）です。コンディション列が無い場合も同様に全行 New です。
            <br />
            処理の最後に、最終更新から 2 ヶ月以上経過した行を自動削除します。
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <input
                type="file"
                accept=".tsv,.txt,.tab,.csv"
                onChange={handleFileChange}
                disabled={busy}
                className="block w-full text-sm text-slate-700"
              />
              {selectedFileName && <p className="mt-2 text-xs text-slate-500">選択: {selectedFileName}</p>}
            </div>
            <div className="shrink-0">
              <button
                type="button"
                disabled
                className={`${buttonClass} bg-slate-100 text-slate-400 border border-slate-200`}
                title="ファイル選択後、自動でアップロードします"
              >
                {busy ? "送信中..." : "自動アップロード"}
              </button>
            </div>
          </div>

          {busy && (
            <p className="mt-3 text-sm font-medium text-primary" aria-live="polite">
              サーバーへ送信中...
            </p>
          )}

          {error && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">結果</h2>

          {!result ? (
            <p className="text-sm text-slate-500">ファイルを選択すると結果が表示されます。</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 bg-emerald-50/60 p-4">
                <p className="font-medium text-emerald-800">同期完了</p>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-emerald-900">
                  <span>辞書を更新: {result.upserted} 件</span>
                  <span>古い行を削除: {result.deletedStale} 件</span>
                </div>
              </div>
              {result.parseErrors && result.parseErrors.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-900">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-800" />
                    <div>
                      <p className="font-medium">パース時の注意</p>
                      <p className="mt-1 text-xs opacity-90">{parseWarningSummary}</p>
                      <ul className="mt-2 list-disc pl-5 space-y-1 text-xs">
                        {result.parseErrors.slice(0, 5).map((msg, i) => (
                          <li key={i}>{msg}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
