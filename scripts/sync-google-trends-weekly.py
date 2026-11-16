"""反映了承後、PCの環境変数で週1回実行。.env類・DBには直接アクセスしない。"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.request import Request
from urllib.parse import urlparse


def main():
    from pytrends.request import TrendReq
    secret = os.environ.get("ZAIKO_TRENDS_IMPORT_SECRET")
    base = os.environ.get("ZAIKO_APP_URL", "").rstrip("/")
    parsed = urlparse(base)
    if not secret or parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("設定が不足しています")
    end = datetime.now(timezone(timedelta(hours=9))).date() - timedelta(days=1)
    start = end - timedelta(days=89)
    trends = TrendReq(hl="ja-JP", tz=-540, timeout=(10, 30), retries=0)
    trends.build_payload(["Amazon"], geo="JP", timeframe=f"{start} {end}")
    frame = trends.interest_over_time()
    if frame.empty or ("isPartial" in frame and frame["isPartial"].any()):
        raise ValueError("トレンドが未確定です")
    rows = [{"date": str(index.date()), "keyword": "Amazon", "trend_value": float(row["Amazon"])} for index, row in frame.iterrows()]
    expected = {str(start + timedelta(days=i)) for i in range(90)}
    if len(rows) != 90 or {r["date"] for r in rows} != expected or any(not 0 <= r["trend_value"] <= 100 for r in rows):
        raise ValueError("トレンドに欠損があります")
    payload = json.dumps({"window_start": str(start), "window_end": str(end), "rows": rows}).encode("utf-8")
    # リダイレクト先へトークンを渡さない。
    from urllib.request import HTTPRedirectHandler, build_opener
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise ValueError("転送は許可されていません")
    req = Request(base + "/api/dashboard/trends-import", data=payload, headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"}, method="POST")
    with build_opener(NoRedirect()).open(req, timeout=30) as response:
        if response.status != 200:
            raise ValueError("保存に失敗しました")
    print("Googleトレンド90日分を保存しました")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 署名・URL・Bearerを含み得る例外を表示しない。
        print("Googleトレンドの取得・保存に失敗しました", file=sys.stderr)
        sys.exit(1)
