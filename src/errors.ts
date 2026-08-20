export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly publicDetail: string
  ) {
    super(code);
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("internal_error", 500, false, "Unexpected internal error.");
}
