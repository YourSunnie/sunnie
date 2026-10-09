/** Errors that map directly onto an HTTP response. */
export class HttpError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 413 | 500 | 502;
  readonly code: string;

  constructor(status: 400 | 401 | 404 | 409 | 413 | 500 | 502, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
