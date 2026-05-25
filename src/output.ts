import { AppError, isAppError } from "./errors.ts";
import type { ErrorCode } from "./types/index.ts";

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export function successResponse<T extends object>(data: T): T {
  return data;
}

export function errorResponse(error: unknown): ErrorResponse {
  const appError = isAppError(error)
    ? error
    : new AppError("config-missing", "Unexpected error");

  return {
    error: {
      code: appError.code,
      message: appError.message,
    },
  };
}
