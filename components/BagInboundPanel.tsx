"use client";

import { useRef, useState } from "react";
import { buildBags, parseBagPrices, type BagRun } from "@/lib/inbound-bags";

type Props = {
  run: BagRun | null;
  disabled: boolean; // 入庫待ちを呼び出している間など
  busy: string | null;
  message: string | null;
  onStart: (run: BagRun) => void;
  onCancel: () => void;
  onPhotos: (files: File[]) => void;
};

const field = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm";

export default function BagInboundPanel({ run, disabled, busy, message, onStart, onCancel, onPhotos }: Props) {
  const [open, setOpen] = useState(false);
  const [orderNumber, setOrderNumber] = useState("");
  const [pricesText, setPricesText] = useState("");
  const [shipping, setShipping] = useState("");
  const [discount, setDiscount] = useState("");
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
              const saved = run.bags.filter((b) => b.headerId !== null).length;
              if (confirm(`福袋の入庫をやめます。登録済みの${saved}袋はそのまま残り、この袋の入力は消えます。よろしいですか？`)) onCancel();
            }}
            className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            やめる
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
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
          {busy ?? "この袋の写真を撮る・選ぶ"}
        </button>
        {message && <p className="mt-2 whitespace-pre-line text-xs text-slate-700">{message}</p>}
        <p className="mt-2 text-[11px] text-slate-500">中身と基準価格を確かめて「入庫データを保存」を押すと、次の袋に進みます。</p>
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
