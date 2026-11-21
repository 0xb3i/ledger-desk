import { useEffect, useState } from "react";
import type { ApiErrorBody, ApiResult } from "../../shared/contracts";

export class RequestError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "NETWORK_ERROR",
  ) {
    super(message);
  }
}
interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}
export async function api<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, headers, ...rest } = options;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...rest,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new RequestError("连接中断，请检查网络后重试。");
  }
  if (response.status === 401 && path !== "/session" && !rest.signal?.aborted)
    window.dispatchEvent(new Event("session-expired"));
  let payload: ApiResult<T> | ApiErrorBody;
  try {
    payload = await response.json();
  } catch {
    throw new RequestError("服务暂时不可用，请稍后重试。", response.status);
  }
  if (!response.ok) {
    const error =
      "error" in payload
        ? payload.error
        : { message: "操作未完成，请重试。", code: "REQUEST_ERROR" };
    throw new RequestError(error.message, response.status, error.code);
  }
  if (!("data" in payload))
    throw new RequestError(
      "服务返回了无法识别的结果，请刷新页面。",
      response.status,
    );
  return payload.data;
}

export function useResource<T>(path: string | null, revision = 0, { keepOnRefresh = false } = {}) {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string;
    errorStatus?: number;
    errorCode?: string;
    dataPath: string | null;
  }>({ data: null, loading: true, error: "", dataPath: null });
  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: "", dataPath: null });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: "", errorStatus: undefined, errorCode: undefined }));
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, loading: false, error: "", dataPath: path });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted)
          setState(previous => ({ data: keepOnRefresh && previous.dataPath === path ? previous.data : null,
            loading: false, error: error.message, dataPath: path,
            errorStatus: error instanceof RequestError ? error.status : undefined,
            errorCode: error instanceof RequestError ? error.code : undefined }));
      });
    return () => controller.abort();
  }, [path, revision, keepOnRefresh]);
  const samePath = state.dataPath === path;
  const refreshing = Boolean(keepOnRefresh && samePath && state.data && state.loading);
  return {
    data: !samePath ? null : state.data,
    error: !samePath ? "" : state.error,
    errorStatus: !samePath ? undefined : state.errorStatus,
    errorCode: !samePath ? undefined : state.errorCode,
    loading: Boolean(path && (!samePath || (state.loading && !refreshing))),
    refreshing,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
