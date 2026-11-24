/**
 * 相談-13 段階3：福袋の入庫（1袋＝1伝票）の計算と判定。通信なし（ブラウザ・サーバーの両方で使う）。
 */

export type BagCondition = "new" | "used";

export type Bag = { price: number; shipping: number; discount: number; headerId: number | null; sentBatch?: string };

export type BagRun = {
  runId: string; // この福袋の入庫の固定の番号（袋ごとの二重登録を止める）
  orderNumber: string;
  bags: Bag[];
  current: number; // 今入力している袋（0 から）
};

export type ShopOffer = { shop: "楽天" | "Yahoo!"; name: string; price: number; url: string | null };

export type PriceQuote = {
  amount: number | null;
  source: "Amazon" | "楽天" | "Yahoo!" | null;
  name: string | null;
  url: string | null;
  note: string | null;
};

/** 「5000、5000 10000」を袋の価格の並びにする。正の整数だけ。読めないものがあれば null（桁区切りのカンマは使えない） */
export function parseBagPrices(text: string): number[] | null {
  const parts = text
    .normalize("NFKC")
    .replace(/円/g, "")
    .split(/[\s,、]+/)
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 100) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[1-9]\d{0,8}$/.test(p)) return null;
    out.push(Number(p));
  }
  return out;
}

/** 金額を袋の価格の割合で分ける。端数は小数部の大きい袋から1円ずつ足し、合計を必ず元の金額に合わせる */
export function splitByPrice(amount: number, prices: number[]): number[] {
  const total = prices.reduce((a, b) => a + b, 0);
  if (amount <= 0 || total <= 0) return prices.map(() => 0);
  const exact = prices.map((p) => (amount * p) / total);
  const out = exact.map(Math.floor);
  let left = amount - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i] += 1;
  return out;
}

export function buildBags(prices: number[], shipping: number, discount: number): Bag[] {
  const s = splitByPrice(shipping, prices);
  const d = splitByPrice(discount, prices);
  return prices.map((price, i) => ({ price, shipping: s[i], discount: d[i], headerId: null }));
}

/** 登録に使える JAN（13桁・チェック数字が合う・店の中だけの番号ではない） */
export function isRegistrableJan(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const head = Number(code.slice(0, 2));
  if (head === 2 || head === 4 || (head >= 20 && head <= 29)) return false;
  const sum = [...code.slice(0, 12)].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/**
 * 複数の写真の JAN を数える。1枚の中で同じ JAN が2つなら2個。
 * 別の写真にも同じ JAN があるときは、撮り直しで二重に数えないよう一番多い枚の個数にする。
 */
export function countPhotoJans(photos: string[][]): Map<string, number> {
  const out = new Map<string, number>();
  for (const codes of photos) {
    const one = new Map<string, number>();
    for (const c of codes) one.set(c, (one.get(c) ?? 0) + 1);
    for (const [c, n] of one) out.set(c, Math.max(out.get(c) ?? 0, n));
  }
  return out;
}

const NOT_NEW_WORDS = /中古|ジャンク|訳あり|訳アリ|ワケあり|アウトレット|展示品|開封済|再生品|リファービッシュ|部品|交換用|互換|レンタル/;
// 「4本入」は商品そのものの場合があるので外さない（セット売りかどうかは Gemini に見させる）
const SET_WORDS = /\d+\s*(個|本|枚|袋|箱|台|点)\s*(セット|組)|まとめ買い|まとめ売り|福袋|[×xX]\s*\d+\s*(個|本|枚|袋|箱|セット)|セット販売/;

/** Gemini に見せる前に、言葉だけで明らかに別物の出品を外す（新品の価格に中古・訳あり・セットを混ぜない） */
export function filterOffers(offers: ShopOffer[], condition: BagCondition): ShopOffer[] {
  return offers.filter((o) => {
    if (!Number.isInteger(o.price) || o.price <= 0) return false;
    if (SET_WORDS.test(o.name.normalize("NFKC"))) return false;
    return condition === "used" || !NOT_NEW_WORDS.test(o.name);
  });
}

export function lowestOffer(offers: ShopOffer[]): ShopOffer | null {
  return offers.reduce<ShopOffer | null>((m, o) => (m === null || o.price < m.price ? o : m), null);
}

type AmazonMoney = { Amount?: number; CurrencyCode?: string };
type AmazonOffersPayload = {
  Summary?: { LowestPrices?: Array<{ condition?: string; ListingPrice?: AmazonMoney }> };
  Offers?: Array<{ SubCondition?: string; ListingPrice?: AmazonMoney }>;
};

/** Amazon の出品一覧の応答から、条件に合う最安の商品価格（送料を含めない）。日本円でなければ使わない */
export function lowestFromAmazonOffers(payload: AmazonOffersPayload | null | undefined, condition: BagCondition): number | null {
  const prices = (payload?.Summary?.LowestPrices ?? [])
    .filter((x) => String(x.condition ?? "").toLowerCase() === condition)
    .map((x) => x.ListingPrice)
    .filter((m): m is AmazonMoney => !!m && m.CurrencyCode === "JPY" && typeof m.Amount === "number" && m.Amount > 0)
    .map((m) => m.Amount as number);
  return prices.length ? Math.ceil(Math.min(...prices)) : null;
}
