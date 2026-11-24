/**
 * 相談-13 段階3：福袋の写真を PC の Claude へ送る（画面側）。
 * 写真は Storage へ直接送り、最後に袋の内容を確定する。通信が切れて押し直しても、同じ袋は1つの受付のまま。
 */
export const MAX_BAG_PHOTOS = 10;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type BagSend = {
  batchId: string;
  files: File[];
  price: number;
  shipping: number;
  discount: number;
  supplier: string;
  orderNumber: string;
  purchaseDate: string;
  condition: "new" | "used";
};

async function post(body: unknown) {
  const res = await fetch("/api/inbound-bag-photos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `送れませんでした（${res.status}）`));
  return data;
}

export function photoProblem(file: File): string | null {
  if (!TYPES.has(file.type)) return `${file.name}：JPEG・PNG・WebP の写真だけ送れます`;
  if (file.size > MAX_PHOTO_BYTES) return `${file.name}：1枚15MBまでです`;
  return null;
}

export async function sendBagPhotos(input: BagSend, onProgress: (done: number, total: number) => void) {
  const { files, ...rest } = input;
  const { uploads } = (await post({ action: "sign", batchId: input.batchId, types: files.map((f) => f.type) })) as {
    uploads: { path: string; url: string }[];
  };
  for (let i = 0; i < files.length; i++) {
    onProgress(i, files.length);
    const res = await fetch(uploads[i].url, { method: "PUT", headers: { "Content-Type": files[i].type }, body: files[i] });
    if (!res.ok) throw new Error(`${i + 1}枚目の写真を送れませんでした（${res.status}）`);
  }
  onProgress(files.length, files.length);
  await post({ ...rest, action: "submit", paths: uploads.map((u) => u.path) });
}
