import type { OperationResult } from "../operations/types.js";
import { toErrorEnvelope } from "./error.js";

export function tryHandler<TParams, TResult>(
  fn: (params: TParams) => Promise<OperationResult<TResult>>
): (params: TParams) => Promise<OperationResult<TResult>> {
  return async (params) => {
    try {
      return await fn(params);
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  };
}
