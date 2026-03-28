/**
 * 注文取得 API（エイリアス）
 * 実装は Amazon SP-API 連携の `GET /api/amazon/fetch-orders` と同一。
 * 注文明細から JAN（EAN）解決・amazon_orders 保存までここ経由でも利用可能。
 */
export { GET } from "../amazon/fetch-orders/route";
