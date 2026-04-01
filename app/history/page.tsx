"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Save, X, ChevronLeft, Download, Upload, Search, ArrowUp, ArrowDown, ArrowUpDown, Calendar, Loader2, PackageMinus } from "lucide-react";
import { normalizeToFullWidthKatakana } from "@/lib/kana";
import { normalizeSupplierForMatch } from "@/lib/normalizeSupplier";
import { getInventoryStatusDisplay, getInventoryStatusSortRank } from "@/lib/inventory-status-display";

/** 在庫一覧1行。主軸はJANのためテーブルにはASIN列を表示しない（保存時ペイロード用に asin は取得のみ） */
type RecordRow = {
  id: number;
  registered_at?: string;
  jan_code: string | null;
  asin?: string | null;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  condition_type: string | null;
  base_price: number;
  effective_unit_price: number;
  created_at: string;
  order_id: string | null;
  settled_at: string | null;
  exit_type: string | null;
  stock_status: string | null;
  header: {
    id: number;
    purchase_date: string;
    supplier: string | null; // ここにはカナ（例: アマゾン）が入っている
    genre: string | null;
    created_at: string;
  } | null;
};

type SupplierMaster = {
  id: number;
  name: string;
  kana: string;
};

type ProductMaster = {
  jan_code: string;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  current_stock?: number;
};

/** CSV取込プレビュー用：マスタ照合・補完・警告フラグ付きの1行 */
type CsvImportPreviewRow = {
  id: string;
  jan_code: string;
  product_name: string;
  brand: string;
  model_number: string;
  /** 仕入日（CSV: created_at / 仕入日 等） */
  created_at: string;
  /** 登録日（CSV: registered_at / 登録日 等） */
  registered_at: string;
  effective_unit_price: string;
  status: string;
  genre: string;
  base_price: string;
  supplierRaw: string;
  supplierKana: string;
  warnings: ("jan_not_in_master" | "supplier_mismatch")[];
};

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
// px-4 -> px-6
const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

/** inbound_items.condition_type（new / used 等）を一覧・CSV・検索用ラベルに */
function statusLabel(c: string | null | undefined): string {
  if (c === "new") return "新品";
  if (c === "used") return "中古";
  return c ?? "";
}

type EditDraft = {
  brand: string;
  product_name: string;
  model_number: string;
  created_at: string;
  registered_at: string;
  supplier: string; // 編集用のドラフト
  genre: string;
  base_price: number;
  effective_unit_price: number;
};

export default function HistoryPage() {
  const [rows, setRows] = useState<RecordRow[]>([]);
  // 🌟 追加：仕入先マスターのデータを保持する
  const [suppliers, setSuppliers] = useState<SupplierMaster[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [bulkSnapshot, setBulkSnapshot] = useState<RecordRow[] | null>(null);
  const [bulkAction, setBulkAction] = useState<string>("bulk_delete");
  const [saving, setSaving] = useState(false);
  const [csv5YearsLoading, setCsv5YearsLoading] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvImportPreview, setCsvImportPreview] = useState<CsvImportPreviewRow[] | null>(null);
  const [inventoryModalOpen, setInventoryModalOpen] = useState(false);
  const [invJan, setInvJan] = useState("");
  const [invCondition, setInvCondition] = useState<"new" | "used">("new");
  const [invQuantity, setInvQuantity] = useState("1");
  const [invReason, setInvReason] = useState<"damaged" | "lost" | "internal_use" | "entertainment">("damaged");
  const [inventorySubmitting, setInventorySubmitting] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [sortConfig, setSortConfig] = useState<{ key: string | null; direction: "asc" | "desc" }>({ key: null, direction: "asc" });

  const fetchRecords = useCallback(async () => {
    try {
      // 🌟 変更点：在庫データと仕入先マスターデータを「同時に」取得する
      const [recordsRes, suppliersRes] = await Promise.all([
        fetch("/api/records"),
        fetch("/api/suppliers") // これで仕入先一覧（ID, name, kana 等）を取得
      ]);
      
      if (!recordsRes.ok) throw new Error("在庫データの取得に失敗しました");
      const recordsData = await recordsRes.json();
      if (!Array.isArray(recordsData)) {
        const msg =
          typeof recordsData === "object" && recordsData !== null && "error" in recordsData
            ? String((recordsData as { error?: string }).error ?? "")
            : "";
        throw new Error(msg || "在庫データの形式が不正です");
      }
      const list = recordsData;
      setRows(
        list.map((r: RecordRow & { exit_type?: string | null; stock_status?: string | null }) => ({
          ...r,
          exit_type: r.exit_type ?? null,
          stock_status: r.stock_status ?? null,
        }))
      );

      if (suppliersRes.ok) {
        const suppliersData = await suppliersRes.json();
        setSuppliers(suppliersData);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const submitInventoryAdjustment = useCallback(async () => {
    const jan = invJan.trim();
    const q = Math.floor(Number(invQuantity));
    if (!jan) {
      alert("JANコードを入力してください");
      return;
    }
    if (!Number.isFinite(q) || q < 1) {
      alert("処理する個数は 1 以上の整数にしてください");
      return;
    }
    setInventorySubmitting(true);
    try {
      const res = await fetch("/api/inventory-adjustment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jan_code: jan,
          condition: invCondition,
          quantity: q,
          reason: invReason,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || "在庫調整に失敗しました");
      }
      setInventoryModalOpen(false);
      setInvJan("");
      setInvQuantity("1");
      await fetchRecords();
      alert(`在庫調整を反映しました（${(data as { updated?: number }).updated ?? q} 件）`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "在庫調整に失敗しました");
    } finally {
      setInventorySubmitting(false);
    }
  }, [invJan, invCondition, invQuantity, invReason, fetchRecords]);

  // 🌟 追加：「カナ」を渡すと、マスターから「正式名称（name）」を探して返す関数
  const getSupplierName = useCallback((kanaOrName: string | null | undefined): string => {
    if (!kanaOrName) return "—";
    
    // データベースには「アマゾン」などのカナが保存されている前提
    // マスターの `kana` と完全に一致するものを探す
    const match = suppliers.find(s => s.kana === kanaOrName);
    
    // もし見つかれば正式名称（例: Amazon）を返す。
    // 見つからなければ、元々入っていた文字（古いデータなどで名前が直接入っているケース用）をそのまま返す
    return match ? match.name : kanaOrName;
  }, [suppliers]);


  const requestSort = (key: string) => {
    setSortConfig((prev) => {
      if (prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return { key: null, direction: "asc" };
    });
  };

  const getSortValue = (row: RecordRow, key: string): string | number => {
    switch (key) {
      case "id":
        return row.id;
      case "registered_at":
        return row.registered_at ?? row.created_at ?? "";
      case "created_at":
        return row.header?.purchase_date ?? row.created_at ?? "";
      case "supplier":
        // 🌟 変更点：ソートする時も、正式名称で並び替えるようにする
        return getSupplierName(row.header?.supplier);
      case "genre":
        return row.header?.genre ?? "";
      case "jan_code":
        return row.jan_code ?? "";
      case "product_name":
        return row.product_name ?? "";
      case "brand":
        return row.brand ?? "";
      case "model_number":
        return row.model_number ?? "";
      case "order_id":
        return row.order_id ?? "";
      case "inventory_progress":
        return getInventoryStatusSortRank({
          order_id: row.order_id,
          settled_at: row.settled_at,
          exit_type: row.exit_type,
          stock_status: row.stock_status,
        });
      case "base_price":
        return row.base_price ?? 0;
      case "effective_unit_price":
        return row.effective_unit_price ?? 0;
      case "condition_type":
        return row.condition_type ?? "";
      default:
        return "";
    }
  };

  const processedRows = (() => {
    let list = rows;
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      list = list.filter((r) => {
        const condRaw = (r.condition_type ?? "").toLowerCase();
        const condLabel = statusLabel(r.condition_type).toLowerCase();
        const oid = (r.order_id ?? "").toLowerCase();
        const asin = (r.asin ?? "").toLowerCase();
        return (
          String(r.id).includes(term) ||
          (r.jan_code ?? "").toLowerCase().includes(term) ||
          (r.brand ?? "").toLowerCase().includes(term) ||
          (r.product_name ?? "").toLowerCase().includes(term) ||
          (r.model_number ?? "").toLowerCase().includes(term) ||
          getSupplierName(r.header?.supplier).toLowerCase().includes(term) ||
          (r.header?.supplier ?? "").toLowerCase().includes(term) ||
          condRaw.includes(term) ||
          condLabel.includes(term) ||
          oid.includes(term) ||
          asin.includes(term)
        );
      });
    }
    const { key, direction } = sortConfig;
    if (key) {
      list = [...list].sort((a, b) => {
        const va = getSortValue(a, key);
        const vb = getSortValue(b, key);
        const isNum = typeof va === "number" && typeof vb === "number";
        if (isNum) {
          return direction === "asc" ? (va as number) - (vb as number) : (vb as number) - (va as number);
        }
        const sa = String(va);
        const sb = String(vb);
        const cmp = sa.localeCompare(sb, "ja");
        if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
        return a.id - b.id;
      });
    }
    return list;
  })();

  const formatDate = (iso: string) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      return iso;
    }
  };

  const toDateValue = (iso: string) => (iso ? iso.slice(0, 10) : "");

  /** ISO または yyyy-MM-dd を yyyy/mm/dd 表示用に変換 */
  const isoToSlashed = (iso: string): string => {
    if (!iso) return "";
    const d = iso.slice(0, 10).replace(/-/g, "/");
    return d.length === 10 ? d : "";
  };

  /** 任意入力を yyyy/mm/dd に正規化（8桁・スラッシュ区切り等） */
  const normalizeDateToSlashed = (raw: string): string => {
    const s = (raw ?? "").trim().replace(/-/g, "/").replace(/\s/g, "");
    if (!s) return "";
    const digits = s.replace(/\D/g, "");
    let y = "";
    let m = "";
    let d = "";
    if (digits.length >= 8) {
      y = digits.slice(0, 4);
      m = digits.slice(4, 6);
      d = digits.slice(6, 8);
    } else {
      const parts = s.split("/").filter(Boolean);
      if (parts.length >= 3) {
        y = parts[0].padStart(4, "0").slice(-4);
        m = parts[1].padStart(2, "0").slice(-2);
        d = parts[2].padStart(2, "0").slice(-2);
      } else return s;
    }
    const mi = Math.min(12, Math.max(1, parseInt(m, 10) || 1));
    const di = Math.min(31, Math.max(1, parseInt(d, 10) || 1));
    return `${y}/${String(mi).padStart(2, "0")}/${String(di).padStart(2, "0")}`;
  };

  /** yyyy/mm/dd または yyyy-MM-dd を API 用 ISO 日付先頭に */
  const slashedToIsoDate = (slashed: string): string => {
    const n = normalizeDateToSlashed(slashed);
    if (!n || n.length < 10) return "";
    return n.replace(/\//g, "-");
  };

  const toggleSelect = (id: number, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      
      // Shiftキー範囲選択ロジック
      if (shiftKey && lastCheckedId !== null) {
        const currentIndex = rows.findIndex(r => r.id === id);
        const lastIndex = rows.findIndex(r => r.id === lastCheckedId);
        
        if (currentIndex !== -1 && lastIndex !== -1) {
          const start = Math.min(currentIndex, lastIndex);
          const end = Math.max(currentIndex, lastIndex);
          const targetValue = !prev.has(id); // クリックした行の状態に合わせるか、常に選択にするか。
          // 通常Shift選択は「選択範囲をActiveにする」なので、addする方向で実装
          
          for (let i = start; i <= end; i++) {
             next.add(rows[i].id);
          }
          return next;
        }
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      
      setLastCheckedId(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (rows.length === 0) return;
    if (selectedIds.size >= rows.length) {
        setSelectedIds(new Set());
        setLastCheckedId(null);
    } else {
        setSelectedIds(new Set(rows.map((r) => r.id)));
        setLastCheckedId(null);
    }
  };

  const startIndividualEdit = (row: RecordRow) => {
    setEditingId(row.id);
    setEditDraft({
      brand: row.brand ?? "",
      product_name: row.product_name ?? "",
      model_number: row.model_number ?? "",
      created_at: isoToSlashed(row.created_at) || normalizeDateToSlashed(toDateValue(row.created_at)),
      registered_at: isoToSlashed(row.registered_at ?? row.created_at) || normalizeDateToSlashed(toDateValue(row.registered_at ?? row.created_at)),
      supplier: row.header?.supplier ?? "", // 編集時も「カナ」をベースに扱う
      genre: row.header?.genre ?? "",
      base_price: row.base_price,
      effective_unit_price: row.effective_unit_price,
    });
  };

  const cancelIndividualEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const saveIndividualEdit = useCallback(async () => {
    if (editingId == null || !editDraft) return;
    const inputSupplier = editDraft.supplier.trim();
    if (inputSupplier) {
      const isValidSupplier = suppliers.some((s) => {
        return (
          s.name === inputSupplier ||
          s.kana === inputSupplier ||
          normalizeSupplierForMatch(s.name) === normalizeSupplierForMatch(inputSupplier) ||
          normalizeSupplierForMatch(s.kana) === normalizeSupplierForMatch(inputSupplier)
        );
      });

      if (!isValidSupplier) {
        alert("⚠️ 仕入先マスタに登録されていない名前です。\n正しい仕入先名を入力・選択してください。");
        return; // 保存処理をストップ
      }
    }
    setSaving(true);
    try {
      // 🌟 追加：編集画面で仕入先が変更された場合も、必ずカナに変換して保存する
      const kanaSupplier = normalizeToFullWidthKatakana(editDraft.supplier);

      const isoDate = slashedToIsoDate(editDraft.created_at);
      const created_at = isoDate ? `${isoDate}T00:00:00.000Z` : "";
      const isoRegistered = slashedToIsoDate(editDraft.registered_at);
      const registered_at = isoRegistered ? `${isoRegistered}T00:00:00.000Z` : "";
      const editingRow = rows.find((r) => r.id === editingId);
      const res = await fetch("/api/infer-jan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          brand: editDraft.brand,
          product_name: editDraft.product_name,
          model_number: editDraft.model_number,
          supplier: kanaSupplier,
          genre: editDraft.genre,
          base_price: editDraft.base_price,
          effective_unit_price: editDraft.effective_unit_price,
          ...(created_at && { created_at }),
          ...(editingRow?.asin != null && { asin: editingRow.asin }),
        }),
      });
      if (!res.ok) throw new Error("更新に失敗しました");
      
      setRows((prev) =>
        prev.map((r) => {
            if (r.id !== editingId) return r;
            const newHeader = r.header ? { ...r.header, supplier: kanaSupplier, genre: editDraft.genre } : r.header;
            return {
                ...r,
                brand: editDraft.brand || null,
                product_name: editDraft.product_name || null,
                model_number: editDraft.model_number || null,
                created_at: created_at || r.created_at,
                base_price: editDraft.base_price,
                effective_unit_price: editDraft.effective_unit_price,
                header: newHeader
            };
        })
      );
      setEditingId(null);
      setEditDraft(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [editingId, editDraft]);

  const startBulkEdit = () => {
    // deep copy for snapshot including header
    setBulkSnapshot(rows.map(r => ({...r, header: r.header ? {...r.header} : null})));
    setIsBulkEditing(true);
  };

  const cancelBulkEdit = () => {
    if (bulkSnapshot) setRows(bulkSnapshot);
    setBulkSnapshot(null);
    setIsBulkEditing(false);
  };

  const saveBulkEdit = useCallback(async () => {
    for (const r of rows) {
      const inputSupplier = (r.header?.supplier ?? "").trim();
      if (inputSupplier) {
        const isValidSupplier = suppliers.some((s) => {
          return (
            s.name === inputSupplier ||
            s.kana === inputSupplier ||
            normalizeSupplierForMatch(s.name) === normalizeSupplierForMatch(inputSupplier) ||
            normalizeSupplierForMatch(s.kana) === normalizeSupplierForMatch(inputSupplier)
          );
        });
        if (!isValidSupplier) {
          alert(`⚠️ 「${inputSupplier}」は仕入先マスタに登録されていません。\n正しい仕入先名に修正してから保存してください。`);
          return; // エラーを見つけたら保存処理をストップ
        }
      }
    }
    setSaving(true);
    try {
      const items = rows.map((r) => ({
        id: r.id,
        brand: r.brand ?? "",
        product_name: r.product_name ?? "",
        model_number: r.model_number ?? "",
        base_price: r.base_price,
        effective_unit_price: r.effective_unit_price,
        supplier: normalizeToFullWidthKatakana(r.header?.supplier ?? ""),
        genre: r.header?.genre ?? "",
        registered_at: r.registered_at,
        ...(r.created_at && { created_at: r.created_at }),
        ...(r.asin != null && { asin: r.asin }),
      }));
      const res = await fetch("/api/infer-jan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error("一括更新に失敗しました");
      setBulkSnapshot(null);
      setIsBulkEditing(false);
      await fetchRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "一括更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [rows, fetchRecords]);

  // RecordRowのフィールド更新用
  const updateRowField = useCallback((id: number, field: keyof RecordRow, value: string | number) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }, []);

  // Header情報のフィールド更新用
  const updateRowHeaderField = useCallback((id: number, field: "supplier" | "genre", value: string) => {
      setRows((prev) => prev.map((r) => {
          if (r.id !== id || !r.header) return r;
          return { ...r, header: { ...r.header, [field]: value } };
      }));
  }, []);


  const executeBulkAction = useCallback(async () => {
    if (bulkAction === "bulk_delete" && selectedIds.size > 0) {
      if (!confirm(`選択した ${selectedIds.size} 件を削除しますか？`)) return;
      setSaving(true);
      try {
        const res = await fetch("/api/records", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: Array.from(selectedIds) }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; deleted?: number };
        if (!res.ok || data.ok !== true) {
          alert(data.error || "削除に失敗しました");
          return;
        }
        setSelectedIds(new Set());
        await fetchRecords();
      } catch (e) {
        alert(e instanceof Error ? e.message : "削除に失敗しました");
      } finally {
        setSaving(false);
      }
    }
  }, [bulkAction, selectedIds, fetchRecords]);

  const escapeCsv = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? "" : String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const handleCsvExport = useCallback(() => {
    const header = "id,jan_code,brand,product_name,model_number,supplier,genre,base_price,effective_unit_price,created_at,registered_at,status";
    const lines = processedRows.map((r) =>
      [
        r.id,
        r.jan_code ?? "",
        r.brand ?? "",
        r.product_name ?? "",
        r.model_number ?? "",
        // 🌟 CSV出力時も、カナではなく「正式名称」を出力する
        getSupplierName(r.header?.supplier), 
        r.header?.genre ?? "",
        r.base_price ?? "",
        r.effective_unit_price ?? "",
        r.created_at ?? "",
        r.registered_at ?? "",
        statusLabel(r.condition_type),
      ].map((x) => escapeCsv(x)).join(",")
    );
    const csv = [header, ...lines].join("\r\n");
    const bom = "\uFEFF";
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },[processedRows, getSupplierName]); // 🌟 依存配列に追加

  const downloadCsv5Years = useCallback(async () => {
    setCsv5YearsLoading(true);
    try {
      const res = await fetch("/api/records?years=5");
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error || "データの取得に失敗しました");
      }
      const data: RecordRow[] = await res.json();
      if (!Array.isArray(data)) throw new Error("不正なレスポンスです");

      const header =
        "id,jan_code,brand,product_name,model_number,supplier,genre,base_price,effective_unit_price,created_at,registered_at,status";
      const lines = data.map((r) =>
        [
          r.id,
          r.jan_code ?? "",
          r.brand ?? "",
          r.product_name ?? "",
          r.model_number ?? "",
          getSupplierName(r.header?.supplier),
          r.header?.genre ?? "",
          r.base_price ?? "",
          r.effective_unit_price ?? "",
          r.created_at ?? "",
          r.registered_at ?? "",
          statusLabel(r.condition_type),
        ]
          .map((x) => escapeCsv(x))
          .join(",")
      );
      const csv = [header, ...lines].join("\r\n");
      const bom = "\uFEFF";
      const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "inventory_5years.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "CSVのダウンロードに失敗しました");
    } finally {
      setCsv5YearsLoading(false);
    }
  }, [getSupplierName]);

  const parseCsvLine = (line: string): string[] => {
    const result: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        let s = "";
        while (i < line.length) {
          if (line[i] === '"') {
            i++;
            if (line[i] === '"') {
              s += '"';
              i++;
            } else break;
          } else s += line[i++];
        }
        result.push(s);
        if (line[i] === ",") i++;
      } else {
        let s = "";
        while (i < line.length && line[i] !== ",") s += line[i++];
        result.push(s.trim());
        i++;
      }
    }
    return result;
  };

  type ParsedCsvRow = {
    id: string;
    jan_code: string;
    product_name: string;
    model_number: string;
    /** 仕入日 */
    created_at: string;
    /** 登録日 */
    registered_at: string;
    effective_unit_price: string;
    status: string;
    brand: string;
    supplier: string;
    genre: string;
    base_price: string;
    rawCells: string[];
  };

  const validateRow = (row: ParsedCsvRow): string[] => {
    const reasons: string[] = [];
    const createdAt = (row.created_at ?? "").trim() || (row.registered_at ?? "").trim();
    const effPrice = (row.effective_unit_price ?? "").trim();
    const status = (row.status ?? "").trim();
    if (!createdAt) reasons.push("必須A: インポート日付（仕入日）が未入力");
    if (!effPrice) reasons.push("必須A: 実質価格が未入力");
    if (!status) reasons.push("必須A: 状態が未入力");
    const jan = (row.jan_code ?? "").trim();
    const productName = (row.product_name ?? "").trim();
    const modelNum = (row.model_number ?? "").trim();
    if (!jan && !productName && !modelNum) reasons.push("必須B: JANコード・商品名・型番のいずれか1つ以上が必須です");
    return reasons;
  };

  const downloadErrorCsv = (errorRows: Array<{ row: ParsedCsvRow; reasons: string[] }>, headers: string[]) => {
    const headerLine = [...headers, "エラー理由"].map((h) => escapeCsv(h)).join(",");
    const lines = errorRows.map(({ row, reasons }) => {
      const reasonText = reasons.join("; ");
      return [...row.rawCells, reasonText].map((c) => escapeCsv(c)).join(",");
    });
    const csv = [headerLine, ...lines].join("\r\n");
    const bom = "\uFEFF";
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import_errors_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCsvImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setSaving(true);
      try {
        const text = await file.text();
        const rawLines = text.split(/\r?\n/).filter((line) => line.trim());
        if (rawLines.length < 2) {
          alert("CSVにデータ行がありません");
          setSaving(false);
          return;
        }
        const headerCells = parseCsvLine(rawLines[0]);
        const headers = headerCells.map((h) => h.toLowerCase().trim());
        const keyToAliases: Record<string, string[]> = {
          id: ["id"],
          jan_code: ["jan_code", "jan", "janコード"],
          product_name: ["product_name", "商品名"],
          model_number: ["model_number", "型番"],
          created_at: ["created_at", "仕入日", "インポート日付"],
          registered_at: ["registered_at", "登録日"],
          effective_unit_price: ["effective_unit_price", "実質価格", "実質単価"],
          status: ["status", "状態"],
          brand: ["brand", "ブランド"],
          supplier: ["supplier", "仕入先"],
          genre: ["genre", "ジャンル"],
          base_price: ["base_price", "基準価格"],
        };
        const get = (arr: string[], key: string): string => {
          const aliases = keyToAliases[key];
          if (!aliases) return "";
          for (const alias of aliases) {
            const idx = headers.findIndex((h) => h === alias);
            if (idx >= 0) return arr[idx] ?? "";
          }
          return "";
        };

        const parsed: ParsedCsvRow[] = [];
        for (let i = 1; i < rawLines.length; i++) {
          const cells = parseCsvLine(rawLines[i]);
          parsed.push({
            id: get(cells, "id"),
            jan_code: get(cells, "jan_code"),
            product_name: get(cells, "product_name"),
            model_number: get(cells, "model_number"),
            created_at: get(cells, "created_at"),
            registered_at: get(cells, "registered_at"),
            effective_unit_price: get(cells, "effective_unit_price"),
            status: get(cells, "status"),
            brand: get(cells, "brand"),
            supplier: get(cells, "supplier"),
            genre: get(cells, "genre"),
            base_price: get(cells, "base_price"),
            rawCells: cells,
          });
        }

        const errorRows: Array<{ row: ParsedCsvRow; reasons: string[] }> = [];
        const normalRows: ParsedCsvRow[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const reasons = validateRow(parsed[i]);
          if (reasons.length > 0) errorRows.push({ row: parsed[i], reasons });
          else normalRows.push(parsed[i]);
        }

        if (errorRows.length > 0) {
          downloadErrorCsv(errorRows, headerCells);
          alert(`バリデーションエラーが ${errorRows.length} 行あります。エラー内容を記載したCSV（import_errors_YYYYMMDD.csv）をダウンロードしました。`);
        }

        if (normalRows.length === 0) {
          setSaving(false);
          return;
        }

        const [productsRes, suppliersRes] = await Promise.all([
          fetch("/api/products"),
          fetch("/api/suppliers"),
        ]);
        const productsList: ProductMaster[] = productsRes.ok ? await productsRes.json() : [];
        const suppliersList: SupplierMaster[] = suppliersRes.ok ? await suppliersRes.json() : [];
        const productsByJan = new Map<string, ProductMaster>(productsList.map((p) => [p.jan_code, p]));

        const previewRows: CsvImportPreviewRow[] = normalRows.map((row) => {
          const jan = (row.jan_code ?? "").trim();
          const master = jan ? productsByJan.get(jan) : null;
          const product_name = (row.product_name ?? "").trim() || (master?.product_name ?? "") || "";
          const brand = (row.brand ?? "").trim() || (master?.brand ?? "") || "";
          const model_number = (row.model_number ?? "").trim() || (master?.model_number ?? "") || "";

          const supplierRaw = (row.supplier ?? "").trim();
          const supplierKana = supplierRaw ? normalizeToFullWidthKatakana(supplierRaw) : "";
          const supplierMatch = supplierKana
            ? suppliersList.some(
                (s) =>
                  s.kana === supplierKana ||
                  normalizeSupplierForMatch(s.name).includes(normalizeSupplierForMatch(supplierRaw)) ||
                  normalizeSupplierForMatch(s.kana).includes(normalizeSupplierForMatch(supplierKana))
              )
            : true;

          const warnings: ("jan_not_in_master" | "supplier_mismatch")[] = [];
          if (jan && !master) warnings.push("jan_not_in_master");
          if (supplierRaw && !supplierMatch) warnings.push("supplier_mismatch");

          return {
            id: row.id,
            jan_code: jan,
            product_name,
            brand,
            model_number,
            created_at: (row.created_at ?? "").trim(),
            registered_at: (row.registered_at ?? "").trim(),
            effective_unit_price: (row.effective_unit_price ?? "").trim(),
            status: (row.status ?? "").trim(),
            genre: (row.genre ?? "").trim(),
            base_price: (row.base_price ?? "").trim(),
            supplierRaw,
            supplierKana,
            warnings,
          };
        });

        setCsvImportPreview(previewRows);
      } catch (err) {
        alert(err instanceof Error ? err.message : "CSV取込に失敗しました");
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const statusToCondition = (s: string): string => {
    const t = (s ?? "").trim();
    if (t === "新品" || t === "new") return "new";
    if (t === "中古" || t === "used") return "used";
    return t || "new";
  };

  const executeCsvImportFromPreview = useCallback(async () => {
    if (!csvImportPreview || csvImportPreview.length === 0) return;
    setSaving(true);
    try {
      const items = csvImportPreview.map((row) => {
        const isoCreated = row.created_at ? slashedToIsoDate(row.created_at) : "";
        const isoRegistered = row.registered_at ? slashedToIsoDate(row.registered_at) : "";
        return {
          id: row.id ? Number(row.id) : undefined,
          jan_code: row.jan_code || undefined,
          brand: row.brand || undefined,
          product_name: row.product_name || undefined,
          model_number: row.model_number || undefined,
          supplier: row.supplierKana || undefined,
          genre: row.genre || undefined,
          base_price: row.base_price === "" ? undefined : Number(row.base_price),
          effective_unit_price: row.effective_unit_price === "" ? undefined : Number(row.effective_unit_price),
          created_at: isoCreated ? `${isoCreated}T00:00:00.000Z` : undefined,
          registered_at: isoRegistered ? `${isoRegistered}T00:00:00.000Z` : undefined,
          condition_type: statusToCondition(row.status),
        };
      });
      const res = await fetch("/api/infer-jan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "CSV取込に失敗しました");
      }
      setCsvImportPreview(null);
      await fetchRecords();
      alert(`${csvImportPreview.length} 件を取込ました`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "CSV取込に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [csvImportPreview, fetchRecords, slashedToIsoDate]);

  const closeCsvImportPreview = useCallback(() => {
    setCsvImportPreview(null);
  }, []);

  /** CSVプレビュー用: 日付を yyyy/mm/dd で表示（ISO も解釈） */
  const formatCsvPreviewDateDisplay = (raw: string) => {
    const t = (raw ?? "").trim();
    if (!t) return "—";
    if (t.includes("T") || /^\d{4}-\d{2}-\d{2}/.test(t)) {
      const sl = isoToSlashed(t);
      if (sl) return sl;
    }
    const n = normalizeDateToSlashed(t);
    return n.length >= 10 ? n : t;
  };

  /** 仕入日・登録日列。日付列が1つだけのときは両列に同じ値を表示 */
  const csvPreviewShiireAndTouroku = (row: CsvImportPreviewRow) => {
    const c = (row.created_at ?? "").trim();
    const r = (row.registered_at ?? "").trim();
    const single = c || r;
    const rawShiire = c || single;
    const rawTouroku = r || single;
    return {
      shiire: formatCsvPreviewDateDisplay(rawShiire),
      touroku: formatCsvPreviewDateDisplay(rawTouroku),
    };
  };

  return (
    <div className="flex-1 flex flex-col">
      <main className="flex-1 w-full max-w-[min(100%,1900px)] mx-auto px-3 sm:px-4 lg:px-6 py-6">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur shrink-0 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <DocumentIcon className="h-5 w-5 text-primary" />
              在庫一覧
            </h2>
            {!loading && !error && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setInventoryModalOpen(true)}
                  className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 h-9 px-4 text-sm`}
                >
                  <PackageMinus className="mr-2 h-4 w-4 shrink-0" />
                  在庫調整
                </button>
                <button
                  type="button"
                  onClick={downloadCsv5Years}
                  disabled={csv5YearsLoading}
                  className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 h-9 px-4 text-sm disabled:opacity-50`}
                >
                  <Download className="mr-2 h-4 w-4 shrink-0" />
                  {csv5YearsLoading ? "取得中..." : "過去5年分のデータをCSVダウンロード"}
                </button>
              </div>
            )}
          </div>

          {!loading && !error && (
            <>
              <div className="px-6 py-3 border-b border-slate-100 bg-white shrink-0">
                <div className="relative rounded-lg border border-slate-200 bg-white shadow-sm focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/40 transition-all max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="ID・JAN・ASIN・注文番号・商品名・仕入先・コンディションで検索..."
                    className={`${inputClass} pl-10 rounded-lg border-0 focus-visible:ring-0`}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white shrink-0">
                {!isBulkEditing ? (
                  <>
                    {rows.length > 0 && (
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-600">
                          <input
                            type="checkbox"
                            checked={selectedIds.size === rows.length}
                            onChange={toggleSelectAll}
                            className="rounded border-slate-300 text-primary focus:ring-primary"
                          />
                          全選択/解除
                        </label>
                        <select
                          value={bulkAction}
                          onChange={(e) => setBulkAction(e.target.value)}
                          className={`${inputClass} w-auto min-w-[120px] h-9 py-1`}
                        >
                          <option value="bulk_delete">一括削除</option>
                        </select>
                        <button
                          type="button"
                          onClick={executeBulkAction}
                          disabled={selectedIds.size === 0 || saving}
                          className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50`}
                        >
                          実行
                        </button>
                      </div>
                    )}
                    <div
                      className={
                        rows.length > 0
                          ? "ml-auto flex flex-wrap items-center gap-3"
                          : "ml-auto flex w-full flex-wrap items-center justify-end gap-3"
                      }
                    >
                      <input
                        type="file"
                        accept=".csv"
                        ref={csvInputRef}
                        className="hidden"
                        onChange={handleCsvImport}
                      />
                      <button
                        type="button"
                        onClick={handleCsvExport}
                        className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        CSV出力（Download）
                      </button>
                      <button
                        type="button"
                        onClick={() => csvInputRef.current?.click()}
                        disabled={saving}
                        className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50`}
                      >
                        <Upload className="mr-2 h-4 w-4" />
                        CSV取込（Upload）
                      </button>
                      {rows.length > 0 && (
                        <button
                          type="button"
                          onClick={startBulkEdit}
                          className={`${buttonClass} bg-white text-primary border border-primary/20 hover:bg-primary/5`}
                        >
                          一括編集
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={saveBulkEdit}
                      disabled={saving}
                      className={`${buttonClass} bg-primary text-white hover:bg-primary/90`}
                    >
                      {saving ? "保存中..." : "全保存"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelBulkEdit}
                      className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
                    >
                      全解除
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

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
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/50 py-16 text-center">
                <p className="text-sm font-medium text-slate-600">データがありません</p>
              </div>
            )}
            {!loading && !error && rows.length > 0 && (
              <div className="relative w-full max-h-[calc(100vh-280px)] overflow-y-auto overflow-x-hidden border border-slate-200 rounded-md">
                <table className="w-full table-fixed border-collapse text-left text-[11px] leading-snug sm:text-xs">
                    <colgroup>
                      <col style={{ width: "1.5%" }} />
                      <col style={{ width: "2%" }} />
                      <col style={{ width: "4%" }} />
                      <col style={{ width: "4%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "5%" }} />
                      <col style={{ width: "6%" }} />
                      <col style={{ width: "3%" }} />
                      <col style={{ width: "29.5%" }} />
                      <col style={{ width: "4.5%" }} />
                      <col style={{ width: "4.5%" }} />
                      <col style={{ width: "4%" }} />
                      <col style={{ width: "4%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "4%" }} />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-white border-b border-slate-200 text-[10px] uppercase text-slate-500 font-semibold tracking-wider shadow-sm sm:text-xs">
                    <tr>
                      <th className="px-0.5 py-2 text-center align-middle"></th>
                      <th className="px-0.5 py-2 text-center font-mono text-[10px] align-middle sm:text-xs">
                        <button
                          type="button"
                          onClick={() => requestSort("id")}
                          className="inline-flex items-center justify-center gap-1 whitespace-nowrap hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded mx-auto"
                        >
                          ID
                          {sortConfig.key === "id" ? (
                            sortConfig.direction === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("created_at")} className="inline-flex max-w-full items-center gap-0.5 truncate hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          仕入日
                          {sortConfig.key === "created_at" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("registered_at")} className="inline-flex max-w-full items-center gap-0.5 truncate hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          登録日
                          {sortConfig.key === "registered_at" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="min-w-0 px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("supplier")} className="inline-flex w-full min-w-0 max-w-full items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="min-w-0 truncate">仕入先</span>
                          {sortConfig.key === "supplier" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="min-w-0 px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("genre")} className="inline-flex w-full min-w-0 max-w-full items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="min-w-0 truncate">ジャンル</span>
                          {sortConfig.key === "genre" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("jan_code")} className="inline-flex items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          JAN
                          {sortConfig.key === "jan_code" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-0.5 py-2 align-middle text-center">
                        <button
                          type="button"
                          onClick={() => requestSort("condition_type")}
                          className="inline-flex w-full min-w-0 flex-col items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded sm:flex-row sm:justify-center"
                        >
                          <abbr title="コンディション" className="cursor-help no-underline">
                            状態
                          </abbr>
                          {sortConfig.key === "condition_type" ? (
                            sortConfig.direction === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="min-w-0 px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("product_name")} className="inline-flex w-full min-w-0 max-w-full items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="min-w-0 truncate">商品名</span>
                          {sortConfig.key === "product_name" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="min-w-0 px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("brand")} className="inline-flex w-full min-w-0 max-w-full items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="min-w-0 max-w-[160px] truncate sm:max-w-full">ブランド</span>
                          {sortConfig.key === "brand" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="min-w-0 px-1 py-2 align-middle">
                        <button type="button" onClick={() => requestSort("model_number")} className="inline-flex w-full min-w-0 max-w-full items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="min-w-0 max-w-[160px] truncate sm:max-w-full">型番</span>
                          {sortConfig.key === "model_number" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-0.5 py-2 text-right align-middle">
                        <button type="button" onClick={() => requestSort("base_price")} className="inline-flex w-full items-center justify-end gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="truncate">基準</span>
                          {sortConfig.key === "base_price" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-0.5 py-2 text-right align-middle">
                        <button type="button" onClick={() => requestSort("effective_unit_price")} className="inline-flex w-full items-center justify-end gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          <span className="truncate" title="実質単価">
                            実質
                          </span>
                          {sortConfig.key === "effective_unit_price" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-0.5 py-2 text-left align-middle">
                        <button
                          type="button"
                          onClick={() => requestSort("inventory_progress")}
                          className="inline-flex w-full items-center gap-0.5 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded text-slate-500"
                        >
                          進捗
                          {sortConfig.key === "inventory_progress" ? (
                            sortConfig.direction === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="px-0.5 py-2 text-center align-middle text-slate-500">
                        <button
                          type="button"
                          onClick={() => requestSort("order_id")}
                          className="inline-flex items-center justify-center gap-1 whitespace-nowrap hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded mx-auto"
                        >
                          <abbr title="Amazon注文番号" className="cursor-help no-underline">
                            注文
                          </abbr>
                          {sortConfig.key === "order_id" ? (
                            sortConfig.direction === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="bg-white px-0.5 py-2 text-center align-middle text-slate-500 shadow-[-6px_0_10px_-4px_rgba(15,23,42,0.1)]">
                        操作
                      </th>
                    </tr>

                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {processedRows.map((row) => {
                      const isIndividualEdit = editingId === row.id;
                      const isEditMode = isIndividualEdit || isBulkEditing;
                      const displayDate = formatDate(row.header?.purchase_date ?? row.created_at);
                      const invStatus = getInventoryStatusDisplay({
                        order_id: row.order_id,
                        settled_at: row.settled_at,
                        exit_type: row.exit_type,
                        stock_status: row.stock_status,
                      });

                      return (
                        <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-0.5 py-2 text-center align-middle">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.id)}
                              onChange={(e) => {
                                // Shiftキーは nativeEvent で取得
                                const nativeEvent = e.nativeEvent as MouseEvent;
                                toggleSelect(row.id, nativeEvent.shiftKey);
                              }}
                              className="rounded border-slate-300 text-primary focus:ring-primary"
                            />
                          </td>
                          <td className="min-w-0 px-0.5 py-2 text-center font-mono text-[10px] text-slate-600 align-middle tabular-nums sm:text-[11px]">
                            {row.id}
                          </td>
                          <td className="min-w-0 px-1 py-2 text-slate-600 align-middle text-[11px] tabular-nums">
                            {isEditMode ? (
                              <div className="flex min-w-0 w-full max-w-full flex-nowrap items-center gap-1">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  placeholder="yyyy/mm/dd"
                                  {...(isIndividualEdit && editDraft
                                    ? {
                                        value: editDraft.created_at,
                                        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                                          setEditDraft((d) => (d ? { ...d, created_at: e.target.value } : d)),
                                      }
                                    : {
                                        key: `${row.id}-${row.created_at}`,
                                        defaultValue: isoToSlashed(row.created_at),
                                      })}
                                  onBlur={(e) => {
                                    const n = normalizeDateToSlashed(e.target.value);
                                    if (isIndividualEdit && editDraft) {
                                      setEditDraft((d) => (d ? { ...d, created_at: n } : d));
                                    } else if (n) {
                                      updateRowField(row.id, "created_at", `${slashedToIsoDate(n)}T00:00:00.000Z`);
                                    }
                                  }}
                                  className={`${inputClass} h-9 text-xs min-w-[110px]`}
                                />
                                <input
                                  type="date"
                                  className="sr-only"
                                  tabIndex={-1}
                                  aria-hidden
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (!v) return;
                                    const slashed = isoToSlashed(v + "T00:00:00.000Z");
                                    if (isIndividualEdit && editDraft) {
                                      setEditDraft((d) => (d ? { ...d, created_at: slashed } : d));
                                    } else {
                                      updateRowField(row.id, "created_at", `${v}T00:00:00.000Z`);
                                    }
                                    e.target.value = "";
                                  }}
                                />
                                <button
                                  type="button"
                                  title="カレンダーで選択"
                                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-primary"
                                  onClick={(e) => {
                                    const wrap = e.currentTarget.parentElement;
                                    const dateInp = wrap?.querySelector('input[type="date"]') as HTMLInputElement | null;
                                    dateInp?.showPicker?.();
                                  }}
                                >
                                  <Calendar className="h-4 w-4" />
                                </button>
                              </div>
                            ) : (
                              displayDate
                            )}
                          </td>
                          <td className="min-w-0 px-1 py-2 text-slate-600 align-middle text-[11px] tabular-nums">
  {isEditMode ? (
    <div className="flex min-w-0 w-full max-w-full flex-nowrap items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        placeholder="yyyy/mm/dd"
        {...(isIndividualEdit && editDraft
          ? {
              value: editDraft.registered_at,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                setEditDraft((d) => (d ? { ...d, registered_at: e.target.value } : d)),
            }
          : {
              key: `${row.id}-${row.registered_at}`,
              defaultValue: isoToSlashed(row.registered_at ?? ""),
            })}
        onBlur={(e) => {
          const n = normalizeDateToSlashed(e.target.value);
          if (isIndividualEdit && editDraft) {
            setEditDraft((d) => (d ? { ...d, registered_at: n } : d));
          } else if (n) {
            updateRowField(row.id, "registered_at", `${slashedToIsoDate(n)}T00:00:00.000Z`);
          }
        }}
        className={`${inputClass} h-9 text-xs min-w-[110px]`}
      />
      <input
        type="date"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const slashed = isoToSlashed(v + "T00:00:00.000Z");
          if (isIndividualEdit && editDraft) {
            setEditDraft((d) => (d ? { ...d, registered_at: slashed } : d));
          } else {
            updateRowField(row.id, "registered_at", `${v}T00:00:00.000Z`);
          }
          e.target.value = "";
        }}
      />
      <button
        type="button"
        title="カレンダーで選択"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-primary"
        onClick={(e) => {
          const wrap = e.currentTarget.parentElement;
          const dateInp = wrap?.querySelector('input[type="date"]') as HTMLInputElement | null;
          dateInp?.showPicker?.();
        }}
      >
        <Calendar className="h-4 w-4" />
      </button>
    </div>
  ) : (
    formatDate(row.registered_at ?? row.created_at)
  )}
</td>
                          <td className="min-w-0 px-1 py-2 text-slate-700 align-middle">
                             {isEditMode ? (
                                <input
                                    value={isIndividualEdit && editDraft ? editDraft.supplier : row.header?.supplier ?? ""}
                                    onChange={(e) =>
                                        isIndividualEdit && editDraft
                                          ? setEditDraft((d) => (d ? { ...d, supplier: e.target.value } : d))
                                          : updateRowHeaderField(row.id, "supplier", e.target.value)
                                    }
                                    // 🌟 変更点: ここで編集してもカナ変換されるようにした
                                    onBlur={(e) => {
                                        const kana = normalizeToFullWidthKatakana(e.target.value);
                                        if (isIndividualEdit && editDraft) {
                                            setEditDraft((d) => (d ? { ...d, supplier: kana } : d));
                                        } else {
                                            updateRowHeaderField(row.id, "supplier", kana);
                                        }
                                    }}
                                    className={`${inputClass} h-9 min-w-0 w-full max-w-full text-xs`}
                                    placeholder="仕入先カナ"
                                />
                             ) : (
                                <span
                                  className="block min-w-0 truncate"
                                  title={getSupplierName(row.header?.supplier)}
                                >
                                  {getSupplierName(row.header?.supplier)}
                                </span>
                             )}
                          </td>
                          <td className="min-w-0 px-1 py-2 text-slate-600 align-middle">
                             {isEditMode ? (
                                <input
                                    value={isIndividualEdit && editDraft ? editDraft.genre : row.header?.genre ?? ""}
                                    onChange={(e) =>
                                        isIndividualEdit && editDraft
                                          ? setEditDraft((d) => (d ? { ...d, genre: e.target.value } : d))
                                          : updateRowHeaderField(row.id, "genre", e.target.value)
                                    }
                                    className={`${inputClass} h-9 min-w-0 w-full max-w-full text-xs`}
                                    placeholder="ジャンル"
                                />
                             ) : (
                                <span
                                  className="block min-w-0 truncate"
                                  title={row.header?.genre ?? undefined}
                                >
                                  {row.header?.genre ?? "—"}
                                </span>
                             )}
                          </td>
                          <td className="min-w-0 px-1 py-2 align-middle font-mono text-[10px] sm:text-[11px]">
                            <span className="block truncate" title={row.jan_code ?? undefined}>
                              {row.jan_code ?? "—"}
                            </span>
                          </td>
                          <td className="min-w-0 px-0.5 py-2 align-middle text-slate-700">
                            <span
                              className={
                                row.condition_type === "new"
                                  ? "font-medium text-emerald-700"
                                  : row.condition_type === "used" || (row.condition_type && row.condition_type !== "new")
                                    ? "font-medium text-amber-800"
                                    : "text-slate-500"
                              }
                              title={row.condition_type ?? undefined}
                            >
                              {statusLabel(row.condition_type) || "—"}
                            </span>
                          </td>
                          <td className="min-w-0 px-1 py-2 align-middle font-medium text-slate-900">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.product_name : row.product_name ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, product_name: e.target.value } : d))
                                    : updateRowField(row.id, "product_name", e.target.value)
                                }
                                disabled={isBulkEditing}
                                className={`${inputClass} h-9 min-w-0 w-full max-w-full font-medium`}
                                placeholder="商品名"
                              />
                            ) : (
                              <span className="block min-w-0 truncate" title={row.product_name ?? undefined}>
                                {row.product_name ?? "—"}
                              </span>
                            )}
                          </td>
                          <td className="min-w-0 px-1 py-2 text-slate-600 align-middle">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.brand : row.brand ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, brand: e.target.value } : d))
                                    : updateRowField(row.id, "brand", e.target.value)
                                }
                                disabled={isBulkEditing}
                                className={`${inputClass} h-9 min-w-0 w-full max-w-full text-xs`}
                                placeholder="ブランド"
                              />
                            ) : (
                              <span
                                className="block min-w-0 max-w-[160px] truncate sm:max-w-full"
                                title={row.brand ?? undefined}
                              >
                                {row.brand ?? "—"}
                              </span>
                            )}
                          </td>
                          <td className="min-w-0 px-1 py-2 text-slate-600 align-middle">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.model_number : row.model_number ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, model_number: e.target.value } : d))
                                    : updateRowField(row.id, "model_number", e.target.value)
                                }
                                disabled={isBulkEditing}
                                className={`${inputClass} h-9 min-w-0 w-full max-w-full text-xs`}
                                placeholder="型番"
                              />
                            ) : (
                              <span
                                className="block min-w-0 max-w-[160px] truncate sm:max-w-full"
                                title={row.model_number ?? undefined}
                              >
                                {row.model_number ?? "—"}
                              </span>
                            )}
                          </td>
                          <td className="min-w-0 px-0.5 py-2 text-right align-middle font-mono text-[10px] tabular-nums sm:text-[11px]">
                            {row.base_price > 0 ? `${row.base_price.toLocaleString()}円` : "—"}
                          </td>
                          <td className="min-w-0 px-0.5 py-2 text-right align-middle font-mono text-[10px] font-medium tabular-nums sm:text-[11px]">
                            {row.effective_unit_price > 0 ? `${Math.round(row.effective_unit_price).toLocaleString()}円` : "—"}
                          </td>
                          <td className="min-w-0 px-0.5 py-2 align-middle">
                            <span
                              className={`inline-flex max-w-full whitespace-normal break-words rounded-full px-1.5 py-0.5 text-center text-[8px] font-bold leading-tight sm:text-[9px] ${invStatus.badgeClassName}`}
                            >
                              {invStatus.label}
                            </span>
                          </td>
                          <td className="min-w-0 px-0.5 py-2 text-center align-middle font-mono text-[10px] sm:text-[11px]">
                            {row.order_id ? (
                              <a
                                href={`https://sellercentral.amazon.co.jp/orders-v3/order/${row.order_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block truncate text-blue-600 hover:underline"
                                title={row.order_id}
                              >
                                {row.order_id}
                              </a>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="min-w-0 bg-white px-0.5 py-1.5 text-center align-middle shadow-[-6px_0_10px_-4px_rgba(15,23,42,0.1)]">
                            {isIndividualEdit ? (
                              <div className="inline-flex items-center justify-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={saveIndividualEdit}
                                  disabled={saving}
                                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary p-0 text-white shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                                  title="保存"
                                >
                                  <Save className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelIndividualEdit}
                                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white p-0 text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  title="取消"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : !isBulkEditing ? (
                              <button
                                type="button"
                                onClick={() => startIndividualEdit(row)}
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white p-0 text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98]"
                                title="編集"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  </table>
              </div>
            )}

            {!loading && !error && rows.length > 0 && isBulkEditing && (
              <div className="flex items-center gap-3 pt-4 mt-4 border-t border-slate-100">
                <div className="ml-auto flex items-center gap-3">
                    <button
                        type="button"
                        onClick={saveBulkEdit}
                        disabled={saving}
                        className={`${buttonClass} bg-primary text-white hover:bg-primary/90`}
                    >
                        {saving ? "保存中..." : "保存"}
                    </button>
                    <button
                        type="button"
                        onClick={cancelBulkEdit}
                        className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
                    >
                        解除
                    </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {inventoryModalOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-adjust-title"
          onClick={() => !inventorySubmitting && setInventoryModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 id="inventory-adjust-title" className="text-base font-bold text-slate-800">
                在庫調整
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                破損・紛失・社内使用・接待など、古い在庫から指定件数に <code className="text-[11px]">exit_type</code> を付与します。
              </p>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <label className="text-xs font-semibold text-slate-600 block mb-1">JANコード</label>
                <input
                  type="text"
                  value={invJan}
                  onChange={(e) => setInvJan(e.target.value)}
                  className={inputClass}
                  placeholder="例: 4901234567890"
                  disabled={inventorySubmitting}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 block mb-1">コンディション</label>
                <select
                  value={invCondition}
                  onChange={(e) => setInvCondition(e.target.value as "new" | "used")}
                  className={`${inputClass} h-10`}
                  disabled={inventorySubmitting}
                >
                  <option value="new">新品 (new)</option>
                  <option value="used">中古 (used)</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 block mb-1">処理する個数（1以上）</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={invQuantity}
                  onChange={(e) => setInvQuantity(e.target.value)}
                  className={inputClass}
                  disabled={inventorySubmitting}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 block mb-1">理由</label>
                <select
                  value={invReason}
                  onChange={(e) =>
                    setInvReason(e.target.value as "damaged" | "lost" | "internal_use" | "entertainment")
                  }
                  className={`${inputClass} h-10`}
                  disabled={inventorySubmitting}
                >
                  <option value="damaged">破損 (damaged)</option>
                  <option value="lost">紛失 (lost)</option>
                  <option value="internal_use">社内使用 (internal_use)</option>
                  <option value="entertainment">接待 (entertainment)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4 bg-slate-50/80 rounded-b-xl">
              <button
                type="button"
                onClick={() => !inventorySubmitting && setInventoryModalOpen(false)}
                className={`${buttonClass} bg-white text-slate-700 border border-slate-200 h-9 px-4 text-sm`}
                disabled={inventorySubmitting}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void submitInventoryAdjustment()}
                disabled={inventorySubmitting}
                className={`${buttonClass} bg-primary text-white hover:bg-primary/90 h-9 px-4 text-sm disabled:opacity-50`}
              >
                {inventorySubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    実行中...
                  </>
                ) : (
                  "実行"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {csvImportPreview !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-[1400px] max-h-[90vh] rounded-2xl border border-slate-200 bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900">CSV取込プレビュー（マスタ照合結果）</h3>
              <button
                type="button"
                onClick={closeCsvImportPreview}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-4 py-2 border-b border-slate-100 bg-slate-50/80 text-sm text-slate-600">
              {csvImportPreview.filter((r) => r.warnings.length > 0).length > 0 ? (
                <span>
                  警告あり: {csvImportPreview.filter((r) => r.warnings.length > 0).length} 行
                  （取込を実行しても保存できます）
                </span>
              ) : (
                <span>全行マスタ照合済み。問題がなければ「取込を実行」を押してください。</span>
              )}
            </div>
            <div className="overflow-auto flex-1 p-4">
              <table className="w-full text-sm text-left min-w-[1000px]">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                  <tr>
                    <th className="px-3 py-2 align-top">警告</th>
                    <th className="px-3 py-2 align-top">仕入日</th>
                    <th className="px-3 py-2 align-top">登録日</th>
                    <th className="px-3 py-2 align-top">仕入先</th>
                    <th className="px-3 py-2 align-top">JAN</th>
                    <th className="px-3 py-2 min-w-[160px] max-w-[240px] align-top">商品名</th>
                    <th className="px-3 py-2 align-top">ブランド</th>
                    <th className="px-3 py-2 align-top">型番</th>
                    <th className="px-3 py-2 text-right align-top">実質単価</th>
                    <th className="px-3 py-2 align-top">状態</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {csvImportPreview.map((row, idx) => {
                    const { shiire, touroku } = csvPreviewShiireAndTouroku(row);
                    return (
                    <tr key={idx} className={row.warnings.length > 0 ? "bg-amber-50/50" : ""}>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {row.warnings.includes("jan_not_in_master") && (
                            <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 border border-red-200">
                              JAN未登録
                            </span>
                          )}
                          {row.warnings.includes("supplier_mismatch") && (
                            <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
                              仕入先不一致
                            </span>
                          )}
                          {row.warnings.length === 0 && <span className="text-slate-400 text-xs">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700 tabular-nums break-all align-top" title={row.created_at || row.registered_at || undefined}>
                        {shiire}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700 tabular-nums break-all align-top" title={row.registered_at || row.created_at || undefined}>
                        {touroku}
                      </td>
                      <td className="px-3 py-2 text-slate-700 break-words align-top">{row.supplierRaw || row.supplierKana || "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs break-all align-top">{row.jan_code || "—"}</td>
                      <td className="px-3 py-2 font-medium text-slate-900 min-w-0 max-w-[240px] break-words align-top [overflow-wrap:anywhere]">{row.product_name || "—"}</td>
                      <td className="px-3 py-2 text-slate-600 break-words align-top">{row.brand || "—"}</td>
                      <td className="px-3 py-2 text-slate-600 break-words align-top">{row.model_number || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums align-top">{row.effective_unit_price || "—"}</td>
                      <td className="px-3 py-2 text-slate-600 align-top">{row.status === "new" || row.status === "新品" ? "新品" : row.status === "used" || row.status === "中古" ? "中古" : row.status || "—"}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-3 p-4 border-t border-slate-100 bg-slate-50/50">
              <button
                type="button"
                onClick={closeCsvImportPreview}
                className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={executeCsvImportFromPreview}
                disabled={saving}
                className={`${buttonClass} bg-primary text-white hover:bg-primary/90 disabled:opacity-50`}
              >
                {saving ? "取込中..." : "取込を実行"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}