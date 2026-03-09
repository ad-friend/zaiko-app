"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Html5Qrcode } from "html5-qrcode";

// ----- 型定義 -----
type ProductCondition = "new" | "used";

type ProductRow = {
  id: string;
  jan: string;
  brand: string;
  productName: string;
  modelNumber: string;
  basePrice: number;
  quantity: number; // 数量を追加
  fixedUnitPrice: boolean;
  inferredByAi: boolean;
  condition: ProductCondition;
};

type HeaderInfo = {
  purchaseDate: string;
  supplier: string;
  genre: string;
  shipping: number;
  discount: number;
};

type ValidationError = {
  fixedTotalExceedsPurchase?: boolean;
  missingFields?: string[];
};

// 商品名からJAN（13桁以上の数字）を除去し、純粋な名称のみにする
function cleanseProductName(value: string): string {
  return value
    .replace(/\d{13,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 究極の按分計算ロジック（改訂版：チェックボックスの役割反転）
// チェックなし: 「基準価格」をそのまま採用（固定）
// チェックあり: チェック商品同士で「仕入総額」を按分
// 送料・割引: 全商品に加算
function calcEffectiveUnitPrice(
  row: ProductRow,
  totalPurchase: number,
  headerInfo: HeaderInfo,
  rows: ProductRow[]
): number {
  // ステップ1: 仕入総額の按分
  let baseUnitCost = 0;

  if (!row.fixedUnitPrice) {
    // チェックなし（通常）: 基準価格をそのまま原価とする
    baseUnitCost = row.basePrice;
  } else {
    // チェックあり（按分モード）:
    // (仕入総額 - チェックなし商品の基準価格合計) を チェックあり商品の基準価格比 で按分

    // 「チェックなし」商品の基準価格合計（数量考慮）
    const fixedTotal = rows
      .filter((r) => !r.fixedUnitPrice)
      .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);

    // 「チェックあり」商品の基準価格合計（数量考慮）
    const distributeBaseSum = rows
      .filter((r) => r.fixedUnitPrice)
      .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);
    
    // 按分対象額 = 仕入総額 - 固定額合計
    const distributablePurchase = totalPurchase - fixedTotal;

    if (distributeBaseSum > 0 && distributablePurchase > 0) {
      // 基準価格比で按分
      baseUnitCost = (distributablePurchase * row.basePrice) / distributeBaseSum;
    }
  }

  // ステップ2: 送料・割引の按分 (全商品対象・数量考慮なし=1商品あたりに加算)
  // 全商品の基準価格合計 (数量考慮)
  const totalBaseSum = rows.reduce((sum, r) => sum + r.basePrice * r.quantity, 0);
  
  const extraCost = headerInfo.shipping - headerInfo.discount;
  let allocatedExtra = 0;

  // 1個あたりの加算額
  if (totalBaseSum > 0 && extraCost !== 0) {
    allocatedExtra = (extraCost * row.basePrice) / totalBaseSum;
  }

  return baseUnitCost + allocatedExtra;
}

function validate(
  totalPurchase: number,
  headerInfo: HeaderInfo,
  rows: ProductRow[]
): ValidationError {
  const err: ValidationError = {};
  const totalCost = totalPurchase + headerInfo.shipping - headerInfo.discount;
  
  // バリデーションもロジック変更に合わせて修正
  // チェックなし商品の合計が仕入総額を超えていないかチェック
  const fixedTotal = rows
    .filter((r) => !r.fixedUnitPrice)
    .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);

  // 送料・割引を含めた総コストと比較するか、仕入総額単体と比較するかは要件次第だが、
  // ここでは「固定費が仕入総額を超えたらおかしい（按分原資がない）」としてチェック
  if (fixedTotal > totalPurchase) {
    err.fixedTotalExceedsPurchase = true;
  }
  const missing: string[] = [];
  rows.forEach((r, i) => {
    if (!r.jan.trim()) missing.push(`行${i + 1}: JAN`);
    if (r.basePrice <= 0 && !r.fixedUnitPrice) missing.push(`行${i + 1}: 基準価格`);
  });
  if (missing.length) err.missingFields = missing;
  return err;
}

function generateId() {
  return Math.random().toString(36).slice(2, 12);
}

export default function InboundPage() {
  // ヘッダー情報
  const [purchaseDate, setPurchaseDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [supplier, setSupplier] = useState<string>("");
  const [genre, setGenre] = useState<string>("");
  const [totalPurchase, setTotalPurchase] = useState<string>("");
  const [shipping, setShipping] = useState<string>("");
  const [discount, setDiscount] = useState<string>("");

  const [rows, setRows] = useState<ProductRow[]>([]);
  const [inferringJan, setInferringJan] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scannerReady, setScannerReady] = useState(false);
  const janInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const lastAddedIdRef = useRef<string | null>(null);
  
  // サジェスト用仕入先リスト
  const [supplierSuggestions, setSupplierSuggestions] = useState<string[]>([]);
  // 保存処理中フラグ
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 登録情報確認モーダル
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const totalNum = Number(totalPurchase) || 0;
  const shippingNum = Number(shipping) || 0;
  const discountNum = Number(discount) || 0;

  const headerInfo: HeaderInfo = {
    purchaseDate,
    supplier,
    genre,
    shipping: shippingNum,
    discount: discountNum
  };

  const validation = validate(totalNum, headerInfo, rows);

  // マウント時に仕入先リストを取得
  useEffect(() => {
    async function fetchSuppliers() {
      try {
        const res = await fetch("/api/suppliers");
        if (res.ok) {
          const data = await res.json();
          setSupplierSuggestions(data);
        }
      } catch (err) {
        console.error("Failed to load suppliers", err);
      }
    }
    fetchSuppliers();
  }, []);

  // 自動フォーカス
  useEffect(() => {
    if (!janInputRef.current) return;
    const timer = requestAnimationFrame(() => {
      janInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(timer);
  }, []);

  useEffect(() => {
    if (lastAddedIdRef.current) {
      janInputRef.current?.focus();
      lastAddedIdRef.current = null;
    }
  }, [rows]);

  // JAN入力時: まずDB検索 → データがない場合のみAI推論を起動（プロセス分離）
  const handleJanBlurOrEnter = useCallback(
    async (jan: string, rowId?: string) => {
      const trimmed = jan.trim().replace(/\D/g, "");
      if (trimmed.length !== 13) return;

      const target = rowId
        ? rows.find((r) => r.id === rowId)
        : null;

      if (target && (target.brand || target.productName || target.modelNumber)) {
        return;
      }

      let brand = "";
      let productName = "";
      let modelNumber = "";

      try {
        // ① まずDB検索のみ実行（AIは起動しない）
        const dbRes = await fetch("/api/infer-jan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jan: trimmed, dbOnly: true }),
        });
        if (dbRes.ok) {
          const dbData = await dbRes.json();
          if (dbData.source === "db") {
            // DBで解決 → 即反映し、AIプロセスは起動しない
            brand = cleanseProductName(dbData.brand ?? "");
            productName = cleanseProductName(dbData.productName ?? "");
            modelNumber = cleanseProductName(dbData.modelNumber ?? "");
            applyJanResult(trimmed, brand, productName, modelNumber, rowId);
            return;
          }
        }

        // ② DBにデータがないことが確定 → この時点で「AI推論中」を表示し、AIプロセス開始
        setInferringJan(trimmed);
        const res = await fetch("/api/infer-jan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jan: trimmed }),
        });
        if (res.ok) {
          const data = await res.json();
          brand = cleanseProductName(data.brand ?? "");
          productName = cleanseProductName(data.productName ?? "");
          modelNumber = cleanseProductName(data.modelNumber ?? "");
        }
        applyJanResult(trimmed, brand, productName, modelNumber, rowId);
      } catch (e) {
        console.warn("API Error, falling back to manual input", e);
        applyJanResult(trimmed, brand, productName, modelNumber, rowId);
      } finally {
        setInferringJan(null);
      }

      function applyJanResult(
        trimmed: string,
        brand: string,
        productName: string,
        modelNumber: string,
        rowId?: string
      ) {
        if (rowId) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === rowId
                ? {
                    ...r,
                    jan: r.jan || trimmed,
                    brand: r.brand || brand,
                    productName: r.productName || productName,
                    modelNumber: r.modelNumber || modelNumber,
                    inferredByAi: !!productName,
                  }
                : r
            )
          );
        } else {
          setRows((prev) => {
            const last = prev[prev.length - 1];
            if (last && !last.jan && !last.brand && !last.productName) {
              return prev.map((r, i) =>
                i === prev.length - 1
                  ? {
                      ...r,
                      jan: trimmed,
                      brand,
                      productName,
                      modelNumber,
                      inferredByAi: !!productName,
                    }
                  : r
              );
            }
            const newRow: ProductRow = {
              id: generateId(),
              jan: trimmed,
              brand,
              productName,
              modelNumber,
              basePrice: 0,
              quantity: 1,
              fixedUnitPrice: false,
              inferredByAi: !!productName,
              condition: "new",
            };
            lastAddedIdRef.current = newRow.id;
            return [...prev, newRow];
          });
          if (janInputRef.current) janInputRef.current.value = "";
        }
      }
    },
    [rows]
  );

  const addRow = useCallback(() => {
    const newRow: ProductRow = {
      id: generateId(),
      jan: "",
      brand: "",
      productName: "",
      modelNumber: "",
      basePrice: 0,
      quantity: 1,
      fixedUnitPrice: false,
      inferredByAi: false,
      condition: "new",
    };
    lastAddedIdRef.current = newRow.id;
    setRows((prev) => [...prev, newRow]);
    setTimeout(() => janInputRef.current?.focus(), 50);
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<ProductRow>) => {
    if (patch.productName !== undefined) {
      patch.productName = cleanseProductName(patch.productName);
    }
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // 登録処理（MySQLへの保存）
  const handleRegister = useCallback(async () => {
    if (!confirm("入力内容をデータベースに保存しますか？")) return;

    setIsSubmitting(true);
    try {
        // 数量 > 1 の行を展開してフラットなリストを作成
        const expandedItems = rows.flatMap(row => {
            const items = [];
            const effectivePrice = calcEffectiveUnitPrice(row, totalNum, headerInfo, rows);
            for (let i = 0; i < row.quantity; i++) {
                items.push({
                    ...row,
                    effectiveUnitPrice: effectivePrice
                });
            }
            return items;
        });

        const fullData = {
            header: {
                purchaseDate,
                supplier,
                genre,
                totalPurchase: totalNum,
                shipping: shippingNum,
                discount: discountNum,
                totalCost: totalNum + shippingNum - discountNum
            },
            items: expandedItems
        };

        const res = await fetch("/api/inbound", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fullData),
        });

        if (!res.ok) {
            throw new Error("保存に失敗しました");
        }
        
        const result = await res.json();
        alert(`保存しました (ID: ${result.id}, 商品数: ${expandedItems.length})`);
        
        // window.location.reload(); 

    } catch (error) {
        console.error(error);
        alert("エラーが発生しました: " + error);
    } finally {
        setIsSubmitting(false);
    }
  }, [headerInfo, rows, totalNum, shippingNum, discountNum, purchaseDate, supplier, genre]);

  const openCamera = useCallback(() => {
    setCameraOpen(true);
    setScannerReady(false);
  }, []);

  const closeCamera = useCallback(() => {
    if (scannerRef.current) {
      // カメラが完全に停止するのを「待ってから」画面を閉じるように修正
      scannerRef.current.stop().then(() => {
        scannerRef.current?.clear();
        scannerRef.current = null;
        setCameraOpen(false);
        setScannerReady(false);
      }).catch((err) => {
        console.warn("カメラの停止中にエラー:", err);
        scannerRef.current = null;
        setCameraOpen(false);
        setScannerReady(false);
      });
    } else {
      setCameraOpen(false);
      setScannerReady(false);
    }
  }, []);

  // ===== ここからコピー =====
  // カメラ起動中に商品リストが更新されてもエラーにならないようにする「裏ルート」
  const handleJanRef = useRef(handleJanBlurOrEnter);
  useEffect(() => {
    handleJanRef.current = handleJanBlurOrEnter;
  }, [handleJanBlurOrEnter]);

  useEffect(() => {
    if (!cameraOpen) return;
    const el = document.getElementById("barcode-reader");
    if (!el) return;
    
    const html5Qr = new Html5Qrcode("barcode-reader");
    scannerRef.current = html5Qr;
    
    html5Qr
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        (decodedText) => {
          const trimmed = decodedText.trim();
          if (trimmed.length >= 8) {
            // スキャン成功後、0.1秒だけ待ってから処理を実行（衝突防止の特効薬）
            setTimeout(() => {
              handleJanRef.current(trimmed);
              closeCamera();
            }, 100);
          }
        },
        () => {}
      )
      .then(() => setScannerReady(true))
      .catch((err: unknown) => {
        console.error(err);
        setScannerReady(false);
      });
      
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().then(() => {
          scannerRef.current?.clear();
          scannerRef.current = null;
        }).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen, closeCamera]);
  // ===== ここまでコピー =====

  // 集計値
  const totalCost = totalNum + shippingNum - discountNum;
  
  // 「チェックなし」（固定価格）商品の合計（数量考慮）
  const fixedTotal = rows
    .filter((r) => !r.fixedUnitPrice)
    .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);
  
  // 「チェックあり」（按分対象）商品の基準価格合計（数量考慮）
  const unfixedBaseSum = rows
    .filter((r) => r.fixedUnitPrice)
    .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);

  //shadcn/ui風の共通inputクラス
  const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
  const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-4 py-2 shadow-sm active:scale-[0.98] duration-100";

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans text-slate-900">
      
      {/* グローバルヘッダー */}
      <header className="sticky top-0 z-30 w-full border-b bg-white/80 backdrop-blur-md shadow-sm">
        <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-primary p-1.5 text-white shadow-md shadow-primary/30">
              <BarcodeIcon className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Zaiko Manager <span className="text-xs font-normal text-slate-500 ml-2 bg-slate-100 px-2 py-0.5 rounded-full">Professional</span></h1>
          </div>
          <div className="flex items-center gap-3">
             {/* PC用メニュー */}
             <div className="hidden sm:flex items-center gap-1 text-sm text-slate-500 mr-4">
                <span className="px-2">ユーザー: <strong>管理者</strong></span>
             </div>
             <Link
              href="/history"
              className="text-sm font-medium text-slate-500 hover:text-primary transition-colors"
            >
              在庫一覧
            </Link>
             <button
              onClick={() => alert("ログアウト")}
              className="text-sm font-medium text-slate-500 hover:text-destructive transition-colors"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="flex-1 py-8 w-full max-w-7xl mx-auto">
        <div className="px-4 sm:px-6 lg:px-8">
          
          <div className="grid gap-8 lg:grid-cols-12 items-start">
            
            {/* --- 左サイドパネル (伝票管理・集計) --- */}
            <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-24">
              
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
                <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
                  <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                    <DocumentIcon className="h-5 w-5 text-primary" />
                    伝票情報
                  </h2>
                </div>
                
                <div className="p-6 space-y-5">
                   {/* 伝票ヘッダー項目 */}
                   <div className="space-y-4">
                      <div>
                        <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">仕入日</label>
                        <input 
                            type="date"
                            value={purchaseDate}
                            onChange={(e) => setPurchaseDate(e.target.value)}
                            className={inputClass}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">仕入先</label>
                        <input 
                            type="text"
                            value={supplier}
                            onChange={(e) => setSupplier(e.target.value)}
                            placeholder="例: 株式会社◯◯、Amazonなど"
                            className={inputClass}
                            list="supplier-list"
                        />
                        <datalist id="supplier-list">
                          {supplierSuggestions.map((s, i) => (
                            <option key={i} value={s} />
                          ))}
                        </datalist>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">ジャンル</label>
                        <input 
                            type="text"
                            value={genre}
                            onChange={(e) => setGenre(e.target.value)}
                            placeholder="例: 家電、古着、本"
                            className={inputClass}
                        />
                      </div>
                   </div>
                   
                   <div className="h-px bg-slate-100" />

                   {/* コスト調整 */}
                   <div className="space-y-4">
                      <div className="relative">
                        <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">仕入総額 (税込)</label>
                        <div className="flex items-center gap-3">
                            <div className="relative flex-1">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-medium">¥</span>
                                <input
                                type="number"
                                min={0}
                                className="flex h-11 w-full rounded-md border border-slate-200 bg-slate-50/50 pl-8 pr-4 text-xl font-bold text-slate-900 placeholder:text-slate-300 focus:bg-white focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/10 transition-all text-right shadow-sm"
                                placeholder="0"
                                value={totalPurchase}
                                onChange={(e) => setTotalPurchase(e.target.value)}
                                />
                            </div>
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-[10px] font-bold text-slate-500 mb-1.5 block uppercase tracking-wide">送料 (+)</label>
                            <input
                                type="number"
                                min={0}
                                value={shipping}
                                onChange={(e) => setShipping(e.target.value)}
                                className={`${inputClass} text-right`}
                                placeholder="0"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-500 mb-1.5 block uppercase tracking-wide">割引 (-)</label>
                            <input
                                type="number"
                                min={0}
                                value={discount}
                                onChange={(e) => setDiscount(e.target.value)}
                                className={`${inputClass} text-right text-red-500`}
                                placeholder="0"
                            />
                        </div>
                      </div>
                   </div>

                   {/* サマリー情報 */}
                   <div className="rounded-lg bg-slate-50 p-4 border border-slate-100 space-y-3">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-500">実質総コスト</span>
                        <span className="font-bold text-slate-800">{totalCost.toLocaleString()} 円</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-500">固定商品の合計</span>
                        <span className="font-medium text-slate-600">{fixedTotal.toLocaleString()} 円</span>
                      </div>
                      <div className="h-px bg-slate-200 my-1" />
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-semibold text-slate-600">按分対象額</span>
                        <span className="text-lg font-extrabold text-primary">
                          {unfixedBaseSum > 0 ? (totalCost - fixedTotal).toLocaleString() : 0}
                          <span className="text-xs font-normal text-slate-500 ml-1">円</span>
                        </span>
                      </div>
                   </div>

                   <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowConfirmModal(true)}
                      className={`${buttonClass} w-full bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 h-10 text-sm`}
                    >
                      登録情報を確認する
                    </button>
                    <button
                      type="button"
                      onClick={handleRegister}
                      disabled={rows.length === 0 || totalNum <= 0 || isSubmitting}
                      className={`${buttonClass} w-full bg-primary text-white hover:bg-primary/90 shadow-lg shadow-primary/20 h-12 text-base font-bold tracking-wide transition-all disabled:grayscale disabled:opacity-70`}
                    >
                      {isSubmitting ? (
                        <span className="flex items-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"/>
                          保存中...
                        </span>
                      ) : (
                        "入庫データを保存"
                      )}
                    </button>
                    <p className="mt-2 text-center text-[10px] text-slate-400">
                      伝票情報と商品リストを保存します (数量分を展開)
                    </p>
                  </div>
                </div>
              </div>

              {/* エラーメッセージ */}
              {(validation.fixedTotalExceedsPurchase || (validation.missingFields?.length ?? 0) > 0) && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-sm animate-in fade-in slide-in-from-top-2">
                  <div className="flex items-start gap-3">
                    <AlertCircleIcon className="h-5 w-5 shrink-0 text-red-600 mt-0.5" />
                    <div className="space-y-1">
                      <h4 className="font-semibold text-red-900">入力内容を確認してください</h4>
                      <ul className="list-disc list-inside text-red-700 opacity-90 text-xs leading-relaxed">
                        {validation.fixedTotalExceedsPurchase && (
                          <li>固定商品の合計が仕入総額を超過しています（按分原資が不足）</li>
                        )}
                        {validation.missingFields?.map((msg, i) => (
                          <li key={i}>{msg}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* --- 右メインパネル (商品リスト) --- */}
            <div className="lg:col-span-8 space-y-4">
              
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    商品リスト 
                    <span className="ml-2 text-sm font-normal text-slate-500 bg-white px-2 py-0.5 rounded-full border border-slate-200">
                      {rows.reduce((acc, r) => acc + r.quantity, 0)}点
                    </span>
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={openCamera}
                    className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:text-primary hover:border-primary/30`}
                  >
                    <BarcodeIcon className="mr-2 h-4 w-4" />
                    カメラ起動
                  </button>
                  <button
                    type="button"
                    onClick={addRow}
                    className={`${buttonClass} bg-white text-primary border border-primary/20 hover:bg-primary/5`}
                  >
                    <PlusIcon className="mr-2 h-4 w-4" />
                    手動追加
                  </button>
                </div>
              </div>

              {/* JAN入力エリア (リスト上部固定) */}
              <div className="sticky top-[64px] z-20 -mx-4 sm:mx-0 px-4 sm:px-0 mb-4 bg-slate-50/95 backdrop-blur sm:bg-transparent pb-2 sm:pb-0">
                <div className="relative rounded-xl border border-primary/30 bg-white p-1 shadow-md shadow-primary/5 ring-4 ring-primary/5 transition-all focus-within:ring-primary/20 focus-within:border-primary/50">
                   <div className="relative flex items-center">
                     <div className="flex h-10 w-10 items-center justify-center text-primary">
                       <BarcodeIcon className="h-5 w-5" />
                     </div>
                     <input
                        ref={janInputRef}
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="JANコードをスキャン または 入力してEnter"
                        className="flex-1 h-12 bg-transparent text-lg text-slate-900 placeholder:text-slate-400 focus:outline-none"
                        disabled={!!inferringJan}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const v = (e.target as HTMLInputElement).value.trim().replace(/\D/g, "");
                            if (v.length === 13) {
                              handleJanBlurOrEnter(v);
                              (e.target as HTMLInputElement).value = "";
                            }
                          }
                        }}
                        onChange={(e) => {
                          const digits = (e.target.value || "").replace(/\D/g, "");
                          if (digits.length === 13) {
                            handleJanBlurOrEnter(digits);
                            e.target.value = "";
                          }
                        }}
                      />
                      {inferringJan && (
                        <div className="flex items-center gap-2 pr-4 animate-pulse">
                          <span className="h-2 w-2 rounded-full bg-primary"></span>
                          <span className="text-xs font-bold text-primary">AI推論中...</span>
                        </div>
                      )}
                   </div>
                </div>
              </div>

              {/* リスト表示エリア */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden min-h-[400px]">
                
                {/* --- デスクトップ表示 (テーブル) --- */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                      <tr>
                        <th className="px-6 py-4 w-[140px]">JAN / 状態</th>
                        <th className="px-6 py-4 min-w-[200px]">商品情報</th>
                        <th className="px-6 py-4 w-[100px] text-right">数量</th>
                        <th className="px-6 py-4 w-[130px] text-right">基準価格</th>
                        {/* チェックボックスのラベルを変更 */}
                        <th className="px-6 py-4 w-[70px] text-center">按分</th>
                        <th className="px-6 py-4 w-[130px] text-right">実質単価</th>
                        <th className="px-6 py-4 w-[50px]"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {rows.length === 0 && (
                         <tr>
                           <td colSpan={7} className="py-24 text-center text-slate-400">
                             <div className="flex flex-col items-center justify-center gap-4">
                               <div className="h-16 w-16 rounded-full bg-slate-50 flex items-center justify-center border border-slate-100">
                                 <PlusIcon className="h-8 w-8 text-slate-300" />
                               </div>
                               <p className="text-slate-500 font-medium">商品がありません。<br/>上のフォームから追加してください。</p>
                             </div>
                           </td>
                         </tr>
                      )}
                      {rows.map((row) => {
                        const effective = calcEffectiveUnitPrice(row, totalNum, headerInfo, rows);
                        // 背景色: AI推論行は薄い青、固定行は薄いグレー
                        let rowBg = "bg-white";
                        if (row.fixedUnitPrice) rowBg = "bg-slate-50/70";
                        else if (row.inferredByAi) rowBg = "bg-indigo-50/30";

                        return (
                          <tr key={row.id} className={`group hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0 ${rowBg}`}>
                            <td className="px-6 py-4 align-top">
                              <div className="space-y-2">
                                <div className="relative">
                                    <input
                                    value={row.jan}
                                    onChange={(e) => updateRow(row.id, { jan: e.target.value })}
                                    onBlur={(e) => {
                                        const v = e.target.value.trim().replace(/\D/g, "");
                                        if (v.length === 13 && !row.brand && !row.productName) handleJanBlurOrEnter(v, row.id);
                                    }}
                                    className={`${inputClass} font-mono text-xs h-9 shadow-sm`}
                                    placeholder="JAN"
                                    />
                                    {row.inferredByAi && (
                                    <div className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-white shadow-sm" title="AI自動入力済み" />
                                    )}
                                </div>
                                <select 
                                    value={row.condition}
                                    onChange={(e) => updateRow(row.id, { condition: e.target.value as ProductCondition })}
                                    className={`${inputClass} h-8 text-xs py-0`}
                                >
                                    <option value="new">新品</option>
                                    <option value="used">中古</option>
                                </select>
                              </div>
                            </td>
                            <td className="px-6 py-4 align-top space-y-3">
                               <input
                                 value={row.productName}
                                 onChange={(e) => updateRow(row.id, { productName: e.target.value })}
                                 className={`${inputClass} font-medium h-10 shadow-sm`}
                                 placeholder="商品名"
                               />
                               <div className="flex gap-3">
                                 <input
                                   value={row.brand}
                                   onChange={(e) => updateRow(row.id, { brand: e.target.value })}
                                   className={`${inputClass} text-xs h-9 bg-white/50 shadow-sm`}
                                   placeholder="ブランド"
                                 />
                                 <input
                                   value={row.modelNumber}
                                   onChange={(e) => updateRow(row.id, { modelNumber: e.target.value })}
                                   className={`${inputClass} text-xs h-9 bg-white/50 shadow-sm`}
                                   placeholder="型番"
                                 />
                               </div>
                            </td>
                            <td className="px-6 py-4 align-top">
                               <input
                                 type="number"
                                 min={1}
                                 value={row.quantity}
                                 onChange={(e) => updateRow(row.id, { quantity: Math.max(1, Number(e.target.value)) })}
                                 className={`${inputClass} text-right h-10 font-medium shadow-sm`}
                               />
                            </td>
                            <td className="px-6 py-4 align-top">
                              <div className="relative">
                                <span className="absolute left-3 top-2.5 text-slate-400 text-xs">¥</span>
                                <input
                                  type="number"
                                  min={0}
                                  value={row.basePrice || ""}
                                  onChange={(e) => updateRow(row.id, { basePrice: Number(e.target.value) || 0 })}
                                  className={`${inputClass} text-right pl-6 h-10 font-medium shadow-sm`}
                                  placeholder="0"
                                />
                              </div>
                            </td>
                            <td className="px-6 py-4 align-top text-center pt-3">
                               <input
                                 type="checkbox"
                                 checked={row.fixedUnitPrice}
                                 onChange={(e) => updateRow(row.id, { fixedUnitPrice: e.target.checked })}
                                 className="h-5 w-5 rounded border-slate-300 text-primary focus:ring-primary/20 cursor-pointer shadow-sm"
                               />
                            </td>
                            <td className="px-6 py-4 align-top text-right font-bold text-slate-800 pt-3 tabular-nums">
                              {effective > 0 ? Math.round(effective).toLocaleString() : "—"}
                              <span className="text-[10px] text-slate-400 ml-1 font-normal">円</span>
                            </td>
                            <td className="px-6 py-4 align-top pt-2 text-right">
                              <button
                                onClick={() => removeRow(row.id)}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                              >
                                <TrashIcon className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* --- スマホ表示 (カードリスト) --- */}
                <div className="md:hidden divide-y divide-slate-100">
                  {rows.length === 0 && (
                      <div className="p-10 text-center text-slate-400 text-sm bg-slate-50/30">
                        <PlusIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        リストは空です
                      </div>
                  )}
                  {rows.map((row) => {
                    const effective = calcEffectiveUnitPrice(row, totalNum, headerInfo, rows);
                    let rowBg = "bg-white";
                    if (row.fixedUnitPrice) rowBg = "bg-slate-50/70";
                    else if (row.inferredByAi) rowBg = "bg-indigo-50/20";

                    return (
                      <div key={row.id} className={`p-4 transition-colors ${rowBg}`}>
                        <div className="flex items-start justify-between gap-3 mb-3">
                           <div className="flex-1 min-w-0">
                             <div className="flex gap-2 mb-2">
                                <div className="relative flex-1">
                                    <input
                                    value={row.jan}
                                    onChange={(e) => updateRow(row.id, { jan: e.target.value })}
                                    onBlur={(e) => {
                                        const v = e.target.value.trim().replace(/\D/g, "");
                                        if (v.length === 13 && !row.brand && !row.productName) handleJanBlurOrEnter(v, row.id);
                                    }}
                                    className={`${inputClass} font-mono text-sm h-9 bg-white/80`}
                                    inputMode="numeric"
                                    placeholder="JAN"
                                    />
                                    {row.inferredByAi && <div className="absolute top-0 right-0 h-2 w-2 rounded-full bg-primary" />}
                                </div>
                                <select 
                                    value={row.condition}
                                    onChange={(e) => updateRow(row.id, { condition: e.target.value as ProductCondition })}
                                    className={`${inputClass} h-9 text-xs w-20 py-0 bg-white/80`}
                                >
                                    <option value="new">新品</option>
                                    <option value="used">中古</option>
                                </select>
                             </div>
                           </div>
                           <button
                              onClick={() => removeRow(row.id)}
                              className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                           >
                              <TrashIcon className="h-5 w-5" />
                           </button>
                        </div>

                        <div className="space-y-3">
                           <div>
                             <input
                               value={row.productName}
                               onChange={(e) => updateRow(row.id, { productName: e.target.value })}
                               className={`${inputClass} font-medium bg-white/80`}
                               placeholder="商品名"
                             />
                           </div>
                           <div className="grid grid-cols-2 gap-3">
                             <input
                               value={row.brand}
                               onChange={(e) => updateRow(row.id, { brand: e.target.value })}
                               className={`${inputClass} text-xs bg-white/80`}
                               placeholder="ブランド"
                             />
                             <input
                               value={row.modelNumber}
                               onChange={(e) => updateRow(row.id, { modelNumber: e.target.value })}
                               className={`${inputClass} text-xs bg-white/80`}
                               placeholder="型番"
                             />
                           </div>
                        </div>

                        <div className="mt-4 rounded-lg bg-slate-50/50 border border-slate-100 p-3 grid grid-cols-2 gap-4 items-center">
                           <div className="col-span-2 flex items-center justify-between gap-4 border-b border-slate-200/50 pb-3 mb-1">
                              <label className="text-[10px] text-slate-400 font-bold block">数量</label>
                              <div className="flex items-center gap-3">
                                <button
                                  type="button"
                                  onClick={() => updateRow(row.id, { quantity: Math.max(1, row.quantity - 1) })}
                                  className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                >
                                  -
                                </button>
                                <span className="font-bold text-slate-800 w-4 text-center">{row.quantity}</span>
                                <button
                                  type="button"
                                  onClick={() => updateRow(row.id, { quantity: row.quantity + 1 })}
                                  className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                >
                                  +
                                </button>
                              </div>
                           </div>
                           
                           <div>
                             <label className="text-[10px] text-slate-400 font-bold block mb-1">基準価格</label>
                             <div className="relative">
                               <span className="absolute left-2 top-1.5 text-slate-400 text-xs">¥</span>
                               <input
                                 type="number"
                                 min={0}
                                 value={row.basePrice || ""}
                                 onChange={(e) => updateRow(row.id, { basePrice: Number(e.target.value) || 0 })}
                                 className={`${inputClass} text-right pl-4 h-8 bg-white`}
                               />
                             </div>
                           </div>
                           <div className="text-right">
                              <div className="flex items-center justify-end gap-1.5 mb-1">
                                <label htmlFor={`fixed-${row.id}`} className="text-[10px] text-slate-500 font-medium">按分対象</label>
                                <input
                                   id={`fixed-${row.id}`}
                                   type="checkbox"
                                   checked={row.fixedUnitPrice}
                                   onChange={(e) => updateRow(row.id, { fixedUnitPrice: e.target.checked })}
                                   className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary/20"
                                 />
                              </div>
                              <div className="text-sm font-bold text-slate-900">
                                実質 <span className="text-lg text-primary">{effective > 0 ? Math.round(effective).toLocaleString() : "—"}</span> 円
                              </div>
                           </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* カメラモーダル */}
      {cameraOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">バーコードスキャン</h3>
              <button
                onClick={closeCamera}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-hidden rounded-xl bg-black border border-slate-200 shadow-inner">
              <div
                id="barcode-reader"
                style={{ width: "100%", minHeight: 250 }}
              />
            </div>
            <p className="mt-4 text-center text-sm font-medium text-slate-500">
              カメラを商品コードに向けてください
            </p>
          </div>
        </div>
      )}

      {/* 登録情報確認モーダル */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="relative w-full max-w-4xl max-h-[90vh] rounded-2xl border border-slate-200 bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900">登録情報の確認</h3>
              <button
                onClick={() => setShowConfirmModal(false)}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 space-y-6">
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">伝票情報</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div><span className="text-slate-500">仕入日</span><div className="font-medium text-slate-900">{purchaseDate}</div></div>
                  <div><span className="text-slate-500">仕入先</span><div className="font-medium text-slate-900">{supplier || "—"}</div></div>
                  <div><span className="text-slate-500">ジャンル（カテゴリ）</span><div className="font-medium text-slate-900">{genre || "—"}</div></div>
                  <div><span className="text-slate-500">仕入総額</span><div className="font-medium text-slate-900">{totalNum.toLocaleString()} 円</div></div>
                  <div><span className="text-slate-500">送料</span><div className="font-medium text-slate-900">{shippingNum.toLocaleString()} 円</div></div>
                  <div><span className="text-slate-500">割引</span><div className="font-medium text-slate-900">{discountNum.toLocaleString()} 円</div></div>
                  <div className="col-span-2 sm:col-span-3"><span className="text-slate-500">実質総コスト</span><div className="font-bold text-slate-900">{totalCost.toLocaleString()} 円</div></div>
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">商品一覧</h4>
                {rows.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4">商品がありません</p>
                ) : (
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold">
                        <tr>
                          <th className="px-4 py-3">JAN</th>
                          <th className="px-4 py-3">名称</th>
                          <th className="px-4 py-3">ブランド / 型番</th>
                          <th className="px-4 py-3 text-right">数量</th>
                          <th className="px-4 py-3 text-right">基準価格</th>
                          <th className="px-4 py-3 text-right">実質単価</th>
                          <th className="px-4 py-3">状態</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rows.map((row) => {
                          const effective = calcEffectiveUnitPrice(row, totalNum, headerInfo, rows);
                          return (
                            <tr key={row.id} className="bg-white">
                              <td className="px-4 py-3 font-mono text-xs">{row.jan || "—"}</td>
                              <td className="px-4 py-3 font-medium text-slate-900">{row.productName || "—"}</td>
                              <td className="px-4 py-3 text-slate-600">{row.brand || "—"} {row.modelNumber ? `/ ${row.modelNumber}` : ""}</td>
                              <td className="px-4 py-3 text-right">{row.quantity}</td>
                              <td className="px-4 py-3 text-right">{row.basePrice > 0 ? row.basePrice.toLocaleString() : "—"} 円</td>
                              <td className="px-4 py-3 text-right font-medium">{effective > 0 ? Math.round(effective).toLocaleString() : "—"} 円</td>
                              <td className="px-4 py-3">{row.condition === "new" ? "新品" : "中古"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ----- Icons -----
function BarcodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m-4-8v8m8-8v8M4 4h2v16H4V4zm14 0h2v16h-2V4zM8 4h1v16H8V4zm6 0h1v16h-1V4z" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function AlertCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );
}

function DocumentIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
    )
}
