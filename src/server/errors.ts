export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, public code: string, message: string) { super(message); }
}
export function invalid(message: string): never { throw new ApiError(422, 'VALIDATION_ERROR', message); }
