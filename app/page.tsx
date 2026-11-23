"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeToFullWidthKatakana } from "@/lib/kana";
import { normalizeSupplierForMatch } from "@/lib/normalizeSupplier";
import BarcodeScannerModal from "@/components/BarcodeScannerModal";
import InboundPendingList from "@/components/InboundPendingList";
import BagInboundPanel from "@/components/BagInboundPanel";
import { pendingSourceLabel, type PendingRow } from "@/lib/inbound-pending";
import { countPhotoJans, isRegistrableJan, type BagRun, type PriceQuote } from "@/lib/inbound-bags";

// ----- 型定義 -----
type ProductCondition = "new" | "used";
type InboundMode = "product" | "part";

type ProductRow = {
  id: string;
  jan: string;
  brand: string;
  productName: string;
  modelNumber: string;
  basePrice: number;
  quantity: number;
  fixedUnitPrice: boolean;
  inferredByAi: boolean;
  condition: ProductCondition;
  isMaster?: boolean;
  /** 商品情報取得API（infer-jan）の同一レスポンスから取得したASIN。保存時に inbound_items.asin へ送る */
  asin?: string | null;
  itemKind: InboundMode;
  partCode: string;
  /** 相談-13 段階3：福袋で自動で入れた基準価格の出どころ（手で直すと消える） */
  priceSource?: { label: string; url: string | null; name: string | null } | null;
  priceNote?: string | null;
};

const BAG_RUN_KEY = "inbound-bag-run-v1";

type HeaderInfo = {
  purchaseDate: string;
  supplier: string;
  genre: string;
  shipping: number;
  discount: number;
};

// 🌟 変更: 仕入先のエラーメッセージを型に追加
type ValidationError = {
  fixedTotalExceedsPurchase?: boolean;
  missingFields?: string[];
  purchaseRequiredWhenDistribute?: boolean;
  supplierKanaError?: string;
  supplierNotExistsError?: string;
};

function cleanseProductName(value: string): string {
  return value
    .replace(/\d{13,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function calcEffectiveUnitPrice(
  row: ProductRow,
  totalPurchase: number,
  headerInfo: HeaderInfo,
  rows: ProductRow[]
): number {
  let baseUnitCost = 0;
  if (!row.fixedUnitPrice) {
    baseUnitCost = row.basePrice;
  } else {
    const fixedTotal = rows
      .filter((r) => !r.fixedUnitPrice)
      .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);

    const distributeBaseSum = rows
      .filter((r) => r.fixedUnitPrice)
      .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);
    
    const distributablePurchase = totalPurchase - fixedTotal;

    if (distributeBaseSum > 0 && distributablePurchase > 0) {
      baseUnitCost = (distributablePurchase * row.basePrice) / distributeBaseSum;
    }
  }

  const totalBaseSum = rows.reduce((sum, r) => sum + r.basePrice * r.quantity, 0);
  const extraCost = headerInfo.shipping - headerInfo.discount;
  let allocatedExtra = 0;

  if (totalBaseSum > 0 && extraCost !== 0) {
    allocatedExtra = (extraCost * row.basePrice) / totalBaseSum;
  }

  return baseUnitCost + allocatedExtra;
}

// 🌟 変更: 引数に「仕入先マスターのリスト(suppliers)」を追加し、リアルタイム検証を行う
function validate(
  totalPurchase: number,
  headerInfo: HeaderInfo,
  rows: ProductRow[],
  totalPurchaseRaw: string,
  suppliers: { id: number; name: string; kana: string }[],
  inboundMode: InboundMode
): ValidationError {
  const err: ValidationError = {};
  const hasAnyDistribute = rows.some((r) => r.fixedUnitPrice);
  const totalPurchaseEmpty = totalPurchaseRaw.trim() === "";

  if (hasAnyDistribute && totalPurchaseEmpty) {
    err.purchaseRequiredWhenDistribute = true;
  }

  const fixedTotal = rows
    .filter((r) => !r.fixedUnitPrice)
    .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);

  if (hasAnyDistribute && fixedTotal > totalPurchase) {
    err.fixedTotalExceedsPurchase = true;
  }
  
  const missing: string[] = [];

  // 🌟 追加: 仕入先のリアルタイムバリデーション
  const kanaSupplier = headerInfo.supplier.trim();
  if (!kanaSupplier) {
    missing.push("伝票情報の「仕入先カナ」");
  } else if (!/^[ァ-ンヴー・\s]+$/.test(kanaSupplier)) {
    err.supplierKanaError = "仕入先はカタカナで入力してください（英数字・漢字は不可）。";
  } else if (suppliers.length > 0) {
    const exists = suppliers.some(s => s.kana === kanaSupplier);
    if (!exists) {
      err.supplierNotExistsError = `入力されたカナ「${kanaSupplier}」はマスターに未登録です。`;
    }
  }

  rows.forEach((r, i) => {
    if (inboundMode === "part" || r.itemKind === "part") {
      if (!r.partCode.trim()) missing.push(`商品リスト 行${i + 1} の「パーツコード」`);
      if (!r.productName.trim()) missing.push(`商品リスト 行${i + 1} の「正式名称」`);
    } else {
      if (!r.jan.trim()) missing.push(`商品リスト 行${i + 1} の「JAN」`);
    }
    if (r.basePrice <= 0 && !r.fixedUnitPrice) missing.push(`商品リスト 行${i + 1} の「基準価格」`);
  });
  
  if (missing.length) err.missingFields = missing;
  return err;
}

function generateId() {
  return Math.random().toString(36).slice(2, 12);
}

/** 福袋で自動で入れた基準価格の出どころ（押すと、その出品を開いて確かめられる） */
function BagPriceInfo({ row }: { row: ProductRow }) {
  if (row.priceSource) {
    const text = `${row.priceSource.label}の最安値`;
    return row.priceSource.url ? (
      <a href={row.priceSource.url} target="_blank" rel="noopener noreferrer" title={row.priceSource.name ?? undefined} className="mt-1 block text-right text-[10px] text-primary underline">
        {text}
      </a>
    ) : (
      <div className="mt-1 text-right text-[10px] text-slate-500">{text}</div>
    );
  }
  return row.priceNote ? <div className="mt-1 text-right text-[10px] text-amber-700">{row.priceNote}</div> : null;
}

export default function InboundPage() {
  const [purchaseDate, setPurchaseDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [supplier, setSupplier] = useState<string>("");
  const [genre, setGenre] = useState<string>("");
  const [totalPurchase, setTotalPurchase] = useState<string>("");
  const [shipping, setShipping] = useState<string>("");
  const [discount, setDiscount] = useState<string>("");

  const [rows, setRows] = useState<ProductRow[]>([]);
  const rowsRef = useRef<ProductRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const [inboundMode, setInboundMode] = useState<InboundMode>("product");
  const [inferringJan, setInferringJan] = useState<string | null>(null);
  const [partLookupBusy, setPartLookupBusy] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const janInputRef = useRef<HTMLInputElement>(null);
  const lastAddedIdRef = useRef<string | null>(null);
  
  type SupplierSuggest = { id: number; name: string; kana: string };
  const [supplierSuggestList, setSupplierSuggestList] = useState<SupplierSuggest[]>([]);
  const [supplierSuggestOpen, setSupplierSuggestOpen] = useState(false);

  // 🌟 追加: ページを開いた時に仕入先マスターを全件読み込んでおく（リアルタイム検証用）
  const [masterSuppliers, setMasterSuppliers] = useState<SupplierSuggest[]>([]);
  useEffect(() => {
    fetch("/api/suppliers")
      .then(res => res.ok && res.json())
      .then(data => {
        if (Array.isArray(data)) setMasterSuppliers(data);
      })
      .catch(console.error);
  }, []);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // 相談-13：入庫待ちから呼び出した伝票（null＝今までどおりの手入力）
  const [pending, setPending] = useState<{ id: string; orderNumber: string | null; label: string; blockers: string[]; notes: string[] } | null>(null);
  const [pendingReloadKey, setPendingReloadKey] = useState(0);

  const clearPending = useCallback(() => setPending(null), []);

  // 相談-13 段階3：福袋の入庫（1袋＝1伝票）。画面を開き直しても続きから入れるよう、袋の進み具合だけ端末に残す
  const [bagRun, setBagRunState] = useState<BagRun | null>(null);
  const [bagBusy, setBagBusy] = useState<string | null>(null);
  const [bagMessage, setBagMessage] = useState<string | null>(null);
  const bagRetryAtRef = useRef(0); // 通信が切れた直後は、前の保存が終わるまで押し直させない

  const setBagRun = useCallback((run: BagRun | null) => {
    setBagRunState(run);
    try {
      if (run) localStorage.setItem(BAG_RUN_KEY, JSON.stringify(run));
      else localStorage.removeItem(BAG_RUN_KEY);
    } catch {
      /* 保存できない端末でも入庫は続けられる */
    }
  }, []);

  const applyBag = useCallback((run: BagRun) => {
    const bag = run.bags[run.current];
    setInboundMode("product");
    setRows([]);
    setTotalPurchase(String(bag.price));
    setShipping(bag.shipping ? String(bag.shipping) : "");
    setDiscount(bag.discount ? String(bag.discount) : "");
    setBagMessage(null);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(BAG_RUN_KEY);
      if (!raw) return;
      const run = JSON.parse(raw) as BagRun;
      if (!run.runId || !Array.isArray(run.bags) || !run.bags[run.current]) return;
      setBagRunState(run);
      applyBag(run);
      // 開き直しても、仕入日を今日に変えたまま登録しない
      const h = JSON.parse(localStorage.getItem(`${BAG_RUN_KEY}-header`) ?? "{}") as { purchaseDate?: string; supplier?: string; genre?: string };
      setPurchaseDate(h.purchaseDate ?? "");
      setSupplier(h.supplier ?? "");
      setGenre(h.genre ?? "");
    } catch {
      /* 読めない控えは使わない */
    }
  }, [applyBag]);

  useEffect(() => {
    if (!bagRun) return;
    try {
      localStorage.setItem(`${BAG_RUN_KEY}-header`, JSON.stringify({ purchaseDate, supplier, genre }));
    } catch {
      /* 保存できない端末でも入庫は続けられる */
    }
  }, [bagRun, purchaseDate, supplier, genre]);

  const startBagRun = useCallback((run: BagRun) => {
    if (rows.length > 0 && !confirm("今の商品リストを消して、福袋の入庫を始めます。よろしいですか？")) return;
    setBagRun(run);
    applyBag(run);
  }, [rows.length, setBagRun, applyBag]);

  const cancelBagRun = useCallback(() => {
    setBagRun(null);
    setBagMessage(null);
    setRows([]);
    setTotalPurchase("");
    setShipping("");
    setDiscount("");
  }, [setBagRun]);

  /** JAN から商品名と基準価格を取る（今の自動取得に「価格も」を付けて呼ぶ） */
  const fetchBagItem = useCallback(async (jan: string, condition: ProductCondition) => {
    const res = await fetch("/api/infer-jan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jan, withPrice: true, condition }),
    });
    const data = res.ok ? await res.json() : {};
    const quote = (data.quote ?? null) as PriceQuote | null;
    return {
      brand: cleanseProductName(data.brand ?? ""),
      productName: cleanseProductName(data.productName ?? ""),
      modelNumber: cleanseProductName(data.modelNumber ?? ""),
      asin: (data.asin as string | undefined) ?? null,
      isMaster: data.isMaster === true,
      basePrice: quote?.amount ?? 0,
      priceSource: quote?.amount && quote.source ? { label: quote.source, url: quote.url, name: quote.name } : null,
      priceNote: quote?.amount ? null : quote?.note ?? "価格を取得できませんでした",
    };
  }, []);

  /** 福袋の行を足す。mode=photo は数量を写真の個数まで（撮り直しで増やさない）、add は1個足す */
  const addBagJans = useCallback(async (counts: Map<string, number>, mode: "photo" | "add") => {
    const known = new Set(rowsRef.current.map((r) => r.jan));
    setRows((prev) => prev.map((r) => {
      const n = counts.get(r.jan);
      if (!n) return r;
      return { ...r, quantity: mode === "photo" ? Math.max(r.quantity, n) : r.quantity + n };
    }));
    const fresh = [...counts.entries()].filter(([jan]) => !known.has(jan));
    let i = 0;
    for (const [jan, quantity] of fresh) {
      i += 1;
      setBagBusy(`商品と価格を調べています（${i}/${fresh.length}）`);
      let info: Awaited<ReturnType<typeof fetchBagItem>>;
      try {
        info = await fetchBagItem(jan, "new");
      } catch {
        info = { brand: "", productName: "", modelNumber: "", asin: null, isMaster: false, basePrice: 0, priceSource: null, priceNote: "価格を取得できませんでした" };
      }
      const row: ProductRow = {
        id: generateId(),
        jan,
        brand: info.brand,
        productName: info.productName,
        modelNumber: info.modelNumber,
        basePrice: info.basePrice,
        quantity,
        fixedUnitPrice: true,
        inferredByAi: !!info.productName,
        condition: "new",
        isMaster: info.isMaster,
        itemKind: "product",
        partCode: "",
        priceSource: info.priceSource,
        priceNote: info.priceNote,
        ...(info.asin ? { asin: info.asin } : {}),
      };
      setRows((prev) => [...prev, row]);
    }
    return fresh.length;
  }, [fetchBagItem]);

  const handleBagPhotos = useCallback(async (files: File[]) => {
    setBagBusy("写真を読んでいます");
    setBagMessage(null);
    try {
      const { readJansFromPhoto } = await import("@/lib/barcode-photo");
      const photos: string[][] = [];
      let failed = 0;
      let unusable = 0;
      for (const f of files) {
        try {
          const r = await readJansFromPhoto(f);
          photos.push(r.jans);
          unusable += r.unusable;
        } catch {
          failed += 1;
        }
      }
      const counts = countPhotoJans(photos);
      await addBagJans(counts, "photo");
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const msg = [`写真 ${files.length}枚から ${total}個のJANを読みました。写真の点数と合うか確かめてください。`];
      if (failed) msg.push(`読めなかった写真：${failed}枚`);
      if (unusable) msg.push(`登録に使えないコード（8桁・店内コードなど）：${unusable}個。手で入れてください`);
      if (files.length > 1) msg.push("同じJANが別の写真にあるときは、撮り直しとみなして数量を足していません");
      setBagMessage(msg.join("\n"));
    } finally {
      setBagBusy(null);
    }
  }, [addBagJans]);

  /** 福袋で新品／中古を変えたら、その条件の最安値を取り直す */
  const changeBagCondition = useCallback(async (row: ProductRow, condition: ProductCondition) => {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, condition, basePrice: 0, priceSource: null, priceNote: "価格を調べています" } : r)));
    let quote: { basePrice: number; priceSource: ProductRow["priceSource"]; priceNote: string | null };
    try {
      quote = await fetchBagItem(row.jan, condition);
    } catch {
      quote = { basePrice: 0, priceSource: null, priceNote: "価格を取得できませんでした" };
    }
    // 調べている間に手で価格を入れていたら（目印が消える）、取った価格で上書きしない
    setRows((prev) => prev.map((r) => (r.id === row.id && r.condition === condition && r.priceNote === "価格を調べています"
      ? { ...r, basePrice: quote.basePrice, priceSource: quote.priceSource, priceNote: quote.priceNote }
      : r)));
  }, [fetchBagItem]);

  /** 呼び出しをやめるときは、呼び出した入力も全部消す（そのまま手入力として登録して二重にならないように） */
  const cancelPending = useCallback(() => {
    setPending(null);
    setRows([]);
    setTotalPurchase("");
    setShipping("");
    setDiscount("");
    setSupplier("");
    setGenre("");
    setPurchaseDate(new Date().toISOString().split("T")[0]);
  }, []);

  const loadPending = useCallback(
    (row: PendingRow) => {
      if (bagRun) {
        alert("福袋の入庫の途中です。終わるか「やめる」を押してから呼び出してください。");
        return;
      }
      const today = new Date().toISOString().split("T")[0];
      const hasInput =
        rows.length > 0 || totalPurchase !== "" || supplier !== "" || shipping !== "" || discount !== "" ||
        genre !== "" || purchaseDate !== today || pending !== null;
      if (hasInput && !confirm("今の入力を消して、入庫待ちの伝票を呼び出します。よろしいですか？")) return;
      const h = row.payload.header;
      const numStr = (n: number | null | undefined) => (n == null ? "" : String(n));
      setInboundMode("product");
      // 仕入日が分からないときは空欄のまま（今日で埋めない）。入れるまで登録できない
      setPurchaseDate(h.purchaseDate ?? row.purchaseDate ?? "");
      setSupplier(h.supplierKana ?? "");
      setGenre(h.genre ?? "");
      setTotalPurchase(numStr(h.totalPurchase));
      setShipping(numStr(h.shipping));
      setDiscount(numStr(h.discount));
      setRows(
        row.payload.items.map((it) => ({
          id: generateId(),
          // 登録に使うのは Amazon の自分の出品から確かめたJANだけ（書類の印字JANは使わない）
          jan: it.jan ?? "",
          brand: it.brand ?? "",
          productName: cleanseProductName(it.productName ?? it.rawName ?? ""),
          modelNumber: it.modelNumber ?? it.rawModel ?? "",
          basePrice: it.fixedUnitPrice ? it.basePrice ?? 0 : it.unitPrice ?? it.basePrice ?? 0,
          quantity: it.quantity ?? 1,
          fixedUnitPrice: it.fixedUnitPrice === true,
          inferredByAi: false,
          condition: it.condition ?? "new",
          itemKind: "product" as const,
          partCode: "",
          ...(it.asin ? { asin: it.asin } : {}),
        }))
      );
      const warn: string[] = [...row.blockers];
      if (!(h.purchaseDate ?? row.purchaseDate)) warn.push("仕入日が分かりません。原本を見て入れてください");
      if (row.payload.items.some((it) => it.quantity == null)) warn.push("数量が分からない行は1にしています。確かめてください");
      if (row.payload.items.some((it) => it.condition == null)) warn.push("新品/中古が分からない行は新品にしています。確かめてください");
      if (!h.supplierKana) warn.push(`仕入先カナが未確定です（書類の名前：${h.supplierName ?? "不明"}）`);
      setPending({
        id: row.id,
        orderNumber: row.orderNumber ?? h.orderNumber ?? null,
        label: pendingSourceLabel(row),
        blockers: warn,
        notes: row.payload.notes ?? [],
      });
    },
    [rows.length, totalPurchase, supplier, shipping, discount, genre, purchaseDate, pending, bagRun]
  );

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

  // 🌟 変更: validate関数にマスターリストを渡す
  const validation = validate(totalNum, headerInfo, rows, totalPurchase, masterSuppliers, inboundMode);

  // 🌟 追加: エラーが1つでもあれば true になるフラグ
  // 相談-13：入庫待ちからの登録だけ、按分対象で基準価格が0の行を止める（手入力の決まりは変えない）
  // 福袋（相談-13 段階3）も同じ確認をする
  const strictCheck = !!pending || !!bagRun;
  const pendingDistributeZero = strictCheck && rows.some((r) => r.fixedUnitPrice && r.basePrice <= 0);
  const pendingDateMissing = strictCheck && !purchaseDate;
  // 相談-13：入庫待ちからの登録は、按分なしなら「単価×数量の合計＝仕入総額」をサーバーでも確かめる。先に画面で知らせる
  const pendingSumBase = rows.reduce((s, r) => s + r.basePrice * r.quantity, 0);
  const pendingUnitCount = rows.reduce((s, r) => s + r.quantity, 0);
  const pendingTotalMismatch =
    strictCheck && rows.length > 0 && !rows.some((r) => r.fixedUnitPrice) &&
    (totalPurchase.trim() === "" || Math.abs(pendingSumBase - totalNum) > pendingUnitCount);

  // サーバーと同じ確認：送料・割引・総コストは0以上、計算した実効単価はすべて0より大きい
  const pendingMoneyBad =
    strictCheck && rows.length > 0 &&
    (shippingNum < 0 || discountNum < 0 || totalNum + shippingNum - discountNum < 0 ||
      rows.some((r) => !(calcEffectiveUnitPrice(r, totalNum, headerInfo, rows) > 0)));

  const hasErrors =
    pendingDistributeZero ||
    pendingDateMissing ||
    pendingTotalMismatch ||
    pendingMoneyBad ||
    !!validation.fixedTotalExceedsPurchase ||
    !!validation.purchaseRequiredWhenDistribute || 
    (validation.missingFields && validation.missingFields.length > 0) ||
    !!validation.supplierKanaError ||
    !!validation.supplierNotExistsError;

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

  const handleJanBlurOrEnter = useCallback(
    async (jan: string, rowId?: string) => {
      const trimmed = jan.trim().replace(/\D/g, "");
      if (trimmed.length !== 13) return;

      const target = rowId ? rows.find((r) => r.id === rowId) : null;
      if (target && (target.brand || target.productName || target.modelNumber)) return;

      // 福袋の途中は、手で入れた JAN も商品名と基準価格を一緒に取る
      if (bagRun) {
        if (janInputRef.current) janInputRef.current.value = "";
        if (!isRegistrableJan(trimmed)) {
          setBagMessage(`JAN「${trimmed}」は登録に使えない番号です（チェック数字違い・店内コード）`);
          return;
        }
        setBagBusy("商品と価格を調べています");
        try {
          if (rowId) {
            const info = await fetchBagItem(trimmed, target?.condition ?? "new");
            setRows((prev) => prev.map((r) => (r.id === rowId
              ? { ...r, jan: trimmed, brand: info.brand, productName: info.productName, modelNumber: info.modelNumber, isMaster: info.isMaster, inferredByAi: !!info.productName, fixedUnitPrice: true, basePrice: info.basePrice, priceSource: info.priceSource, priceNote: info.priceNote, ...(info.asin ? { asin: info.asin } : {}) }
              : r)));
          } else {
            await addBagJans(new Map([[trimmed, 1]]), "add");
          }
        } catch {
          setBagMessage("商品と価格を取得できませんでした。手で入れてください");
        } finally {
          setBagBusy(null);
        }
        return;
      }

      let brand = "";
      let productName = "";
      let modelNumber = "";

      try {
        const dbRes = await fetch("/api/infer-jan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jan: trimmed, dbOnly: true }),
        });
        if (dbRes.ok) {
          const dbData = await dbRes.json();
          if (dbData.source === "db") {
            brand = cleanseProductName(dbData.brand ?? "");
            productName = cleanseProductName(dbData.productName ?? "");
            modelNumber = cleanseProductName(dbData.modelNumber ?? "");
            const asin = dbData.asin ?? null;
            applyJanResult(trimmed, brand, productName, modelNumber, rowId, dbData.isMaster, asin);
            return;
          }
        }

        setInferringJan(trimmed);
        const res = await fetch("/api/infer-jan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jan: trimmed }),
        });
        let asin: string | null = null;
        if (res.ok) {
          const data = await res.json();
          brand = cleanseProductName(data.brand ?? "");
          productName = cleanseProductName(data.productName ?? "");
          modelNumber = cleanseProductName(data.modelNumber ?? "");
          asin = data.asin ?? null;
        }
        applyJanResult(trimmed, brand, productName, modelNumber, rowId, false, asin);
      } catch (e) {
        applyJanResult(trimmed, brand, productName, modelNumber, rowId, false, null);
      } finally {
        setInferringJan(null);
      }

      function applyJanResult(trimmed: string, brand: string, productName: string, modelNumber: string, rowId?: string, isMaster: boolean = false, asin: string | null = null) {
        if (rowId) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === rowId
                ? { ...r, jan: r.jan || trimmed, brand: r.brand || brand, productName: r.productName || productName, modelNumber: r.modelNumber || modelNumber, inferredByAi: !!productName, isMaster, ...(asin != null && { asin }) }
                : r
            )
          );
        } else {
          setRows((prev) => {
            const last = prev[prev.length - 1];
            if (last && !last.jan && !last.brand && !last.productName) {
              return prev.map((r, i) =>
                i === prev.length - 1
                  ? { ...r, jan: trimmed, brand, productName, modelNumber, inferredByAi: !!productName, isMaster, ...(asin != null && { asin }) }
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
              isMaster,
              itemKind: "product",
              partCode: "",
              ...(asin != null && { asin }),
            };
            lastAddedIdRef.current = newRow.id;
            return [...prev, newRow];
          });
          if (janInputRef.current) janInputRef.current.value = "";
        }
      }
    },
    [rows, bagRun, fetchBagItem, addBagJans]
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
      fixedUnitPrice: !!bagRun, // 福袋の行は最初から按分対象
      inferredByAi: false,
      condition: inboundMode === "part" ? "used" : "new",
      itemKind: inboundMode,
      partCode: "",
    };
    lastAddedIdRef.current = newRow.id;
    setRows((prev) => [...prev, newRow]);
    setTimeout(() => janInputRef.current?.focus(), 50);
  }, [inboundMode, bagRun]);

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

  const handlePartCodeEnter = useCallback(async (rawCode: string) => {
    const code = rawCode.trim().toUpperCase().replace(/\s+/g, "-");
    if (!code) return;
    setPartLookupBusy(code);
    try {
      const res = await fetch(`/api/parts-catalog?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "パーツマスタの参照に失敗しました");
        return;
      }
      if (!data || !data.code) {
        alert(
          `パーツコード「${code}」はマスタ未登録です。\n先に「パーツマスタ」で正式名称を登録してください。`
        );
        return;
      }
      const newRow: ProductRow = {
        id: generateId(),
        jan: "",
        brand: data.brand != null ? String(data.brand) : "",
        productName: String(data.name ?? ""),
        modelNumber: String(data.code),
        basePrice: 0,
        quantity: 1,
        fixedUnitPrice: false,
        inferredByAi: false,
        condition: "used",
        itemKind: "part",
        partCode: String(data.code),
        isMaster: true,
      };
      lastAddedIdRef.current = newRow.id;
      setRows((prev) => [...prev, newRow]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "パーツマスタの参照に失敗しました");
    } finally {
      setPartLookupBusy(null);
      setTimeout(() => janInputRef.current?.focus(), 50);
    }
  }, []);

  const handleRegister = useCallback(async () => {
    // 🌟 変更: エラーチェックはボタンの disabled で防ぐため、ここにあった alert() を削除
    if (bagRun && Date.now() < bagRetryAtRef.current) {
      alert(`通信が切れた直後です。前の保存が終わるのを待っています。あと${Math.ceil((bagRetryAtRef.current - Date.now()) / 1000)}秒してから押してください。`);
      return;
    }
    const confirmText = pending && pending.blockers.length > 0
        ? `次の点を確かめましたか？\n・${pending.blockers.join("\n・")}\n\n入力内容をデータベースに保存しますか？`
        : "入力内容をデータベースに保存しますか？";
    if (!confirm(confirmText)) return;

    setIsSubmitting(true);
    try {
        const expandedItems = rows.flatMap(row => {
            const items = [];
            const effectivePrice = calcEffectiveUnitPrice(row, totalNum, headerInfo, rows);
            for (let i = 0; i < row.quantity; i++) {
                items.push({
                    jan: row.jan,
                    brand: row.brand,
                    productName: row.productName,
                    modelNumber: row.modelNumber,
                    condition: row.condition,
                    basePrice: row.basePrice,
                    fixedUnitPrice: row.fixedUnitPrice,
                    effectiveUnitPrice: effectivePrice,
                    asin: row.asin ?? null,
                    itemKind: inboundMode === "part" ? "part" : row.itemKind || "product",
                    partCode: row.partCode || "",
                });
            }
            return items;
        });

        const fullData = {
            header: {
                purchaseDate,
                supplier: supplier.trim(), // すでにカナに整形・検証済み
                genre,
                totalPurchase: totalNum,
                shipping: shippingNum,
                discount: discountNum,
                totalCost: totalNum + shippingNum - discountNum,
                ...(pending ? { orderNumber: pending.orderNumber } : bagRun?.orderNumber ? { orderNumber: bagRun.orderNumber } : {})
            },
            items: expandedItems,
            ...(pending ? { pendingId: pending.id } : {}),
            ...(bagRun ? { bagKey: `${bagRun.runId}:${bagRun.current}` } : {})
        };

        const res = await fetch("/api/inbound", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fullData),
        });

        if (!res.ok) {
            let msg = "保存に失敗しました";
            try { const j = await res.json(); if (j?.error) msg = `保存に失敗しました：${j.error}`; } catch { /* 本文なし */ }
            throw new Error(msg);
        }

        const result = await res.json();
        if (pending) {
            setPending(null);
            setPendingReloadKey((k) => k + 1);
        }
        if (bagRun) {
            // 福袋：この袋の登録を記録し、仕入日・仕入先・ジャンルを残して次の袋へ
            const bags = bagRun.bags.map((b, i) => (i === bagRun.current ? { ...b, headerId: Number(result.id) } : b));
            const next = bagRun.current + 1;
            if (next < bags.length) {
                const run = { ...bagRun, bags, current: next };
                setBagRun(run);
                applyBag(run);
                alert(`${bagRun.current + 1}袋目を保存しました (ID: ${result.id}, 商品数: ${expandedItems.length})。次は${next + 1}袋目です`);
                return;
            }
            setBagRun(null);
            setBagMessage(null);
        }
        alert(`保存しました (ID: ${result.id}, 商品数: ${expandedItems.length})`);
        setRows([]);             // 商品リストを空にする
        setTotalPurchase("");    // 仕入総額を空にする
        setShipping("");         // 送料を空にする
        setDiscount("");         // 割引を空にする
        setPurchaseDate(new Date().toISOString().split('T')[0]); // 仕入日を「今日」に戻す
        setSupplier("");         // 仕入先カナを空にする
        setGenre("");            // ジャンルを空にする
        // window.location.reload(); 

    } catch (error) {
        console.error(error);
        if (bagRun && error instanceof TypeError) bagRetryAtRef.current = Date.now() + 30000;
        alert("エラーが発生しました: " + error);
    } finally {
        setIsSubmitting(false);
    }
  }, [headerInfo, rows, totalNum, shippingNum, discountNum, purchaseDate, supplier, genre, totalPurchase, inboundMode, pending, bagRun, setBagRun, applyBag]);

  const openCamera = useCallback(() => {
    setCameraOpen(true);
  }, []);

  const closeCamera = useCallback(() => {
    setCameraOpen(false);
  }, []);

  const handleBarcodeScan = useCallback(
    (code: string) => {
      handleJanBlurOrEnter(code);
    },
    [handleJanBlurOrEnter]
  );

  const totalCost = totalNum + shippingNum - discountNum;
  
  const fixedTotal = rows
    .filter((r) => !r.fixedUnitPrice)
    .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);
  
  const unfixedBaseSum = rows
    .filter((r) => r.fixedUnitPrice)
    .reduce((sum, r) => sum + r.basePrice * r.quantity, 0);

  const inputClass = "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 shadow-sm";
  const buttonClass = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

  return (
    <div className="flex-1 flex flex-col">
      <main className="flex-1 py-8 w-full max-w-7xl mx-auto">
        <div className="px-4 sm:px-6 lg:px-8">
          
          <div className="grid gap-8 lg:grid-cols-12 items-start">
            
            <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-24">

              <InboundPendingList activeId={pending?.id ?? null} reloadKey={pendingReloadKey} onSelect={loadPending} />

              {inboundMode === "product" && (
                <BagInboundPanel
                  run={bagRun}
                  disabled={!!pending}
                  busy={bagBusy}
                  message={bagMessage}
                  onStart={startBagRun}
                  onCancel={cancelBagRun}
                  onPhotos={handleBagPhotos}
                />
              )}

              {pending && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800">入庫待ちから呼び出し中</div>
                      <div className="text-xs text-slate-600 truncate">書類：{pending.label}</div>
                      {pending.orderNumber && <div className="text-xs text-slate-600">注文番号：{pending.orderNumber}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirm("呼び出しをやめます。呼び出した入力は全部消えます（入庫待ちには残ります）。よろしいですか？")) return;
                        cancelPending();
                      }}
                      className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      呼び出しをやめる
                    </button>
                  </div>
                  {pending.blockers.length > 0 && (
                    <ul className="mt-2 list-disc list-inside text-xs text-amber-700">
                      {pending.blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  )}
                  {pending.notes.length > 0 && (
                    <ul className="mt-1 list-disc list-inside text-xs text-slate-500">
                      {pending.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-[11px] text-slate-500">中身を確かめてから「入庫データを保存」を押してください。同じ伝票は2回登録されません。</p>
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
                <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-100 backdrop-blur">
                  <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                    <DocumentIcon className="h-5 w-5 text-primary" />
                    伝票情報
                  </h2>
                </div>
                
                <div className="p-6 space-y-5">
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
                      <div className="relative">
                        <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">仕入先カナ (必須)</label>
                        <input
                            type="text"
                            value={supplier}
                            onChange={(e) => {
                              const v = e.target.value;
                              setSupplier(v);
                              const kana = normalizeToFullWidthKatakana(v);
                              if (!kana.trim()) {
                                setSupplierSuggestList([]);
                                setSupplierSuggestOpen(false);
                                return;
                              }
                              const normalizedInput = normalizeSupplierForMatch(kana);
                              const filtered = masterSuppliers.filter(
                                (s) =>
                                  normalizeSupplierForMatch(s.name).includes(normalizedInput) ||
                                  normalizeSupplierForMatch(s.kana).includes(normalizedInput)
                              );
                              setSupplierSuggestList(filtered);
                              setSupplierSuggestOpen(filtered.length > 0);
                            }}
                            onBlur={(e) => {
                              setSupplier(normalizeToFullWidthKatakana(e.target.value));
                              setTimeout(() => setSupplierSuggestOpen(false), 200);
                            }}
                            onFocus={() => { if (supplierSuggestList.length) setSupplierSuggestOpen(true); }}
                            placeholder="カナで検索（例: アマゾン）"
                            className={`${inputClass} ${validation.supplierKanaError || validation.supplierNotExistsError ? "border-red-400 focus-visible:ring-red-200" : ""}`}
                            autoComplete="off"
                        />
                        {supplierSuggestOpen && supplierSuggestList.length > 0 && (
                          <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                            {supplierSuggestList.map((s) => (
                              <li key={s.id}>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => { setSupplier(s.kana); setSupplierSuggestOpen(false); }}
                                >
                                  <span className="font-medium">{s.name}</span>
                                  <span className="ml-2 text-xs text-slate-500">{s.kana}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
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

                   <div className="space-y-4">
                      <div className="relative">
                        <label className="text-xs font-semibold text-slate-500 mb-1.5 block uppercase tracking-wide">仕入総額 (税込)</label>
                        <div className="flex items-center gap-3">
                            <div className="relative flex-1">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-medium">¥</span>
                                <input
                                type="number"
                                min={0}
                                className={`flex h-11 w-full rounded-md border bg-slate-50/50 pl-8 pr-4 text-xl font-bold text-slate-900 placeholder:text-slate-300 focus:bg-white focus:outline-none focus:ring-4 transition-all text-right shadow-sm ${validation.purchaseRequiredWhenDistribute || validation.fixedTotalExceedsPurchase ? "border-red-400 focus:ring-red-100" : "border-slate-200 focus:border-primary focus:ring-primary/10"}`}
                                placeholder="0"
                                value={totalPurchase}
                                readOnly={!!bagRun}
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
                                readOnly={!!bagRun}
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
                                readOnly={!!bagRun}
                                onChange={(e) => setDiscount(e.target.value)}
                                className={`${inputClass} text-right text-red-500`}
                                placeholder="0"
                            />
                        </div>
                      </div>
                   </div>

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
                    {/* 🌟 変更: エラーがある場合はボタンを押せなくする */}
                    <button
                      type="button"
                      onClick={handleRegister}
                      disabled={rows.length === 0 || isSubmitting || hasErrors}
                      className={`${buttonClass} w-full bg-primary text-white hover:bg-primary/90 shadow-lg shadow-primary/20 h-12 text-base font-bold tracking-wide transition-all disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none disabled:cursor-not-allowed`}
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
                  </div>
                </div>
              </div>

              {/* 🌟 変更: ここに仕入先のエラーもリストアップされるようになります */}
              {hasErrors && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-sm animate-in fade-in slide-in-from-top-2">
                  <div className="flex items-start gap-3">
                    <AlertCircleIcon className="h-5 w-5 shrink-0 text-red-600 mt-0.5" />
                    <div className="space-y-1">
                      <h4 className="font-semibold text-red-900">入力内容を確認してください</h4>
                      <ul className="list-disc list-inside text-red-700 opacity-90 text-xs leading-relaxed">
                        {pendingDateMissing && (
                          <li>仕入日を入れてください（原本の日付）</li>
                        )}
                        {pendingMoneyBad && !pendingDistributeZero && (
                          <li>送料・割引は0以上にし、割引のあとで実効単価が0円以下になる行がないようにしてください</li>
                        )}
                        {pendingTotalMismatch && (
                          <li>単価×数量の合計（{pendingSumBase.toLocaleString()}円）と仕入総額が合いません。原本を見て直してください</li>
                        )}
                        {pendingDistributeZero && (
                          <li>按分対象の行に基準価格（Amazonの最安値など）を入れてください</li>
                        )}
                        {validation.purchaseRequiredWhenDistribute && (
                          <li>按分を使用している場合は仕入総額を入力してください</li>
                        )}
                        {validation.fixedTotalExceedsPurchase && (
                          <li>固定商品の合計が仕入総額を超過しています（按分原資が不足）</li>
                        )}
                        {validation.supplierKanaError && (
                          <li>{validation.supplierKanaError}</li>
                        )}
                        {validation.supplierNotExistsError && (
                          <li>{validation.supplierNotExistsError}</li>
                        )}
                        {validation.missingFields?.map((msg, i) => (
                          <li key={i}>{msg} が入力されていません</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="lg:col-span-8 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {inboundMode === "part" ? "パーツリスト" : "商品リスト"}
                    <span className="ml-2 text-sm font-normal text-slate-500 bg-white px-2 py-0.5 rounded-full border border-slate-200">
                      {rows.reduce((acc, r) => acc + r.quantity, 0)}点
                    </span>
                  </h2>
                  <div className="mt-2 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm shadow-sm">
                    <button
                      type="button"
                      onClick={() => {
                        if (inboundMode === "product") return;
                        if (rows.length > 0 && !confirm("モードを切替えるとリストをクリアします。よろしいですか？")) return;
                        setInboundMode("product");
                        setRows([]);
                        clearPending();
                      }}
                      className={`rounded-md px-3 py-1.5 font-medium ${inboundMode === "product" ? "bg-primary text-white" : "text-slate-600 hover:bg-slate-50"}`}
                    >
                      商品入庫
                    </button>
                    <button
                      type="button"
                      disabled={!!bagRun}
                      onClick={() => {
                        if (inboundMode === "part") return;
                        if (rows.length > 0 && !confirm("モードを切替えるとリストをクリアします。よろしいですか？")) return;
                        setInboundMode("part");
                        setRows([]);
                        clearPending();
                      }}
                      className={`rounded-md px-3 py-1.5 font-medium ${inboundMode === "part" ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                    >
                      パーツ入庫
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {inboundMode === "product" ? (
                  <button
                    type="button"
                    onClick={openCamera}
                    className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:text-primary hover:border-primary/30`}
                  >
                    <BarcodeIcon className="mr-2 h-4 w-4" />
                    カメラ起動
                  </button>
                  ) : (
                    <a
                      href="/parts-catalog"
                      className={`${buttonClass} bg-white text-violet-700 border border-violet-200 hover:bg-violet-50`}
                    >
                      パーツマスタ
                    </a>
                  )}
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

              <div className="sticky top-[64px] z-20 -mx-4 sm:mx-0 px-4 sm:px-0 mb-4 bg-slate-50/95 backdrop-blur sm:bg-transparent pb-2 sm:pb-0">
                <div className={`relative rounded-xl border p-1 shadow-md ring-4 transition-all focus-within:border-primary/50 ${inboundMode === "part" ? "border-violet-300 bg-white shadow-violet-500/5 ring-violet-500/5" : "border-primary/30 bg-white shadow-primary/5 ring-primary/5 focus-within:ring-primary/20"}`}>
                   <div className="relative flex items-center">
                     <div className={`flex h-10 w-10 items-center justify-center ${inboundMode === "part" ? "text-violet-600" : "text-primary"}`}>
                       <BarcodeIcon className="h-5 w-5" />
                     </div>
                     <input
                        ref={janInputRef}
                        type="text"
                        inputMode={inboundMode === "part" ? "text" : "numeric"}
                        autoComplete="off"
                        placeholder={
                          inboundMode === "part"
                            ? "パーツコードを入力してEnter（例: PS4-RIBBON-12P）"
                            : "JANコードをスキャン または 入力してEnter"
                        }
                        className="flex-1 h-12 bg-transparent text-lg text-slate-900 placeholder:text-slate-400 focus:outline-none"
                        disabled={!!inferringJan || !!partLookupBusy}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const raw = (e.target as HTMLInputElement).value.trim();
                          if (inboundMode === "part") {
                            if (!raw) return;
                            void handlePartCodeEnter(raw);
                            (e.target as HTMLInputElement).value = "";
                            return;
                          }
                          const v = raw.replace(/\D/g, "");
                          if (v.length === 13) {
                            handleJanBlurOrEnter(v);
                            (e.target as HTMLInputElement).value = "";
                          }
                        }}
                        onChange={(e) => {
                          if (inboundMode === "part") return;
                          const digits = (e.target.value || "").replace(/\D/g, "");
                          if (digits.length === 13) {
                            handleJanBlurOrEnter(digits);
                            e.target.value = "";
                          }
                        }}
                      />
                      {(inferringJan || partLookupBusy) && (
                        <div className="flex items-center gap-2 pr-4 animate-pulse">
                          <span className="h-2 w-2 rounded-full bg-primary"></span>
                          <span className="text-xs font-bold text-primary">
                            {partLookupBusy ? "マスタ参照中..." : "AI推論中..."}
                          </span>
                        </div>
                      )}
                   </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden min-h-[400px]">
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full table-fixed text-sm text-left">
                    <thead className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                      <tr>
                        <th className="px-3 py-3 w-[25%]">{inboundMode === "part" ? "コード / 状態" : "JAN / 状態"}</th>
                        <th className="px-3 py-3 min-w-0 w-[30%]">商品情報</th>
                        <th className="px-3 py-3 w-[20%] text-right">数量 / 基準価格</th>
                        <th className="px-3 py-3 w-[20%] text-right">実質単価 / 按分</th>
                        <th className="px-3 py-3 w-[5%]"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {rows.length === 0 && (
                         <tr>
                           <td colSpan={5} className="px-3 py-24 text-center text-slate-400">
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
                        let rowBg = "bg-white";
                        if (row.fixedUnitPrice) rowBg = "bg-slate-50/70";
                        else if (row.inferredByAi) rowBg = "bg-indigo-50/30";

                        // 🌟 追加: その行のエラーチェック（枠線を赤くするため）
                        const isJanMissing =
                          inboundMode === "part" || row.itemKind === "part"
                            ? !row.partCode.trim() || !row.productName.trim()
                            : !row.jan.trim();
                        const isPriceMissing = row.basePrice <= 0 && !row.fixedUnitPrice;

                        return (
                          <tr key={row.id} className={`group hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0 ${rowBg}`}>
                            <td className="px-3 py-3 align-top">
                              <div className="space-y-2">
                                <div className="relative">
                                    {inboundMode === "part" || row.itemKind === "part" ? (
                                    <input
                                    value={row.partCode}
                                    onChange={(e) => updateRow(row.id, { partCode: e.target.value.toUpperCase() })}
                                    className={`${inputClass} w-full font-mono text-sm h-9 shadow-sm ${isJanMissing ? "border-red-400 focus-visible:ring-red-200" : ""}`}
                                    placeholder="パーツコード"
                                    disabled={row.isMaster}
                                    />
                                    ) : (
                                    <input
                                    value={row.jan}
                                    onChange={(e) => updateRow(row.id, { jan: e.target.value })}
                                    onBlur={(e) => {
                                        const v = e.target.value.trim().replace(/\D/g, "");
                                        if (v.length === 13 && !row.brand && !row.productName) handleJanBlurOrEnter(v, row.id);
                                    }}
                                    className={`${inputClass} w-full font-mono text-sm h-9 shadow-sm ${isJanMissing ? "border-red-400 focus-visible:ring-red-200" : ""}`}
                                    placeholder="JAN"
                                    />
                                    )}
                                    {row.inferredByAi && (
                                    <div className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-white shadow-sm" title="AI自動入力済み" />
                                    )}
                                </div>
                                <select
                                    value={row.condition}
                                    onChange={(e) => {
                                      const c = e.target.value as ProductCondition;
                                      if (bagRun && row.jan) void changeBagCondition(row, c);
                                      else updateRow(row.id, { condition: c });
                                    }}
                                    className={`${inputClass} w-full h-8 text-xs py-0`}
                                >
                                    <option value="new">新品</option>
                                    <option value="used">中古</option>
                                </select>
                              </div>
                            </td>
                            <td className="px-3 py-3 align-top space-y-3 min-w-0">
                               <input
                                 value={row.productName}
                                 onChange={(e) => updateRow(row.id, { productName: e.target.value })}
                                 className={`${inputClass} w-full font-medium h-10 shadow-sm ${row.isMaster ? "bg-slate-100 text-slate-500 cursor-not-allowed border-slate-200" : ""}`}
                                 placeholder="商品名"
                                 disabled={row.isMaster}
                               />
                               <div className="flex gap-2">
                                 <input
                                   value={row.brand}
                                   onChange={(e) => updateRow(row.id, { brand: e.target.value })}
                                   className={`${inputClass} w-full text-xs h-9 shadow-sm flex-1 min-w-0 ${row.isMaster ? "bg-slate-100 text-slate-500 cursor-not-allowed border-slate-200" : "bg-white/50"}`}
                                   placeholder="ブランド"
                                   disabled={row.isMaster}
                                 />
                                 <input
                                   value={row.modelNumber}
                                   onChange={(e) => updateRow(row.id, { modelNumber: e.target.value })}
                                   className={`${inputClass} w-full text-xs h-9 shadow-sm flex-[2] min-w-0 ${row.isMaster ? "bg-slate-100 text-slate-500 cursor-not-allowed border-slate-200" : "bg-white/50"}`}
                                   placeholder="型番"
                                   disabled={row.isMaster}
                                 />
                               </div>
                            </td>
                            <td className="px-3 py-3 align-top">
                              <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => updateRow(row.id, { quantity: Math.max(1, row.quantity - 1) })}
                                    className="h-8 w-8 shrink-0 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center font-medium"
                                  >
                                    −
                                  </button>
                                  <input
                                    type="number"
                                    min={1}
                                    value={row.quantity}
                                    onChange={(e) => updateRow(row.id, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                                    className={`${inputClass} w-16 h-9 text-center font-medium shadow-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => updateRow(row.id, { quantity: row.quantity + 1 })}
                                    className="h-8 w-8 shrink-0 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center font-medium"
                                  >
                                    +
                                  </button>
                                </div>

                                <div className="relative">
                                  <span className="absolute left-2 top-2.5 text-slate-400 text-xs">¥</span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={row.basePrice || ""}
                                    onChange={(e) => updateRow(row.id, { basePrice: Number(e.target.value) || 0, priceSource: null, priceNote: null })}
                                    className={`${inputClass} w-full text-right pl-6 h-9 font-medium shadow-sm ${isPriceMissing || (!!bagRun && row.basePrice <= 0) ? "border-red-400 focus-visible:ring-red-200" : ""}`}
                                    placeholder="0"
                                  />
                                </div>
                                <BagPriceInfo row={row} />
                              </div>
                            </td>

                            <td className="px-3 py-3 align-top pt-3">
                              <div className="text-right font-bold text-slate-800 tabular-nums">
                                {effective > 0 ? Math.round(effective).toLocaleString() : "—"}
                                <span className="text-[10px] text-slate-400 ml-1 font-normal">円</span>
                              </div>
                              <div className="flex items-center justify-end gap-1.5 mt-2">
                                <label htmlFor={`fixed-${row.id}`} className="text-[10px] text-slate-500 font-medium">
                                  按分対象
                                </label>
                                <input
                                  id={`fixed-${row.id}`}
                                  type="checkbox"
                                  checked={row.fixedUnitPrice}
                                  onChange={(e) => updateRow(row.id, { fixedUnitPrice: e.target.checked })}
                                  className="h-5 w-5 rounded border-slate-300 text-primary focus:ring-primary/20 cursor-pointer shadow-sm"
                                />
                              </div>
                            </td>

                            <td className="px-3 py-3 align-top pt-2 text-right">
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

                {/* --- スマホ表示 --- */}
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
                    const isJanMissing = !row.jan.trim();
                    const isPriceMissing = row.basePrice <= 0 && !row.fixedUnitPrice;

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
                                    className={`${inputClass} font-mono text-sm h-9 bg-white/80 ${isJanMissing ? "border-red-400" : ""}`}
                                    inputMode="numeric"
                                    placeholder="JAN"
                                    />
                                    {row.inferredByAi && <div className="absolute top-0 right-0 h-2 w-2 rounded-full bg-primary" />}
                                </div>
                                <select
                                    value={row.condition}
                                    onChange={(e) => {
                                      const c = e.target.value as ProductCondition;
                                      if (bagRun && row.jan) void changeBagCondition(row, c);
                                      else updateRow(row.id, { condition: c });
                                    }}
                                    className={`${inputClass} h-9 text-xs w-20 py-0 bg-white/80`}
                                >
                                    <option value="new">新品</option>
                                    <option value="used">中古</option>
                                </select>
                             </div>
                           </div>
                           <button onClick={() => removeRow(row.id)} className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors">
                              <TrashIcon className="h-5 w-5" />
                           </button>
                        </div>

                        <div className="space-y-3">
                           <div>
                             <input
                               value={row.productName}
                               onChange={(e) => updateRow(row.id, { productName: e.target.value })}
                               className={`${inputClass} font-medium ${row.isMaster ? "bg-slate-100 text-slate-500 cursor-not-allowed" : "bg-white/80"}`}
                               placeholder="商品名"
                               disabled={row.isMaster}
                             />
                           </div>
                           <div className="grid grid-cols-2 gap-3">
                             <input
                               value={row.brand}
                               onChange={(e) => updateRow(row.id, { brand: e.target.value })}
                               className={`${inputClass} text-xs ${row.isMaster ? "bg-slate-100 text-slate-500 cursor-not-allowed" : "bg-white/80"}`}
                               placeholder="ブランド"
                               disabled={row.isMaster}
                             />
                             <input
                               value={row.modelNumber}
                               onChange={(e) => updateRow(row.id, { modelNumber: e.target.value })}
                               className={`${inputClass} text-xs ${row.isMaster ? "bg-slate-100 text-slate-500 cursor-not-allowed" : "bg-white/80"}`}
                               placeholder="型番"
                               disabled={row.isMaster}
                             />
                           </div>
                        </div>

                        <div className="mt-4 rounded-lg bg-slate-50/50 border border-slate-100 p-3 grid grid-cols-2 gap-4 items-start">
                           <div className="col-span-2 flex items-center justify-between gap-4 border-b border-slate-200/50 pb-3 mb-1">
                              <label className="text-[10px] text-slate-400 font-bold block">数量</label>
                              <div className="flex items-center gap-3">
                                <button type="button" onClick={() => updateRow(row.id, { quantity: Math.max(1, row.quantity - 1) })} className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">-</button>
                                <span className="font-bold text-slate-800 w-4 text-center">{row.quantity}</span>
                                <button type="button" onClick={() => updateRow(row.id, { quantity: row.quantity + 1 })} className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">+</button>
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
                                 onChange={(e) => updateRow(row.id, { basePrice: Number(e.target.value) || 0, priceSource: null, priceNote: null })}
                                 className={`${inputClass} text-right pl-4 h-8 bg-white ${isPriceMissing || (!!bagRun && row.basePrice <= 0) ? "border-red-400" : ""}`}
                               />
                             </div>
                             <BagPriceInfo row={row} />
                           </div>
                           <div className="text-right">
                              <div className="text-sm font-bold text-slate-900">
                                実質 <span className="text-lg text-primary">{effective > 0 ? Math.round(effective).toLocaleString() : "—"}</span> 円
                              </div>
                              <div className="flex items-center justify-end gap-1.5 mt-2">
                                <label htmlFor={`fixed-${row.id}`} className="text-[10px] text-slate-500 font-medium">按分対象</label>
                                <input
                                   id={`fixed-${row.id}`}
                                   type="checkbox"
                                   checked={row.fixedUnitPrice}
                                   onChange={(e) => updateRow(row.id, { fixedUnitPrice: e.target.checked })}
                                   className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary/20"
                                />
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

      <BarcodeScannerModal
        open={cameraOpen}
        onClose={closeCamera}
        onScan={handleBarcodeScan}
        readerId="inbound-barcode-reader"
      />

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
                  <div><span className="text-slate-500">仕入先カナ</span><div className="font-medium text-slate-900">{supplier || "—"}</div></div>
                  <div><span className="text-slate-500">ジャンル</span><div className="font-medium text-slate-900">{genre || "—"}</div></div>
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