"use client";

import { useCallback, useEffect, useState } from "react";
import { Package, ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react";

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

type SkuMappingRow = {
  id: number;
  sku: string;
  title: string | null;
  platform: string;
  jan_code: string;
  quantity: number;
  created_at: string;
};

const inputClass =
  "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function SkuPage() {
  const [sku, setSku] = useState("");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<string>(PLATFORMS[0].value);
  const [janInput, setJanInput] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [productInfo, setProductInfo] = useState<ProductInfo>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [list, setList] = useState<ListItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [mappings, setMappings] = useState<SkuMappingRow[]>([]);
  const [productsByJan, setProductsByJan] = useState<Record<string, { product_name: string; brand: string | null; model_number: string | null }>>({});
  const [loadingMappings, setLoadingMappings] = useState(true);
  const [openAccordionSku, setOpenAccordionSku] = useState<string | null>(null);

  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState("");

  const handleSaveTitle = async (skuToUpdate: string) => {
    try {
      const res = await fetch("/api/sku-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: skuToUpdate, title: editTitleDraft }),
      });

      if (!res.ok) throw new Error("更新失敗");

      setEditingSku(null);
      fetchMappingsAndProducts();
    } catch (error) {
      console.error("更新エラー:", error);
      alert("更新に失敗しました。API側にPUTメソッドが用意されているか確認してください。");
    }
  };

  const fetchMappingsAndProducts = useCallback(async () => {
    setLoadingMappings(true);
    try {
      const [mapRes, prodRes] = await Promise.all([fetch("/api/sku-mappings"), fetch("/api/products")]);
      if (mapRes.ok) {
        const data = await mapRes.json();
        setMappings(Array.isArray(data) ? data : []);
      }
      if (prodRes.ok) {
        const prods = await prodRes.json();
        const byJan: Record<string, { product_name: string; brand: string | null; model_number: string | null }> = {};
        (prods ?? []).forEach((p: { jan_code: string; product_name?: string; brand?: string | null; model_number?: string | null }) => {
          byJan[p.jan_code] = { product_name: p.product_name ?? "", brand: p.brand ?? null, model_number: p.model_number ?? null };
        });
        setProductsByJan(byJan);
      }
    } catch {
      setMappings([]);
    } finally {
      setLoadingMappings(false);
    }
  }, []);

  useEffect(() => {
    fetchMappingsAndProducts();
  }, [fetchMappingsAndProducts]);

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
          title: title.trim() || undefined,
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
      setTitle("");
      setPlatform(PLATFORMS[0].value);
      setList([]);
      setJanInput("");
      setProductInfo(null);
      setQuantity(1);
      await fetchMappingsAndProducts();
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }, [sku, title, platform, list, fetchMappingsAndProducts]);

  const groupedBySku = (() => {
    const map = new Map<string, SkuMappingRow[]>();
    for (const row of mappings) {
      const key = `${row.sku}\t${row.platform}\t${row.title ?? ""}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return Array.from(map.entries()).map(([key, rows]) => {
      const [skuKey, platformKey, titleKey] = key.split("\t");
      return { groupKey: key, sku: skuKey, platform: platformKey, title: titleKey || null, rows };
    });
  })();

  return (
    <div className="h-[calc(100vh-64px)] flex flex-col bg-slate-50">
      <div 
        className="w-full max-w-[1500px] flex flex-col flex-1 overflow-hidden p-4 md:p-6 gap-6 mx-auto"
        style={{ margin: "0 auto" }}
      >
        {/* 上部エリア: 入力フォーム（固定・スクロールさせない） */}
        <div className="flex flex-col lg:flex-row gap-6 shrink-0">
          {/* 左ペイン: 共通項目（幅固定） */}
          <div className="w-full lg:w-[320px] shrink-0 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
                <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <Package className="h-4 w-4 text-primary" />
                  SKU情報
                </h2>
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block uppercase tracking-wide">SKU</label>
                  <input
                    type="text"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="ECサイトのSKU"
                    className={inputClass}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block uppercase tracking-wide">タイトル</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="商品セット名など"
                    className={inputClass}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block uppercase tracking-wide">プラットフォーム</label>
                  <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={inputClass}>
                    {PLATFORMS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

          {/* 右ペイン: 個別項目（残り幅をすべて使用） */}
          <div className="flex-1 min-w-0 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
                <h2 className="text-sm font-bold text-slate-800">紐付けるJANの登録</h2>
                <div className="flex flex-wrap gap-4 items-end">
                  <div className="flex-1 min-w-[200px]">
                    <label className="text-xs font-semibold text-slate-500 mb-1 block">JANコード</label>
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
                      placeholder="13桁入力してEnterで追加"
                      className={inputClass}
                      autoComplete="off"
                    />
                  </div>
                  <div className="w-24">
                    <label className="text-xs font-semibold text-slate-500 mb-1 block">構成数</label>
                    <input
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                      className={inputClass}
                    />
                  </div>
                  <button type="button" onClick={() => addToList()} className={`${buttonClass} bg-primary text-white hover:bg-primary/90 shrink-0`}>
                    リストに追加
                  </button>
                </div>
                {productLoading && <p className="text-xs text-slate-500">商品マスタを検索中...</p>}
                {productInfo && !productLoading && (
                  <div className="rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">
                    商品名: {productInfo.product_name || "—"} / ブランド: {productInfo.brand || "—"} / 型番: {productInfo.model_number || "—"}
                  </div>
                )}
                {janInput.replace(/\D/g, "").length === 13 && !productLoading && !productInfo && (
                  <p className="text-xs text-amber-600">商品マスタに未登録のJANです。そのまま追加できます。</p>
                )}
              </div>

              {/* 追加済みアイテムを縦並びリスト表示 */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-slate-700">登録リストプレビュー</span>
                  {list.length > 0 && (
                    <button
                      type="button"
                      onClick={handleRegister}
                      disabled={submitting}
                      className={`${buttonClass} bg-primary text-white hover:bg-primary/90 disabled:opacity-50 text-sm h-9 px-4`}
                    >
                      {submitting ? "登録中..." : "SKUマスターに登録"}
                    </button>
                  )}
                </div>
                {list.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4">JANを追加するとここに表示されます。</p>
                ) : (
                  <ul className="space-y-2">
                    {list.map((item, idx) => (
                      <li
                        key={`${item.jan_code}-${idx}`}
                        className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg bg-slate-50 border border-slate-100"
                      >
                        <span className="font-mono text-xs text-slate-600">{item.jan_code}</span>
                        <span className="flex-1 min-w-0 truncate text-sm text-slate-800">{item.product_name || "—"}</span>
                        <span className="text-sm tabular-nums text-slate-600">×{item.quantity}</span>
                        <button type="button" onClick={() => removeFromList(idx)} className="text-slate-400 hover:text-red-600 text-xs shrink-0">
                          削除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {errorMessage && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{errorMessage}</div>
              )}
              {successMessage && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{successMessage}</div>
              )}
          </div>
        </div>

        {/* 下部エリア: 登録済みデータ一覧（ここだけ独立してスクロール） */}
        <div className="flex-1 overflow-y-auto pr-2 bg-white rounded-lg shadow-sm border border-slate-200 p-4 min-h-0">
          <h2 className="text-base font-bold text-slate-800 mb-3 flex items-center gap-2 sticky top-0 bg-white pb-2 z-10">
            <Package className="h-4 w-4 text-primary" />
            登録済みSKU一覧
          </h2>
          {loadingMappings ? (
            <p className="text-sm text-slate-500 py-8">読み込み中...</p>
          ) : groupedBySku.length === 0 ? (
            <p className="text-sm text-slate-400 py-8">登録データがありません。</p>
          ) : (
            <div className="space-y-2">
              {groupedBySku.map((group) => {
                const isOpen = openAccordionSku === group.groupKey;
                const displayTitle = group.title && group.title.trim() ? group.title.trim() : "（タイトル未設定）";
                return (
                  <div key={group.groupKey} className="rounded-lg border border-slate-200 bg-slate-50/30 overflow-hidden">
                    <div
                      onClick={() => setOpenAccordionSku(isOpen ? null : group.groupKey)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left bg-slate-50/80 hover:bg-slate-100/80 border-b border-slate-100 cursor-pointer"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4 text-slate-500 shrink-0" /> : <ChevronRight className="h-4 w-4 text-slate-500 shrink-0" />}
                      
                      {editingSku === group.sku ? (
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editTitleDraft}
                            onChange={(e) => setEditTitleDraft(e.target.value)}
                            className="border border-slate-300 rounded px-2 py-1 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-primary text-slate-800"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleSaveTitle(group.sku); }}
                            className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setEditingSku(null); }}
                            className="p-1.5 bg-slate-400 text-white rounded hover:bg-slate-500 transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="font-medium text-slate-800 truncate">{displayTitle}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingSku(group.sku);
                              setEditTitleDraft(group.title || "");
                            }}
                            className="text-slate-400 hover:text-primary transition-colors p-1 shrink-0"
                            title="タイトルを編集"
                          >
                            <Pencil size={14} />
                          </button>
                        </div>
                      )}

                      <span className="text-xs text-slate-500 font-mono shrink-0 ml-auto">SKU: {group.sku}</span>
                      <span className="text-xs text-slate-500 shrink-0">{group.platform}</span>
                    </div>
                    {isOpen && (
                      <div className="p-4 bg-white">
                        <table className="w-full text-sm text-left">
                          <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold">
                            <tr>
                              <th className="px-3 py-2 whitespace-nowrap">JAN</th>
                              <th className="px-3 py-2 min-w-[160px]">商品名</th>
                              <th className="px-3 py-2 whitespace-nowrap text-right">構成数</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {group.rows.map((row) => {
                              const prod = productsByJan[row.jan_code];
                              return (
                                <tr key={row.id} className="bg-white">
                                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{row.jan_code}</td>
                                  <td className="px-3 py-2 text-slate-800">{prod?.product_name ?? "—"}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{row.quantity}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
