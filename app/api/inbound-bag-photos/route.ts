/**
 * 相談-13 段階3：福袋の写真の受け渡し（画面 → Supabase Storage → PC の Claude）。
 * POST   … 画面から。action=sign で写真の置き場所を発行、action=submit で袋の内容を確定
 * GET    … PC だけ（Bearer INBOUND_IMPORT_SECRET）。確定した袋と写真の読み取り用 URL
 * DELETE … PC だけ。受け取った写真を Storage から消す（受け取り中に送り直された写真は残す）
 * 写真の保存場所は非公開。在庫の表には書かない（入庫待ちは PC が今の入口から作る）。
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createInboundPendingClient, requireInboundImportAuth } from "@/lib/inbound-pending-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "inbound-bag-photos";
const RECEIPT = "receipt.json";
const BATCH_ID = /^[a-z0-9]{4,16}-[a-z0-9]{4,16}-b\d{1,3}$/;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_PHOTOS = 10;
const MAX_WAITING_BAGS = 200; // PC が受け取っていない袋がこれ以上たまったら受け付けない

type Db = ReturnType<typeof createInboundPendingClient>;

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function money(v: unknown, min: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= 999_999_999 ? v : null;
}

async function ensureBucket(db: Db) {
  const { data } = await db.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await db.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: "15MB",
    allowedMimeTypes: [...Object.keys(EXT), "application/json"],
  });
  if (error && !/already exists/i.test(error.message)) throw new Error(error.message);
}

async function sign(db: Db, batchId: string, types: unknown) {
  if (!Array.isArray(types) || types.length < 1 || types.length > MAX_PHOTOS) return bad(`写真は1袋に1〜${MAX_PHOTOS}枚です`);
  if (!types.every((t) => typeof t === "string" && EXT[t])) return bad("写真（JPEG・PNG・WebP）だけ受け付けます");
  await ensureBucket(db);
  const { data: waiting, error } = await db.storage.from(BUCKET).list("", { limit: MAX_WAITING_BAGS + 1 });
  if (error) throw new Error(error.message);
  if ((waiting?.length ?? 0) > MAX_WAITING_BAGS) return bad("受け取り待ちの写真が多すぎます。しばらくしてから送ってください", 429);
  const uploads = [];
  for (const t of types as string[]) {
    const path = `${batchId}/${randomUUID()}.${EXT[t]}`;
    const { data, error: e } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (e || !data) throw new Error(e?.message ?? "写真の置き場所を作れませんでした");
    uploads.push({ path, url: data.signedUrl });
  }
  return NextResponse.json({ uploads });
}

async function submit(db: Db, batchId: string, b: Record<string, unknown>) {
  const price = money(b.price, 1);
  const shipping = money(b.shipping, 0);
  const discount = money(b.discount, 0);
  if (price === null || shipping === null || discount === null) return bad("金額は整数で入れてください");
  if (price + shipping - discount <= 0) return bad("割引が袋の金額より大きくなっています");
  const date = String(b.purchaseDate ?? "");
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return bad("仕入日を入れてください");
  if (b.condition !== "new" && b.condition !== "used") return bad("新品か中古を選んでください");
  const supplier = String(b.supplier ?? "").trim().slice(0, 100);
  if (!supplier) return bad("仕入先を入れてください");
  const paths = b.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_PHOTOS) return bad(`写真は1袋に1〜${MAX_PHOTOS}枚です`);
  const { data: files, error } = await db.storage.from(BUCKET).list(batchId, { limit: 100 });
  if (error) throw new Error(error.message);
  const have = new Set((files ?? []).map((f) => `${batchId}/${f.name}`));
  if (!paths.every((p) => typeof p === "string" && p !== `${batchId}/${RECEIPT}` && have.has(p))) return bad("写真が届いていません。もう一度送ってください");
  const receipt = {
    at: new Date().toISOString(),
    supplier,
    orderNumber: String(b.orderNumber ?? "").trim().slice(0, 100),
    purchaseDate: date,
    condition: b.condition,
    price,
    shipping,
    discount,
    photos: (paths as string[]).map((p) => p.slice(batchId.length + 1)),
  };
  const { error: e } = await db.storage.from(BUCKET).upload(`${batchId}/${RECEIPT}`,
    new Blob([JSON.stringify(receipt)], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  if (e) throw new Error(e.message);
  return NextResponse.json({ ok: true, batchId });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("JSONではありません");
  }
  const batchId = String(body?.batchId ?? "");
  if (!BATCH_ID.test(batchId)) return bad("袋の番号が正しくありません");
  try {
    const db = createInboundPendingClient();
    if (body.action === "sign") return await sign(db, batchId, body.types);
    if (body.action === "submit") return await submit(db, batchId, body);
    return bad("action が正しくありません");
  } catch (e) {
    return bad(e instanceof Error ? e.message : "写真を受け付けられませんでした", 500);
  }
}

function pcOnly(req: NextRequest) {
  const auth = requireInboundImportAuth(req.headers.get("authorization"));
  if (auth === 500) return bad("取込の合い言葉が設定されていません", 500);
  if (auth === 401) return bad("Unauthorized", 401);
  return null;
}

export async function GET(req: NextRequest) {
  const denied = pcOnly(req);
  if (denied) return denied;
  try {
    const db = createInboundPendingClient();
    await ensureBucket(db);
    const store = db.storage.from(BUCKET);
    const { data: folders, error } = await store.list("", { limit: MAX_WAITING_BAGS + 1, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    const batches = [];
    for (const f of folders ?? []) {
      if (batches.length >= 30) break; // 残りは次の回
      if (!BATCH_ID.test(f.name)) continue;
      const { data: file, error: readError } = await store.download(`${f.name}/${RECEIPT}`);
      if (readError || !file) continue; // まだ確定していない袋
      const receipt = JSON.parse(await file.text()) as { photos: string[] };
      const { data: urls, error: urlError } = await store.createSignedUrls(receipt.photos.map((p) => `${f.name}/${p}`), 600);
      if (urlError || !urls) throw new Error(urlError?.message ?? "写真の URL を作れませんでした");
      batches.push({ batchId: f.name, receipt, photos: receipt.photos.map((name, i) => ({ name, url: urls[i]?.signedUrl ?? null })) });
    }
    return NextResponse.json({ batches });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "読み込みに失敗しました", 500);
  }
}

export async function DELETE(req: NextRequest) {
  const denied = pcOnly(req);
  if (denied) return denied;
  let batchId = "";
  let received: string[] = [];
  try {
    const body = (await req.json()) as { batchId?: unknown; photos?: unknown };
    batchId = String(body.batchId ?? "");
    if (Array.isArray(body.photos)) received = body.photos.map(String);
  } catch {
    return bad("JSONではありません");
  }
  if (!BATCH_ID.test(batchId)) return bad("袋の番号が正しくありません");
  if (received.length === 0) return bad("受け取った写真の名前がありません");
  try {
    const store = createInboundPendingClient().storage.from(BUCKET);
    const { data: files, error } = await store.list(batchId, { limit: 100 });
    if (error) throw new Error(error.message);
    // 今の受付の写真をすべて受け取っていれば袋ごと消す。受け取り中に送り直されていたら、受け取った写真だけ消して受付は残す
    const { data: file } = await store.download(`${batchId}/${RECEIPT}`);
    const current = file ? ((JSON.parse(await file.text()) as { photos?: string[] }).photos ?? []) : [];
    const whole = current.every((n) => received.includes(n));
    const keep = new Set(whole ? [] : [...current, RECEIPT]);
    const paths = (files ?? [])
      .filter((f) => !keep.has(f.name) && (whole || received.includes(f.name)))
      .map((f) => `${batchId}/${f.name}`);
    if (paths.length) {
      const { error: e } = await store.remove(paths);
      if (e) throw new Error(e.message);
    }
    return NextResponse.json({ ok: true, removed: paths.length, kept: !whole });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "消せませんでした", 500);
  }
}
