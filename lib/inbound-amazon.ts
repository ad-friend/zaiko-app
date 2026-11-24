/**
 * 相談-13 段階2：入庫待ちの商品を「Amazon の自分の出品」に当て、その商品ページの JAN（EAN）を返す。
 * サーバー専用。読むだけ（Amazon の商品情報と、出品の辞書 amazon_sku_conditions）。
 * 書類に印字された JAN や型番は候補を探す手がかりにだけ使い、登録に使う JAN は Amazon 側の識別子から取る。
 */
import { createInboundPendingClient } from "@/lib/inbound-pending-server";
import { lowestFromAmazonOffers, type BagCondition } from "@/lib/inbound-bags";

const MARKETPLACE_ID_JP = "A1VC38T7YXB528";

export type CatalogCandidate = {
  asin: string;
  title: string | null;
  brand: string | null;
  model: string | null; // modelNumber か partNumber
  eans: string[]; // Amazon の商品情報の EAN / JAN（数字だけ）
  ownSkus: { sku: string; condition: string }[]; // 自分の出品（出品の辞書にあるもの）。condition は辞書の値そのまま（New / Used など）
  foundBy: ("jan" | "keyword")[];
};

function createSpClient() {
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;
  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) {
    throw new Error("Amazon の設定が不足しています");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SellingPartnerAPI = require("amazon-sp-api");
  return new SellingPartnerAPI({
    region: "fe",
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
      AWS_SELLING_PARTNER_ROLE: "",
    },
  });
}

type RawItem = {
  asin?: string;
  summaries?: Array<{ itemName?: string; brand?: string; modelNumber?: string; partNumber?: string }>;
  identifiers?: Array<{ identifiers?: Array<{ identifierType?: string; identifier?: string }> }>;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function search(sp: { callAPI: (o: unknown) => Promise<unknown> }, query: Record<string, unknown>): Promise<RawItem[]> {
  const res = (await sp.callAPI({
    operation: "searchCatalogItems",
    endpoint: "catalogItems",
    query: { marketplaceIds: [MARKETPLACE_ID_JP], includedData: ["summaries", "identifiers"], pageSize: 20, ...query },
    options: { version: "2022-04-01" },
  })) as { items?: RawItem[] };
  return Array.isArray(res?.items) ? res.items : [];
}

function eansOf(it: RawItem): string[] {
  const out = new Set<string>();
  for (const g of it.identifiers ?? []) {
    for (const x of g.identifiers ?? []) {
      const t = String(x.identifierType ?? "").toUpperCase();
      const v = String(x.identifier ?? "").replace(/\D/g, "");
      if ((t === "EAN" || t === "JAN") && (v.length === 13 || v.length === 8)) out.add(v);
    }
  }
  return [...out];
}

/** 印字の JAN（あれば）と言葉（型番・品名）で Amazon を探し、自分の出品があるものに印を付けて返す */
export async function findCatalogCandidates(input: { refJan?: string | null; keywords?: string[] }): Promise<CatalogCandidate[]> {
  const sp = createSpClient();
  const byAsin = new Map<string, { it: RawItem; foundBy: Set<"jan" | "keyword"> }>();
  const add = (items: RawItem[], how: "jan" | "keyword") => {
    for (const it of items) {
      const asin = String(it.asin ?? "").trim();
      if (asin.length < 10) continue;
      const cur = byAsin.get(asin) ?? { it, foundBy: new Set() };
      cur.foundBy.add(how);
      byAsin.set(asin, cur);
    }
  };

  const jan = String(input.refJan ?? "").replace(/\D/g, "");
  if (jan.length === 13 || jan.length === 8) {
    try {
      add(await search(sp, { identifiers: [jan], identifiersType: "EAN" }), "jan");
    } catch {
      /* 見つからない・形が違うときは言葉で探す */
    }
    await sleep(600);
  }
  for (const kw of (input.keywords ?? []).map((k) => String(k).trim()).filter((k) => k.length >= 2).slice(0, 3)) {
    add(await search(sp, { keywords: [kw.slice(0, 120)] }), "keyword");
    await sleep(600);
  }
  if (byAsin.size === 0) return [];

  // 自分の出品（出品の辞書）を ASIN で引く
  const db = createInboundPendingClient();
  const asins = [...byAsin.keys()];
  const { data, error } = await db.from("amazon_sku_conditions").select("sku,asin,condition_id").in("asin", asins);
  if (error) throw new Error(error.message);
  const own = new Map<string, { sku: string; condition: string }[]>();
  for (const r of data ?? []) {
    const a = String(r.asin ?? "");
    const list = own.get(a) ?? [];
    list.push({ sku: String(r.sku), condition: String(r.condition_id ?? "") });
    own.set(a, list);
  }

  return asins.map((asin) => {
    const { it, foundBy } = byAsin.get(asin)!;
    const s = it.summaries?.[0] ?? {};
    return {
      asin,
      title: s.itemName ?? null,
      brand: s.brand ?? null,
      model: s.modelNumber ?? s.partNumber ?? null,
      eans: eansOf(it),
      ownSkus: own.get(asin) ?? [],
      foundBy: [...foundBy],
    };
  });
}

/** 自分の出品の一覧（出品の辞書）。ASIN ごとに SKU をまとめて返す。読むだけ */
export async function listOwnAsins(): Promise<{ asin: string; skus: { sku: string; condition: string }[] }[]> {
  const db = createInboundPendingClient();
  const own = new Map<string, { sku: string; condition: string }[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("amazon_sku_conditions")
      .select("sku,asin,condition_id")
      .not("asin", "is", null)
      .order("sku", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const a = String(r.asin ?? "").trim();
      if (a.length < 10) continue;
      own.set(a, [...(own.get(a) ?? []), { sku: String(r.sku), condition: String(r.condition_id ?? "") }]);
    }
    if ((data?.length ?? 0) < PAGE) break;
  }
  return [...own.entries()].map(([asin, skus]) => ({ asin, skus }));
}

/** ASIN（1回20件まで）から商品名・型番・JAN を返す。読むだけ */
export async function findCatalogByAsins(asins: string[]): Promise<Omit<CatalogCandidate, "ownSkus" | "foundBy">[]> {
  const items = await search(createSpClient(), { identifiers: asins.slice(0, 20), identifiersType: "ASIN" });
  return items.map((it) => {
    const s = it.summaries?.[0] ?? {};
    return { asin: String(it.asin ?? ""), title: s.itemName ?? null, brand: s.brand ?? null, model: s.modelNumber ?? s.partNumber ?? null, eans: eansOf(it) };
  });
}

/**
 * 相談-13 段階3：JAN が商品ページの識別子と一致する ASIN が1つに決まるときだけ、その条件（新品／中古）の最安の商品価格を返す。
 * 読むだけ。決まらないときは amount なしで理由を返す（次の楽天・Yahoo! へ進む）。
 */
export async function lowestAmazonPrice(
  jan: string,
  condition: BagCondition
): Promise<{ amount: number | null; asin: string | null; title: string | null; note: string | null }> {
  const hits = (await findCatalogCandidates({ refJan: jan })).filter((c) => c.foundBy.includes("jan") && c.eans.includes(jan));
  if (hits.length === 0) return { amount: null, asin: null, title: null, note: "Amazon にカタログなし" };
  if (hits.length > 1) return { amount: null, asin: null, title: null, note: `Amazon に同じ JAN の商品が${hits.length}件あり決められない` };
  const c = hits[0];
  const sp = createSpClient();
  const res = (await sp.callAPI({
    operation: "getItemOffers",
    endpoint: "productPricing",
    path: { Asin: c.asin },
    query: { MarketplaceId: MARKETPLACE_ID_JP, ItemCondition: condition === "used" ? "Used" : "New" },
  })) as Parameters<typeof lowestFromAmazonOffers>[0];
  const amount = lowestFromAmazonOffers(res, condition);
  return { amount, asin: c.asin, title: c.title, note: amount === null ? `Amazon に${condition === "used" ? "中古" : "新品"}の出品なし` : null };
}
