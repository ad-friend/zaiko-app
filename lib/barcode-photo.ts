/**
 * 相談-13 段階3：写真から JAN を読む（ブラウザの中だけで処理し、写真は送らない）。
 * iPhone・Windows でも動くよう、ブラウザの BarcodeDetector には頼らず zxing-wasm を使う。
 * 読み取りの本体は public/zxing_reader.wasm（node_modules/zxing-wasm/dist/reader/ の写し。版を上げたら写し直す）。
 */
import { isRegistrableJan } from "@/lib/inbound-bags";

let prepared = false;

export async function readJansFromPhoto(file: Blob): Promise<{ jans: string[]; unusable: number }> {
  const { readBarcodes, prepareZXingModule } = await import("zxing-wasm/reader");
  if (!prepared) {
    prepareZXingModule({
      overrides: {
        locateFile: (p: string, prefix: string) => (p.endsWith(".wasm") ? "/zxing_reader.wasm" : prefix + p),
      },
    });
    prepared = true;
  }
  const res = await readBarcodes(file, {
    formats: ["EAN13", "EAN8"],
    tryHarder: true,
    tryRotate: true,
    tryDownscale: true,
    maxNumberOfSymbols: 64,
  });
  const valid = res.filter((r) => r.isValid).map((r) => r.text.trim());
  const jans = valid.filter(isRegistrableJan);
  return { jans, unusable: valid.length - jans.length };
}
