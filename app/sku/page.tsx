"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

const PLATFORMS = [
  { value: "Amazon", label: "Amazon" },
  { value: "Yahoo", label: "Yahoo" },
  { value: "Mercari", label: "Mercari" },
  { value: "Rakuten", label: "Rakuten" },
  { value: "その他", label: "その他" },
] as const;

type ProductInfo = {
  product_name: string;
  brand: string | null;
  model_number: string | null;
} | null;

type ListItem = {
  jan_code: string;
  quantity: number;
  product_name: string;
  brand: string;
  model_number: string;
};

const inputClass =
  "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

function PackageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

function BarcodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m-4-8v8m8-8v8M4 4h2v16H4V4zm14 0h2v16h-2V4zM8 4h1v16H8V4zm6 0h1v16h-1V4z" />
    </svg>
  );
}

export default function SkuPage() {
  const [sku, setSku] = useState("");
  const [platform, setPlatform] = useState<string>(PLATFORMS[0].value);
  const [janInput, setJanInput] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [productInfo, setProductInfo] = useState<ProductInfo>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [list, setList] = useState<ListItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const lookupProduct = useCallback(async (jan: string) => {
    const trimmed = jan.replace(/\D/g, "");
    if (trimmed.length !== 13) {
      setProductInfo(null);
      return;
    }
    setProductLoading(true);
    setProductInfo(null);
    try {
      const res = await fetch(`/api/products?jan=${encodeURIComponent(trimmed)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === "object" && data.jan_code) {
          setProductInfo({
            product_name: data.product_name ?? "",
            brand: data.brand ?? null,
            model_number: data.model_number ?? null,
          });
        } else {
          setProductInfo(null);
        }
      } else {
        setProductInfo(null);
      }
    } catch {
      setProductInfo(null);
    } finally {
      setProductLoading(false);
    }
  }, []);

  const handleJanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = (e.target as HTMLInputElement).value.trim().replace(/\D/g, "");
    if (raw.length !== 13) return;
    addToList(raw);
    setJanInput("");
    setProductInfo(null);
  };

  const handleJanBlur = () => {
    const raw = janInput.trim().replace(/\D/g, "");
    if (raw.length === 13) lookupProduct(raw);
  };

  const addToList = (janCode?: string) => {
    const jan = (janCode ?? janInput.trim().replace(/\D/g, "")).trim();
    if (!jan || jan.length !== 13) {
      setErrorMessage("JANコードは13桁で入力してください。");
      return;
    }
    if (list.some((item) => item.jan_code === jan)) {
      setErrorMessage("同じJANは既にリストに含まれています。");
      return;
    }
    const product_name = productInfo?.product_name ?? "";
    const brand = productInfo?.brand ?? "";
    const model_number = productInfo?.model_number ?? "";
    setList((prev) => [...prev, { jan_code: jan, quantity, product_name, brand, model_number }]);
    setJanInput("");
    setProductInfo(null);
    setQuantity(1);
    setErrorMessage(null);
  };

  const removeFromList = (index: number) => {
    setList((prev) => prev.filter((_, i) => i !== index));
    setErrorMessage(null);
  };

  const handleRegister = useCallback(async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    const skuTrimmed = sku.trim();
    if (!skuTrimmed) {
      setErrorMessage("SKUを入力してください。");
      return;
    }
    if (!platform) {
      setErrorMessage("プラットフォームを選択してください。");
      return;
    }
    if (list.length === 0) {
      setErrorMessage("JANを1件以上リストに追加してください。");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/sku-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: skuTrimmed,
          platform,
          items: list.map((item) => ({ jan_code: item.jan_code, quantity: item.quantity })),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data.error ?? "登録に失敗しました。";
        setErrorMessage(msg);
        return;
      }

      setSuccessMessage(`${data.count ?? list.length} 件をSKUマスターに登録しました。`);
      setSku("");
      setPlatform(PLATFORMS[0].value);
      setList([]);
      setJanInput("");
      setProductInfo(null);
      setQuantity(1);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }, [sku, platform, list]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-30 w-full border-b bg-white/80 backdrop-blur-md shadow-sm">
        <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 text-slate-900 hover:opacity-80 transition-opacity">
              <div className="rounded-lg bg-primary p-1.5 text-white shadow-md shadow-primary/30">
                <BarcodeIcon className="h-5 w-5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                Zaiko Manager <span className="text-xs font-normal text-slate-500 ml-2 bg-slate-100 px-2 py-0.5 rounded-full">Professional</span>
              </h1>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/history" className="text-sm font-medium text-slate-500 hover:text-primary transition-colors">
              在庫一覧
            </Link>
            <Link href="/suppliers" className="text-sm font-medium text-slate-500 hover:text-primary transition-colors">
              仕入先管理
            </Link>
            <Link href="/products" className="text-sm font-medium text-slate-500 hover:text-primary transition-colors">
              商品マスタ
            </Link>
            <Link href="/sku" className="text-sm font-medium text-primary">
              SKUマスター
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 py-8 w-full max-w-7xl mx-auto">
        <div className="px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-12 items-start">
            {/* 左ペイン: 共通項目（SKU情報） */}
            <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-24">
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
                <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
                  <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                    <PackageIcon className="h-5 w-5 text-primary" />
                    SKU情報
                  </h2>
                </div>
                <div className="p-6 space-y-5">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">SKU</label>
                    <input
                      type="text"
                      value={sku}
                      onChange={(e) => setSku(e.target.value)}
                      placeholder="ECサイトのSKUを入力"
                      className={inputClass}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">プラットフォーム</label>
                    <select
                      value={platform}
                      onChange={(e) => setPlatform(e.target.value)}
                      className={inputClass}
                    >
                      {PLATFORMS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* 右ペイン: 個別項目（JANリスト作成） */}
            <div className="lg:col-span-8 space-y-6">
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
                <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
                  <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                    <BarcodeIcon className="h-5 w-5 text-primary" />
                    紐付けるJANの登録
                  </h2>
                </div>
                <div className="p-6 space-y-5">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">JANコード</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={janInput}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 13);
                        setJanInput(v);
                        if (v.length === 13) lookupProduct(v);
                        else setProductInfo(null);
                      }}
                      onBlur={handleJanBlur}
                      onKeyDown={handleJanKeyDown}
                      placeholder="13桁のJANを入力してEnterで追加"
                      className={inputClass}
                      autoComplete="off"
                    />
                    {productLoading && <p className="mt-1 text-xs text-slate-500">商品マスタを検索中...</p>}
                    {productInfo && !productLoading && (
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-sm space-y-1">
                        <div className="font-medium text-slate-800">商品名: {productInfo.product_name || "—"}</div>
                        <div className="text-slate-600">ブランド: {productInfo.brand || "—"}</div>
                        <div className="text-slate-600">型番: {productInfo.model_number || "—"}</div>
                      </div>
                    )}
                    {janInput.replace(/\D/g, "").length === 13 && !productLoading && !productInfo && (
                      <p className="mt-1 text-xs text-amber-600">商品マスタに未登録のJANです。そのまま追加できます。</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">構成数</label>
                    <input
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => addToList()}
                    className={`${buttonClass} bg-white text-primary border border-primary/20 hover:bg-primary/5`}
                  >
                    リストに追加
                  </button>
                </div>
              </div>

              {/* 登録リストプレビューと保存 */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
                  <h2 className="text-base font-bold text-slate-800">登録リストプレビュー</h2>
                </div>
                <div className="p-6">
                  {list.length === 0 ? (
                    <p className="text-sm text-slate-400 py-6">リストにJANを追加するとここに表示されます。</p>
                  ) : (
                    <>
                      <div className="overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full text-sm text-left">
                          <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold">
                            <tr>
                              <th className="px-4 py-3 whitespace-nowrap">JAN</th>
                              <th className="px-4 py-3 min-w-[180px]">商品名</th>
                              <th className="px-4 py-3 whitespace-nowrap text-right">構成数</th>
                              <th className="px-4 py-3 w-[80px] text-center">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {list.map((item, idx) => (
                              <tr key={`${item.jan_code}-${idx}`} className="bg-white">
                                <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{item.jan_code}</td>
                                <td className="px-4 py-3 text-slate-800">{item.product_name || "—"}</td>
                                <td className="px-4 py-3 text-right tabular-nums">{item.quantity}</td>
                                <td className="px-4 py-3 text-center">
                                  <button
                                    type="button"
                                    onClick={() => removeFromList(idx)}
                                    className="text-slate-400 hover:text-red-600 text-xs"
                                  >
                                    削除
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="mt-4 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleRegister}
                          disabled={submitting}
                          className={`${buttonClass} bg-primary text-white hover:bg-primary/90 disabled:opacity-50`}
                        >
                          {submitting ? "登録中..." : "SKUマスターに登録"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {errorMessage && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  {errorMessage}
                </div>
              )}
              {successMessage && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                  {successMessage}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
