"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  // ステップ1: 仕入総額の按分対象となる金額を計算（全体から「チェックなし商品の基準価格合計」を引く）
  let totalFixed = 0;
  let allocatableCount = 0;

  rows.forEach((r) => {
    if (!r.fixedUnitPrice) {
      // チェックなし（固定）
      totalFixed += r.basePrice * r.quantity;
    } else {
      // チェックあり（按分対象）
      allocatableCount += r.quantity;
    }
  });

  const baseAllocatableAmount = totalPurchase - totalFixed;

  // 基本単価の決定
  let effectiveBasePrice = 0;
  if (!row.fixedUnitPrice) {
    // チェックなし（固定）
    effectiveBasePrice = row.basePrice;
  } else {
    // チェックあり（按分）
    effectiveBasePrice = allocatableCount > 0 ? baseAllocatableAmount / allocatableCount : 0;
  }

  // ステップ2: 送料・割引の按分（全数量で均等割り）
  const totalQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);
  const perItemShipping = totalQuantity > 0 ? headerInfo.shipping / totalQuantity : 0;
  const perItemDiscount = totalQuantity > 0 ? headerInfo.discount / totalQuantity : 0;

  // 最終単価 = 基本単価 + 送料分 - 割引分
  return Math.max(0, effectiveBasePrice + perItemShipping - perItemDiscount);
}

// 共通ヘッダーコンポーネント
function HeaderSection({
  headerInfo,
  setHeaderInfo,
  totalPurchaseInput,
  setTotalPurchaseInput,
}: {
  headerInfo: HeaderInfo;
  setHeaderInfo: React.Dispatch<React.SetStateAction<HeaderInfo>>;
  totalPurchaseInput: string;
  setTotalPurchaseInput: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 mb-6 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">仕入日</label>
          <input
            type="date"
            value={headerInfo.purchaseDate}
            onChange={(e) => setHeaderInfo({ ...headerInfo, purchaseDate: e.target.value })}
            className="w-full p-2 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">仕入先</label>
          <input
            type="text"
            placeholder="例: コストコ"
            value={headerInfo.supplier}
            onChange={(e) => setHeaderInfo({ ...headerInfo, supplier: e.target.value })}
            className="w-full p-2 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">ジャンル</label>
          <input
            type="text"
            placeholder="例: 家電"
            value={headerInfo.genre}
            onChange={(e) => setHeaderInfo({ ...headerInfo, genre: e.target.value })}
            className="w-full p-2 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">仕入総額 (円)</label>
          <input
            type="number"
            min="0"
            placeholder="レシート合計"
            value={totalPurchaseInput}
            onChange={(e) => setTotalPurchaseInput(e.target.value)}
            className="w-full p-2 border rounded-md text-sm font-bold text-blue-600 focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-50">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">送料 (円)</label>
          <input
            type="number"
            min="0"
            value={headerInfo.shipping || ""}
            onChange={(e) => setHeaderInfo({ ...headerInfo, shipping: Number(e.target.value) })}
            className="w-full p-2 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">割引 (円)</label>
          <input
            type="number"
            min="0"
            value={headerInfo.discount || ""}
            onChange={(e) => setHeaderInfo({ ...headerInfo, discount: Number(e.target.value) })}
            className="w-full p-2 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>
    </div>
  );
}

// バーコードスキャナーコンポーネント
function BarcodeScanner({
  onDetected,
  isScanning,
  setIsScanning,
}: {
  onDetected: (jan: string) => void;
  isScanning: boolean;
  setIsScanning: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    if (!isScanning) {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(console.error);
        scannerRef.current = null;
      }
      return;
    }

    const html5QrCode = new Html5Qrcode("reader");
    scannerRef.current = html5QrCode;

    html5QrCode
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 100 } },
        (decodedText) => {
          // JANコードらしいか簡易チェック
          if (/^\d{8,13}$/.test(decodedText)) {
            onDetected(decodedText);
            setIsScanning(false);
          }
        },
        () => {}
      )
      .catch((err) => {
        console.error("Camera start failed", err);
        setIsScanning(false);
        alert("カメラの起動に失敗しました。");
      });

    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, [isScanning, onDetected, setIsScanning]);

  return (
    <div className="mb-6 flex flex-col items-center">
      {isScanning ? (
        <div className="relative w-full max-w-sm rounded-xl overflow-hidden shadow-lg border-2 border-blue-400 bg-black">
          <div id="reader" className="w-full" />
          <button
            onClick={() => setIsScanning(false)}
            className="absolute top-2 right-2 bg-gray-800/80 text-white p-2 rounded-full hover:bg-gray-700"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
          <p className="absolute bottom-4 left-0 right-0 text-center text-white text-sm font-semibold drop-shadow-md">
            バーコードを枠内に合わせてください
          </p>
        </div>
      ) : (
        <button
          onClick={() => setIsScanning(true)}
          className="w-full max-w-sm bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-bold py-4 px-4 rounded-xl flex items-center justify-center space-x-2 transition-colors shadow-sm"
        >
          <CameraIcon className="w-6 h-6" />
          <span>カメラでスキャンする</span>
        </button>
      )}
    </div>
  );
}

export default function ScanPage() {
  const [headerInfo, setHeaderInfo] = useState<HeaderInfo>({
    purchaseDate: new Date().toISOString().split("T")[0],
    supplier: "",
    genre: "",
    shipping: 0,
    discount: 0,
  });
  const [totalPurchaseInput, setTotalPurchaseInput] = useState<string>("");
  const totalPurchase = Number(totalPurchaseInput) || 0;

  const [janInput, setJanInput] = useState("");
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // 🔽 追加ここから: 登録済み商品の表示用State 🔽
  const [registeredProducts, setRegisteredProducts] = useState<any[]>([]);
  const [showProducts, setShowProducts] = useState(false);
  // 🔼 追加ここまで 🔼

  const handleAddRow = useCallback(
    async (jan: string) => {
      if (!jan) return;

      setIsLoading(true);
      try {
        const res = await fetch("/api/infer-jan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jan }),
        });

        const data = await res.json();
        
        const newRow: ProductRow = {
          id: crypto.randomUUID(),
          jan,
          brand: data.brand || "",
          productName: cleanseProductName(data.productName || ""),
          modelNumber: data.modelNumber || "",
          basePrice: 0,
          quantity: 1, // 初期数量は1
          fixedUnitPrice: false, // デフォルト: チェックなし（金額固定）
          inferredByAi: data.inferred ?? true,
          condition: "new",
        };

        setRows((prev) => [newRow, ...prev]);
        setJanInput("");
      } catch (error) {
        console.error("Fetch error:", error);
        alert("商品情報の取得に失敗しました。手動で入力してください。");
        // 失敗時も空の行を追加する
        setRows((prev) => [
          {
            id: crypto.randomUUID(),
            jan,
            brand: "",
            productName: "",
            modelNumber: "",
            basePrice: 0,
            quantity: 1,
            fixedUnitPrice: false,
            inferredByAi: false,
            condition: "new",
          },
          ...prev,
        ]);
        setJanInput("");
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const updateRow = (id: string, updates: Partial<ProductRow>) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          const updated = { ...r, ...updates };
          if (updates.productName !== undefined) {
            updated.productName = cleanseProductName(updates.productName);
          }
          return updated;
        }
        return r;
      })
    );
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // APIに送信するデータを整形
      const payload = {
        header: {
          purchase_date: headerInfo.purchaseDate,
          supplier: headerInfo.supplier,
          genre: headerInfo.genre,
          total_purchase: totalPurchase,
          shipping: headerInfo.shipping,
          discount: headerInfo.discount,
        },
        items: rows.map(r => ({
          jan: r.jan,
          brand: r.brand,
          product_name: r.productName,
          model_number: r.modelNumber,
          condition: r.condition,
          quantity: r.quantity,
          base_price: r.basePrice,
          // 最終的な計算済み単価をサーバーに送る
          effective_unit_price: Math.floor(calcEffectiveUnitPrice(r, totalPurchase, headerInfo, rows))
        }))
      };

      const res = await fetch("/api/save-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      alert("保存しました！");
      // 保存成功したらリストをクリア
      setRows([]);
      setTotalPurchaseInput("");
      
    } catch (error: any) {
      console.error(error);
      alert("保存に失敗しました: " + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  // 🔽 追加ここから: 登録済み商品の取得処理 🔽
  const fetchRegisteredProducts = async () => {
    try {
      const res = await fetch("/api/infer-jan");
      if (res.ok) {
        const data = await res.json();
        setRegisteredProducts(data);
        setShowProducts(true);
      } else {
        console.error("取得に失敗しました");
      }
    } catch (error) {
      console.error("取得エラー:", error);
    }
  };
  // 🔼 追加ここまで 🔼

  // バリデーションチェック
  const validation: ValidationError = {};
  let totalFixedAmount = 0;
  let hasMissing = false;

  rows.forEach((r) => {
    if (!r.fixedUnitPrice) {
      totalFixedAmount += r.basePrice * r.quantity;
    }
    if (!r.jan || !r.productName) {
      hasMissing = true;
    }
  });

  if (totalPurchase > 0 && totalFixedAmount > totalPurchase) {
    validation.fixedTotalExceedsPurchase = true;
  }
  if (hasMissing) {
    validation.missingFields = ["JANまたは商品名が未入力の行があります"];
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 font-sans text-gray-800">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-6 text-gray-800 flex items-center space-x-2">
          <ClipboardIcon className="w-6 h-6 text-blue-600" />
          <span>仕入・検品スキャン</span>
        </h1>

        <HeaderSection
          headerInfo={headerInfo}
          setHeaderInfo={setHeaderInfo}
          totalPurchaseInput={totalPurchaseInput}
          setTotalPurchaseInput={setTotalPurchaseInput}
        />

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 mb-6">
          <BarcodeScanner
            isScanning={isScanning}
            setIsScanning={setIsScanning}
            onDetected={handleAddRow}
          />

          <div className="flex space-x-2">
            <input
              type="text"
              value={janInput}
              onChange={(e) => setJanInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleAddRow(janInput);
                }
              }}
              placeholder="JANコードを手入力 または スキャナで読込"
              className="flex-1 p-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button
              onClick={() => handleAddRow(janInput)}
              disabled={isLoading || !janInput}
              className="bg-gray-800 hover:bg-gray-900 text-white px-6 py-3 rounded-lg font-bold disabled:opacity-50 transition-colors"
            >
              {isLoading ? "検索中..." : "追加"}
            </button>
          </div>
        </div>

        {/* バリデーション警告 */}
        {Object.keys(validation).length > 0 && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md mb-6">
            <div className="flex items-center space-x-2 text-red-700 font-bold mb-1">
              <AlertCircleIcon className="w-5 h-5" />
              <span>入力エラーがあります</span>
            </div>
            <ul className="list-disc list-inside text-sm text-red-600 space-y-1">
              {validation.fixedTotalExceedsPurchase && (
                <li>金額指定（チェックなし）の合計が、仕入総額を超えています。</li>
              )}
              {validation.missingFields?.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="p-4 bg-gray-50 border-b border-gray-100 flex justify-between items-center">
            <h2 className="font-bold text-gray-700">商品リスト ({rows.length}件)</h2>
          </div>

          {rows.length === 0 ? (
            <div className="p-8 text-center text-gray-400">
              <p>商品がありません。JANをスキャンして追加してください。</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              {/* デスクトップ向けテーブル表示 */}
              <table className="w-full text-sm text-left hidden md:table">
                <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3">JAN</th>
                    <th className="px-4 py-3">商品詳細 (ブランド / 商品名 / 型番)</th>
                    <th className="px-4 py-3 w-28">状態</th>
                    <th className="px-4 py-3 w-32 text-right">単価指定 (円)</th>
                    <th className="px-4 py-3 w-24 text-right">数量</th>
                    <th className="px-4 py-3 text-center">按分<br/><span className="text-[10px] text-gray-400">一括割の対象</span></th>
                    <th className="px-4 py-3 text-right">実質単価</th>
                    <th className="px-4 py-3 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-gray-600">{row.jan}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-col space-y-1">
                          <input
                            value={row.brand}
                            onChange={(e) => updateRow(row.id, { brand: e.target.value })}
                            placeholder="ブランド"
                            className="p-1 border rounded text-xs text-gray-500"
                          />
                          <input
                            value={row.productName}
                            onChange={(e) => updateRow(row.id, { productName: e.target.value })}
                            placeholder="商品名"
                            className={`p-1 border rounded font-semibold focus:ring-1 outline-none ${row.inferredByAi ? 'bg-yellow-50 border-yellow-200' : ''}`}
                          />
                          <input
                            value={row.modelNumber}
                            onChange={(e) => updateRow(row.id, { modelNumber: e.target.value })}
                            placeholder="型番"
                            className="p-1 border rounded text-xs text-gray-500"
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2">
                         <select
                          value={row.condition}
                          onChange={(e) => updateRow(row.id, { condition: e.target.value as ProductCondition })}
                          className="w-full p-2 border rounded text-sm outline-none"
                        >
                          <option value="new">新品</option>
                          <option value="used">中古</option>
                        </select>
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min="0"
                          value={row.basePrice || ""}
                          onChange={(e) => updateRow(row.id, { basePrice: Number(e.target.value) })}
                          disabled={row.fixedUnitPrice}
                          placeholder="基準額"
                          className="w-full p-2 border rounded text-right outline-none focus:ring-1 disabled:bg-gray-100 disabled:text-gray-400"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min="1"
                          value={row.quantity || ""}
                          onChange={(e) => updateRow(row.id, { quantity: Number(e.target.value) })}
                          className="w-full p-2 border rounded text-right outline-none focus:ring-1"
                        />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={row.fixedUnitPrice}
                          onChange={(e) => updateRow(row.id, { fixedUnitPrice: e.target.checked })}
                          className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-2 text-right font-bold text-blue-700">
                        ¥{Math.floor(calcEffectiveUnitPrice(row, totalPurchase, headerInfo, rows)).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button onClick={() => removeRow(row.id)} className="text-red-400 hover:text-red-600 p-1">
                          <TrashIcon className="w-5 h-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* モバイル向けカード表示 */}
              <div className="md:hidden divide-y divide-gray-100">
                {rows.map((row) => (
                  <div key={row.id} className="p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">{row.jan}</div>
                      <button onClick={() => removeRow(row.id)} className="text-red-400 hover:text-red-600 p-1">
                        <CloseIcon className="w-5 h-5" />
                      </button>
                    </div>
                    
                    <div className="space-y-2">
                      <input
                        value={row.brand}
                        onChange={(e) => updateRow(row.id, { brand: e.target.value })}
                        placeholder="ブランド"
                        className="w-full p-2 border rounded text-sm text-gray-600"
                      />
                      <input
                        value={row.productName}
                        onChange={(e) => updateRow(row.id, { productName: e.target.value })}
                        placeholder="商品名"
                        className={`w-full p-2 border rounded font-bold outline-none ${row.inferredByAi ? 'bg-yellow-50 border-yellow-200' : ''}`}
                      />
                      <input
                        value={row.modelNumber}
                        onChange={(e) => updateRow(row.id, { modelNumber: e.target.value })}
                        placeholder="型番"
                        className="w-full p-2 border rounded text-sm text-gray-600"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">状態</label>
                        <select
                          value={row.condition}
                          onChange={(e) => updateRow(row.id, { condition: e.target.value as ProductCondition })}
                          className="w-full p-2 border rounded text-sm outline-none bg-white"
                        >
                          <option value="new">新品</option>
                          <option value="used">中古</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">数量</label>
                         <input
                          type="number"
                          min="1"
                          value={row.quantity || ""}
                          onChange={(e) => updateRow(row.id, { quantity: Number(e.target.value) })}
                          className="w-full p-2 border rounded text-right text-sm outline-none focus:ring-1"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between bg-gray-50 p-2 rounded border">
                      <div className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          checked={row.fixedUnitPrice}
                          onChange={(e) => updateRow(row.id, { fixedUnitPrice: e.target.checked })}
                          id={`check-${row.id}`}
                          className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 cursor-pointer"
                        />
                        <label htmlFor={`check-${row.id}`} className="text-xs font-bold text-gray-600 cursor-pointer">按分対象にする</label>
                      </div>
                      
                      {!row.fixedUnitPrice && (
                        <div className="w-1/2">
                          <input
                            type="number"
                            min="0"
                            value={row.basePrice || ""}
                            onChange={(e) => updateRow(row.id, { basePrice: Number(e.target.value) })}
                            placeholder="単価指定"
                            className="w-full p-2 border rounded text-right text-sm outline-none focus:ring-1 bg-white"
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                      <span className="text-xs font-bold text-gray-500">実質単価</span>
                      <span className="text-lg font-bold text-blue-700">
                        ¥{Math.floor(calcEffectiveUnitPrice(row, totalPurchase, headerInfo, rows)).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <div className="mt-6">
            <button
              onClick={handleSave}
              disabled={isSaving || Object.keys(validation).length > 0}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-4 rounded-xl flex items-center justify-center space-x-2 disabled:opacity-50 transition-colors shadow-sm text-lg"
            >
              {isSaving ? (
                 <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                <>
                  <SaveIcon className="w-6 h-6" />
                  <span>{totalPurchase ? "仕入データと商品を保存" : "商品を保存"}</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* 🔽 追加ここから: 登録情報確認エリア 🔽 */}
        <div className="mt-8 pt-8 border-t border-gray-200">
          <button
            onClick={fetchRegisteredProducts}
            className="w-full sm:w-auto bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors"
          >
            <span>🗄️ 登録済みの商品を確認する</span>
          </button>

          {showProducts && (
            <div className="mt-4 border border-gray-200 p-4 rounded-lg bg-white shadow-sm">
              <div className="flex justify-between items-center mb-4 border-b pb-2">
                <h3 className="font-bold text-gray-800">登録済みデータ（最新10件）</h3>
                <button onClick={() => setShowProducts(false)} className="text-gray-500 hover:text-gray-800 p-1">
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
              {registeredProducts.length === 0 ? (
                <p className="text-sm text-gray-500">まだデータベースに登録されていません。</p>
              ) : (
                <ul className="space-y-3">
                  {registeredProducts.map((product, index) => (
                    <li key={index} className="text-sm bg-gray-50 p-3 rounded border border-gray-100">
                      <div className="font-mono text-gray-500 text-xs mb-1">{product.jan}</div>
                      <div className="font-bold text-gray-800">{product.product_name || product.productName}</div>
                      <div className="text-gray-500 text-xs mt-1">ブランド: {product.brand || "不明"} / 型番: {product.model_number || product.modelNumber || "不明"}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {/* 🔼 追加ここまで 🔼 */}

      </div>
    </div>
  );
}

// ----- アイコン群 -----
function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function ClipboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
}

function SaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
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
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}