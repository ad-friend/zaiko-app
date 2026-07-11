"use client";

import { useCallback, useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { X } from "lucide-react";

type BarcodeScannerModalProps = {
  open: boolean;
  onClose: () => void;
  onScan: (code: string) => void;
  /** DOM id for the scanner element (must be unique per page) */
  readerId?: string;
};

export default function BarcodeScannerModal({
  open,
  onClose,
  onScan,
  readerId = "barcode-reader",
}: BarcodeScannerModalProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  const handledRef = useRef(false);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stopScanner = useCallback(async () => {
    if (!scannerRef.current) return;
    try {
      await scannerRef.current.stop();
      scannerRef.current.clear();
    } catch (err) {
      console.warn("カメラの停止中にエラー:", err);
    } finally {
      scannerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    handledRef.current = false;
    const el = document.getElementById(readerId);
    if (!el) return;

    const html5Qr = new Html5Qrcode(readerId);
    scannerRef.current = html5Qr;
    let cancelled = false;

    html5Qr
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        (decodedText) => {
          const trimmed = decodedText.trim();
          if (trimmed.length < 8 || handledRef.current || cancelled) return;
          handledRef.current = true;
          setTimeout(() => {
            if (cancelled) return;
            onScanRef.current(trimmed);
            onCloseRef.current();
          }, 100);
        },
        () => {}
      )
      .catch((err: unknown) => {
        console.error(err);
      });

    return () => {
      cancelled = true;
      if (scannerRef.current) {
        scannerRef.current
          .stop()
          .then(() => {
            scannerRef.current?.clear();
            scannerRef.current = null;
          })
          .catch(() => {
            scannerRef.current = null;
          });
      }
    };
  }, [open, readerId]);

  const handleClose = useCallback(() => {
    void stopScanner().then(() => onClose());
  }, [onClose, stopScanner]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900">バーコードスキャン</h3>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-hidden rounded-xl bg-black border border-slate-200 shadow-inner">
          <div id={readerId} style={{ width: "100%", minHeight: 250 }} />
        </div>
        <p className="mt-4 text-center text-sm font-medium text-slate-500">
          カメラを商品コードに向けてください
        </p>
      </div>
    </div>
  );
}
