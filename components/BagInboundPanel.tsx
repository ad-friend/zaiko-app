"use client";

import { useRef, useState } from "react";
import { buildBags, parseBagPrices, type BagRun } from "@/lib/inbound-bags";
import { MAX_BAG_PHOTOS } from "@/lib/bag-photo-upload";

export type BagPhoto = { id: string; file: File; url: string };

type Props = {
  run: BagRun | null;
  disabled: boolean; // 入庫待ちを呼び出している間など
  busy: string | null;
  message: string | null;
  onStart: (run: BagRun) => void;
  onCancel: () => void;
  photos: BagPhoto[];
  onPhotos: (files: File[]) => void;
  onRemovePhoto: (id: string) => void;
  onSend: (condition: "new" | "used") => void;
};

const field = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm";

export default function BagInboundPanel({ run, disabled, busy, message, photos, onStart, onCancel, onPhotos, onRemovePhoto, onSend }: Props) {
  const [open, setOpen] = useState(false);
  const [orderNumber, setOrderNumber] = useState("");
  const [pricesText, setPricesText] = useState("");
  const [shipping, setShipping] = useState("");
  const [discount, setDiscount] = useState("");
  const [condition, setCondition] = useState<"new" | "used">("new");
  const fileRef = useRef<HTMLInputElement>(null);

  const prices = parseBagPrices(pricesText);
  const ship = Number(shipping) || 0;
  const disc = Number(discount) || 0;
  const moneyOk = Number.isInteger(ship) && Number.isInteger(disc) && ship >= 0 && disc >= 0;
  const total = prices ? prices.reduce((a, b) => a + b, 0) : 0;
  const canStart = !!prices && moneyOk && total + ship - disc > 0;

  if (run) {
    const bag = run.bags[run.current];
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-bold text-slate-800">福袋の入庫：{run.current + 1}袋目／{run.bags.length}袋</div>
            <div className="text-xs text-slate-600">
              この袋 {bag.price.toLocaleString()}円（送料 {bag.shipping.toLocaleString()}円・割引 {bag.discount.toLocaleString()}円）
            </div>
            {run.orderNumber && <div className="text-xs text-slate-600">注文番号：{run.orderNumber}</div>}
          </div>
          <button
            type="button"
            onClick={() => {
              const saved = run.bags.filter((b) => b.headerId !== null || b.sentBatch).length;
              if (confirm(`福袋の入庫をやめます。送信・登録済みの${saved}袋はそのまま残り、この袋の入力は消えます。よろしいですか？`)) onCancel();
            }}
            className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            やめる
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onPhotos(files);
          }}
        />
        <button
          type="button"
          disabled={!!busy}
          onClick={() => fileRef.current?.click()}
          className="mt-3 h-11 w-full rounded-md bg-amber-500 font-bold text-white hover:bg-amber-600 disabled:bg-slate-300"
        >
          {busy ?? (photos.length ? "この袋の写真を追加する" : "この袋の写真を撮る・選ぶ")}
        </button>
        {photos.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-bold text-slate-700">{run.current + 1}袋目：写真{photos.length}枚</div>
            <div className="mt-1 grid grid-cols-4 gap-2">
              {photos.map((p, i) => (
                <div key={p.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={`${run.current + 1}袋目の写真${i + 1}`} className="h-16 w-full rounded-md border border-amber-200 object-cover" />
                  <button
                    type="button"
                    aria-label={`写真${i + 1}を外す`}
                    disabled={!!busy}
                    onClick={() => onRemovePhoto(p.id)}
                    className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-slate-700 text-xs leading-5 text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {photos.length >= MAX_BAG_PHOTOS && <p className="mt-1 text-[11px] text-amber-700">1袋に{MAX_BAG_PHOTOS}枚までです</p>}
            <label className="mt-2 block text-xs font-semibold text-slate-500">
              この袋の状態
              <select value={condition} onChange={(e) => setCondition(e.target.value as "new" | "used")} className={field}>
                <option value="new">新品</option>
                <option value="used">中古</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onSend(condition)}
              className="mt-2 h-11 w-full rounded-md bg-indigo-600 font-bold text-white hover:bg-indigo-700 disabled:bg-slate-300"
            >
              Claudeに送る（写真{photos.length}枚）
            </button>
          </div>
        )}
        {message && <p className="mt-2 whitespace-pre-line text-xs text-slate-700">{message}</p>}
        <p className="mt-2 text-[11px] text-slate-500">下の伝票情報に仕入日と仕入先を入れて送ると、次の袋に進みます。毎時20分にClaudeがJANを読み、1袋ずつ入庫待ちに入ります。同じ商品が2枚に写っていても二重に数えません。</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="h-10 w-full rounded-md border border-amber-300 bg-amber-50 font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
      >
        福袋・セットを袋ごとに入庫
      </button>
      {open && !disabled && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-semibold text-slate-500">
            袋の価格（税込・並べて入力）
            <input value={pricesText} onChange={(e) => setPricesText(e.target.value)} placeholder="例：5000 5000 10000" className={field} inputMode="numeric" />
          </label>
          {pricesText.trim() !== "" && !prices && <p className="text-xs text-red-600">数字だけで入れてください（5,000 のカンマは付けない）</p>}
          {prices && <p className="text-xs text-slate-600">{prices.length}袋・合計 {total.toLocaleString()}円</p>}
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-semibold text-slate-500">
              注文全体の送料
              <input type="number" min={0} value={shipping} onChange={(e) => setShipping(e.target.value)} className={field} />
            </label>
            <label className="block text-xs font-semibold text-slate-500">
              注文全体の割引
              <input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} className={field} />
            </label>
          </div>
          <label className="block text-xs font-semibold text-slate-500">
            注文番号
            <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className={field} />
          </label>
          {orderNumber.trim() === "" && <p className="text-[11px] text-amber-700">注文番号がないと、freee との照合で袋ごとの伝票を1つの取引にまとめられません。</p>}
          <button
            type="button"
            disabled={!canStart}
            onClick={() => {
              if (!prices) return;
              const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
              onStart({ runId, orderNumber: orderNumber.trim(), bags: buildBags(prices, ship, disc), current: 0 });
              setOpen(false);
              setPricesText("");
              setShipping("");
              setDiscount("");
              setOrderNumber("");
            }}
            className="h-10 w-full rounded-md bg-amber-500 font-bold text-white hover:bg-amber-600 disabled:bg-slate-300"
          >
            1袋目から始める
          </button>
          <p className="text-[11px] text-slate-500">仕入日・仕入先・ジャンルは下の伝票情報に入れてください。全部の袋で同じものを使います。</p>
        </div>
      )}
    </div>
  );
}
