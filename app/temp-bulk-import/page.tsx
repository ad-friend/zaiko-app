"use client";

import { useRef, useState } from "react";

function parseJanList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/\D/g, ""))
    .filter((s) => /^\d{13}$/.test(s));
}

function getRandomWaitMs(): number {
  const min = 8000;
  const max = 12000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export default function TempBulkImportPage() {
  const [textareaValue, setTextareaValue] = useState("");
  const [maxCount, setMaxCount] = useState(400);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [logs, setLogs] = useState<Array<{ type: "ok" | "ng" | "info" | "warn"; text: string }>>([]);
  const stoppedRef = useRef(false);

  const addLog = (type: "ok" | "ng" | "info" | "warn", text: string) => {
    setLogs((prev) => [...prev, { type, text }]);
  };

  const runBulk = async () => {
    const jans = parseJanList(textareaValue);
    if (jans.length === 0) {
      addLog("ng", "有効な13桁JANが1件もありません。");
      return;
    }

    stoppedRef.current = false;
    setRunning(true);
    setProgress({ current: 0, total: Math.min(jans.length, maxCount) });
    setLogs((prev) => [...prev, { type: "info", text: `開始: 最大 ${maxCount} 件まで処理します。（有効JAN: ${jans.length} 件）` }]);

    const limit = Math.min(jans.length, maxCount);
    let done = 0;

    for (let i = 0; i < limit; i++) {
      if (stoppedRef.current) {
        addLog("warn", "強制停止されました。");
        break;
      }

      const jan = jans[i];
      setProgress((p) => ({ ...p, current: i + 1 }));

      try {
        const res = await fetch("/api/temp-bulk-register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jan }),
        });
        const data = await res.json().catch(() => ({}));

        if (data.success) {
          done++;
          addLog("ok", `[${i + 1}] ${jan} → ${data.productName ?? "—"} ${data.brand ? `（${data.brand}）` : ""}`);
        } else {
          addLog("ng", `[${i + 1}] ${jan} 失敗: ${data.error ?? res.statusText}`);
        }
      } catch (e) {
        addLog("ng", `[${i + 1}] ${jan} エラー: ${e instanceof Error ? e.message : "通信エラー"}`);
      }

      if (i < limit - 1 && !stoppedRef.current) {
        const waitMs = getRandomWaitMs();
        addLog("info", `次の処理まで ${(waitMs / 1000).toFixed(1)} 秒待機...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    const reachedLimit = limit >= maxCount && jans.length > maxCount;
    if (reachedLimit && !stoppedRef.current) {
      addLog(
        "warn",
        `⚠️ 設定した上限（${maxCount}件）に達したため、自動停止しました。残りのデータは明日以降に実行してください。`
      );
    }

    addLog("info", `完了: ${done} 件を登録しました。`);
    setRunning(false);
  };

  const handleStop = () => {
    stoppedRef.current = true;
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-xl font-bold text-slate-800 border-b border-slate-200 pb-2">
          仮設：JAN一括登録（商品マスタ）
        </h1>
        <p className="text-sm text-slate-600">
          外部API制限（1日500件目安）・Bot対策のため、1件ごとに8〜12秒の待機を入れています。上限に達したら自動停止します。
        </p>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">JANコード（1行1件）</label>
          <textarea
            value={textareaValue}
            onChange={(e) => setTextareaValue(e.target.value)}
            placeholder={"4901234567890\n4901234567891\n..."}
            rows={12}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            disabled={running}
          />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">1回の最大処理件数</label>
            <input
              type="number"
              min={1}
              max={500}
              value={maxCount}
              onChange={(e) => setMaxCount(Math.max(1, Math.min(500, Number(e.target.value) || 400)))}
              className="w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              disabled={running}
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={runBulk}
              disabled={running}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              一括登録スタート
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!running}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              強制停止
            </button>
          </div>
        </div>

        {running && (
          <p className="text-sm font-medium text-slate-700">
            進行状況: {progress.current} / {progress.total} 件 処理完了
          </p>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">処理結果ログ</label>
          <div
            className="rounded-lg border border-slate-200 bg-white p-4 h-[320px] overflow-y-auto text-xs font-mono space-y-1"
            role="log"
          >
            {logs.length === 0 && (
              <p className="text-slate-400">スタートボタンで実行すると、ここに結果が表示されます。</p>
            )}
            {logs.map((entry, i) => (
              <div
                key={i}
                className={
                  entry.type === "ok"
                    ? "text-emerald-700"
                    : entry.type === "ng"
                      ? "text-red-700"
                      : entry.type === "warn"
                        ? "text-amber-700 font-semibold bg-amber-50 -mx-2 px-2 py-1 rounded"
                        : "text-slate-600"
                }
              >
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
