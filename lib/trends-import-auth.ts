export function requireTrendsImportAuth(authorization: string | null): 200 | 401 | 500 {
  const secret = process.env.TRENDS_IMPORT_SECRET;
  if (!secret) return 500;
  return authorization === `Bearer ${secret}` ? 200 : 401;
}
