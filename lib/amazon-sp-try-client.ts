/**
 * Amazon SP-API クライアント（任意）。環境変数が揃わない場合は null。
 * Catalog 呼び出し前のレート制限用 sleep もここに集約。
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tryCreateSpClient(): { callAPI: (params: Record<string, unknown>) => Promise<unknown> } | null {
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;
  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) {
    return null;
  }
  try {
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
  } catch {
    return null;
  }
}
