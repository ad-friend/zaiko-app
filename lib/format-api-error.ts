export type ApiErrorPayload = {
  error: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
  step?: string;
  rowErrors?: string[];
};

export function formatUnknownError(e: unknown, fallback = "処理に失敗しました。"): ApiErrorPayload {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as { message?: string; details?: string; hint?: string; code?: string };
    const message = String(o.message ?? "").trim();
    return {
      error: message || fallback,
      details: o.details ?? null,
      hint: o.hint ?? null,
      code: o.code ?? null,
    };
  }
  if (typeof e === "string" && e.trim()) return { error: e.trim() };
  return { error: fallback };
}

export function supabaseStepError(
  step: string,
  error: { message: string; details?: string; hint?: string; code?: string }
): ApiErrorPayload {
  return {
    step,
    error: `${step}: ${error.message}`,
    details: error.details ?? null,
    hint: error.hint ?? null,
    code: error.code ?? null,
  };
}
