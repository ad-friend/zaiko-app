"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Pencil, Save, X, ChevronLeft, Download, Upload, Search, ArrowUp, ArrowDown, ArrowUpDown, Calendar } from "lucide-react";
import { normalizeToFullWidthKatakana } from "@/lib/kana";
import { normalizeSupplierForMatch } from "@/lib/normalizeSupplier";

type RecordRow = {
  id: number;
  registered_at?: string;
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
};

/** CSV取込プレビュー用：マスタ照合・補完・警告フラグ付きの1行 */
type CsvImportPreviewRow = {
  jan_code: string;
  product_name: string;
  brand: string;
  model_number: string;
  created_at: string;
  effective_unit_price: string;
  status: string;
  genre: string;
  base_price: string;
  supplierRaw: string;
  supplierKana: string;
  warnings: ("jan_not_in_master" | "supplier_mismatch")[];
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

const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
// px-4 -> px-6
const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

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
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvImportPreview, setCsvImportPreview] = useState<CsvImportPreviewRow[] | null>(null);

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
      setRows(recordsData);

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
      case "registered_at":
        return row.registered_at ?? row.created_at ?? "";
      case "created_at":
        return row.created_at ?? row.header?.created_at ?? "";
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
      list = list.filter(
        (r) =>
          (r.jan_code ?? "").toLowerCase().includes(term) ||
          (r.brand ?? "").toLowerCase().includes(term) ||
          (r.product_name ?? "").toLowerCase().includes(term) ||
          (r.model_number ?? "").toLowerCase().includes(term) ||
          // 🌟 変更点：検索時も「正式名称」と「カナ」の両方で引っかかるようにする
          (getSupplierName(r.header?.supplier)).toLowerCase().includes(term) ||
          (r.header?.supplier ?? "").toLowerCase().includes(term)
      );
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
        return direction === "asc" ? cmp : -cmp;
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
      const res = await fetch("/api/infer-jan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          brand: editDraft.brand,
          product_name: editDraft.product_name,
          model_number: editDraft.model_number,
          supplier: kanaSupplier, // 🌟 変換したカナを送信
          genre: editDraft.genre,
          base_price: editDraft.base_price,
          effective_unit_price: editDraft.effective_unit_price,
          ...(created_at && { created_at }),
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
        supplier: normalizeToFullWidthKatakana(r.header?.supplier ?? ""), // 🌟 一括保存時もカナ変換を強制
        genre: r.header?.genre ?? "",
        registered_at: r.registered_at, //
        ...(r.created_at && { created_at: r.created_at }),
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
        if (!res.ok) throw new Error("削除に失敗しました");
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

  const statusLabel = (c: string | null | undefined): string => {
    if (c === "new") return "新品";
    if (c === "used") return "中古";
    return c ?? "";
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
    created_at: string;
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
    const createdAt = (row.created_at ?? "").trim();
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
          created_at: ["created_at", "仕入日", "登録日", "インポート日付"],
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
            jan_code: jan,
            product_name,
            brand,
            model_number,
            created_at: (row.created_at ?? "").trim(),
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
      const items = csvImportPreview.map((row) => ({
        jan_code: row.jan_code || undefined,
        brand: row.brand || undefined,
        product_name: row.product_name || undefined,
        model_number: row.model_number || undefined,
        supplier: row.supplierKana || undefined,
        genre: row.genre || undefined,
        base_price: row.base_price === "" ? undefined : Number(row.base_price),
        effective_unit_price: row.effective_unit_price === "" ? undefined : Number(row.effective_unit_price),
        created_at: row.created_at || undefined,
        condition_type: statusToCondition(row.status),
      }));
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
  }, [csvImportPreview, fetchRecords]);

  const closeCsvImportPreview = useCallback(() => {
    setCsvImportPreview(null);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-30 w-full border-b bg-white/80 backdrop-blur-md shadow-sm">
        <div className="container mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 text-slate-900 hover:opacity-80 transition-opacity">
              <div className="rounded-lg bg-primary p-1.5 text-white shadow-md shadow-primary/30">
                <BarcodeIcon className="h-5 w-5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Zaiko Manager <span className="text-xs font-normal text-slate-500 ml-2 bg-slate-100 px-2 py-0.5 rounded-full">Professional</span></h1>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/suppliers" className="text-sm font-medium text-slate-500 hover:text-primary transition-colors mr-2">仕入先管理</Link>
            <Link href="/products" className="text-sm font-medium text-slate-500 hover:text-primary transition-colors mr-2">商品マスタ</Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 h-10 px-6 py-2 shadow-sm bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300"
            >
              <ChevronLeft className="mr-2 h-4 w-4" />
              入庫画面へ戻る
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 py-8 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <DocumentIcon className="h-5 w-5 text-primary" />
              在庫一覧
            </h2>
          </div>

          {!loading && !error && rows.length > 0 && (
            <div className="px-6 py-3 border-b border-slate-100 bg-white">
              <div className="relative rounded-lg border border-slate-200 bg-white shadow-sm focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/40 transition-all max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="商品名やJAN、仕入先で検索..."
                  className={`${inputClass} pl-10 rounded-lg border-0 focus-visible:ring-0`}
                />
              </div>
            </div>
          )}

          {!loading && !error && rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white">
              {!isBulkEditing ? (
                <>
                  {/* 左側固定：全選択、操作プルダウン、実行ボタン */}
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-600">
                        <input
                        type="checkbox"
                        checked={rows.length > 0 && selectedIds.size === rows.length}
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
                  
                  {/* 右側：CSV出力・取込、一括編集 */}
                  <div className="ml-auto flex items-center gap-3">
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
                    <button
                        type="button"
                        onClick={startBulkEdit}
                        className={`${buttonClass} bg-white text-primary border border-primary/20 hover:bg-primary/5`}
                    >
                        一括編集
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* 右側：保存、解除ボタン */}
                  <div className="ml-auto flex items-center gap-3">
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
                </>
              )}
            </div>
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
              <p className="text-sm text-slate-400 py-8 text-center">登録データがありません</p>
            )}
            {!loading && !error && rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[1000px]">
                  <thead className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                    <tr>
                      <th className="px-6 py-4 w-[44px] text-center whitespace-nowrap"></th>
                      <th className="px-6 py-4 min-w-[100px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("created_at")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                              仕入日
                          {sortConfig.key === "created_at" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[100px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("registered_at")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          登録日
                          {sortConfig.key === "registered_at" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[90px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("supplier")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          仕入先
                          {sortConfig.key === "supplier" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[80px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("genre")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          ジャンル
                          {sortConfig.key === "genre" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 w-[140px] min-w-[120px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("jan_code")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          JAN
                          {sortConfig.key === "jan_code" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[180px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("product_name")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          商品名
                          {sortConfig.key === "product_name" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[90px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("brand")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          ブランド
                          {sortConfig.key === "brand" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[100px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("model_number")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          型番
                          {sortConfig.key === "model_number" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 text-right min-w-[90px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("base_price")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded ml-auto">
                          基準価格
                          {sortConfig.key === "base_price" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 text-right min-w-[90px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("effective_unit_price")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded ml-auto">
                          実質単価
                          {sortConfig.key === "effective_unit_price" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 min-w-[60px] whitespace-nowrap">
                        <button type="button" onClick={() => requestSort("condition_type")} className="inline-flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded">
                          状態
                          {sortConfig.key === "condition_type" ? (sortConfig.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        </button>
                      </th>
                      <th className="px-6 py-4 w-[100px] min-w-[80px] text-center whitespace-nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {processedRows.map((row) => {
                      const isIndividualEdit = editingId === row.id;
                      const isEditMode = isIndividualEdit || isBulkEditing;
                      const displayDate = formatDate(row.header?.created_at ?? row.created_at);

                      return (
                        <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4 text-center align-middle">
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
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap">
                            {isEditMode ? (
                              <div className="flex items-center gap-1">
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
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap">
  {isEditMode ? (
    <div className="flex items-center gap-1">
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
                          <td className="px-6 py-4 text-slate-700 whitespace-nowrap">
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
                                    className={`${inputClass} h-9 text-xs`}
                                    placeholder="仕入先カナ"
                                />
                             ) : (
                                // 🌟 変更点: 表示時はマスターから正式名称を引いてくる！
                                getSupplierName(row.header?.supplier)
                             )}
                          </td>
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap">
                             {isEditMode ? (
                                <input
                                    value={isIndividualEdit && editDraft ? editDraft.genre : row.header?.genre ?? ""}
                                    onChange={(e) =>
                                        isIndividualEdit && editDraft
                                          ? setEditDraft((d) => (d ? { ...d, genre: e.target.value } : d))
                                          : updateRowHeaderField(row.id, "genre", e.target.value)
                                    }
                                    className={`${inputClass} h-9 text-xs`}
                                    placeholder="ジャンル"
                                />
                             ) : (
                                row.header?.genre ?? "—"
                             )}
                          </td>
                          <td className="px-6 py-4 font-mono text-xs whitespace-nowrap">{row.jan_code ?? "—"}</td>
                          <td className="px-6 py-4 font-medium text-slate-900 min-w-[140px]">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.product_name : row.product_name ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, product_name: e.target.value } : d))
                                    : updateRowField(row.id, "product_name", e.target.value)
                                }
                                disabled={isBulkEditing}
                                className={`${inputClass} h-9 font-medium`}
                                placeholder="商品名"
                              />
                            ) : (
                              row.product_name ?? "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap min-w-[80px]">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.brand : row.brand ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, brand: e.target.value } : d))
                                    : updateRowField(row.id, "brand", e.target.value)
                                }
                                disabled={isBulkEditing}
                                className={`${inputClass} h-9`}
                                placeholder="ブランド"
                              />
                            ) : (
                              row.brand ?? "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap min-w-[80px]">
                            {isEditMode ? (
                              <input
                                value={isIndividualEdit && editDraft ? editDraft.model_number : row.model_number ?? ""}
                                onChange={(e) =>
                                  isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, model_number: e.target.value } : d))
                                    : updateRowField(row.id, "model_number", e.target.value)
                                }
                                disabled={isBulkEditing}
                                className={`${inputClass} h-9`}
                                placeholder="型番"
                              />
                            ) : (
                              row.model_number ?? "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-right tabular-nums whitespace-nowrap">
                            {isEditMode ? (
                                <input
                                type="number"
                                value={isIndividualEdit && editDraft ? editDraft.base_price : row.base_price}
                                onChange={(e) =>
                                    isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, base_price: Number(e.target.value) } : d))
                                    : updateRowField(row.id, "base_price", Number(e.target.value))
                                }
                                className={`${inputClass} h-9 text-right`}
                                />
                            ) : (
                                row.base_price > 0 ? row.base_price.toLocaleString() + " 円" : "—"
                            )}
                          </td>
                          <td className="px-6 py-4 text-right font-medium tabular-nums whitespace-nowrap">
                             {isEditMode ? (
                                <input
                                type="number"
                                value={isIndividualEdit && editDraft ? editDraft.effective_unit_price : row.effective_unit_price}
                                onChange={(e) =>
                                    isIndividualEdit && editDraft
                                    ? setEditDraft((d) => (d ? { ...d, effective_unit_price: Number(e.target.value) } : d))
                                    : updateRowField(row.id, "effective_unit_price", Number(e.target.value))
                                }
                                className={`${inputClass} h-9 text-right`}
                                />
                             ) : (
                                row.effective_unit_price > 0 ? Math.round(row.effective_unit_price).toLocaleString() + " 円" : "—"
                             )}
                          </td>
                          <td className="px-6 py-4 text-slate-600 whitespace-nowrap">{row.condition_type === "new" ? "新品" : row.condition_type === "used" ? "中古" : row.condition_type ?? "—"}</td>
                          <td className="px-6 py-4 text-center whitespace-nowrap">
                            {isIndividualEdit ? (
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  onClick={saveIndividualEdit}
                                  disabled={saving}
                                  className={`${buttonClass} h-9 px-2 bg-primary text-white hover:bg-primary/90`}
                                  title="保存"
                                >
                                  <Save className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelIndividualEdit}
                                  className={`${buttonClass} h-9 px-2 bg-white text-slate-700 border border-slate-200 hover:bg-slate-50`}
                                  title="取消"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : !isBulkEditing ? (
                              <button
                                type="button"
                                onClick={() => startIndividualEdit(row)}
                                className={`${buttonClass} h-9 px-2 bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
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
              <table className="w-full text-sm text-left min-w-[900px]">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                  <tr>
                    <th className="px-3 py-2 whitespace-nowrap">警告</th>
                    <th className="px-3 py-2 whitespace-nowrap">仕入日</th>
                    <th className="px-3 py-2 whitespace-nowrap">仕入先</th>
                    <th className="px-3 py-2 whitespace-nowrap">JAN</th>
                    <th className="px-3 py-2 whitespace-nowrap min-w-[160px]">商品名</th>
                    <th className="px-3 py-2 whitespace-nowrap">ブランド</th>
                    <th className="px-3 py-2 whitespace-nowrap">型番</th>
                    <th className="px-3 py-2 whitespace-nowrap text-right">実質単価</th>
                    <th className="px-3 py-2 whitespace-nowrap">状態</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {csvImportPreview.map((row, idx) => (
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
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{row.created_at || "—"}</td>
                      <td className="px-3 py-2 text-slate-700 whitespace-nowrap">{row.supplierRaw || row.supplierKana || "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{row.jan_code || "—"}</td>
                      <td className="px-3 py-2 font-medium text-slate-900 min-w-[140px]">{row.product_name || "—"}</td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{row.brand || "—"}</td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{row.model_number || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{row.effective_unit_price || "—"}</td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{row.status === "new" || row.status === "新品" ? "新品" : row.status === "used" || row.status === "中古" ? "中古" : row.status || "—"}</td>
                    </tr>
                  ))}
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