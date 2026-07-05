/**
 * Return a copy of `kwargs` containing only keys the approver should see.
 *
 * Framework plumbing (LangChain's `config`, tool-call ids, etc.) should never
 * reach the approver; the tool author opts in to specific keys via `args`.
 * Port of `utils/utils.py::_filter_kwargs`.
 */
export function filterKwargs(
  kwargs: Record<string, unknown>,
  allowed?: string[] | null,
): Record<string, unknown> {
  if (allowed == null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(kwargs)) {
      if (k !== "config") out[k] = v;
    }
    return out;
  }
  const allow = new Set(allowed);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kwargs)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}
