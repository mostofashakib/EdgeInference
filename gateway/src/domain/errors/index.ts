export abstract class DomainError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errorType: string;
  abstract readonly errorCode: string;
  readonly param?: string | undefined;

  constructor(message: string, param?: string | undefined) {
    super(message);
    this.name = this.constructor.name;
    this.param = param;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toResponseJson() {
    return {
      error: {
        message: this.message,
        type: this.errorType,
        param: this.param ?? null,
        code: this.errorCode
      }
    };
  }
}

export class UnauthorizedError extends DomainError {
  readonly statusCode = 401;
  readonly errorType = "authentication_error";
  readonly errorCode = "unauthorized";

  constructor(message = "Unauthorized: Invalid or missing API secret") {
    super(message);
  }
}

export class InvalidRequestError extends DomainError {
  readonly statusCode = 400;
  readonly errorType = "invalid_request_error";
  readonly errorCode = "invalid_request";

  constructor(message: string, param?: string) {
    super(message, param);
  }
}

export class ModelNotAllowedError extends DomainError {
  readonly statusCode = 404;
  readonly errorType = "invalid_request_error";
  readonly errorCode = "model_not_allowed";

  constructor(model: string) {
    super(`Model '${model}' is not supported.`, "model");
  }
}

export class QuotaExceededError extends DomainError {
  readonly statusCode = 429;
  readonly errorType = "rate_limit_error";
  readonly errorCode = "quota_exceeded";

  constructor(message = "Daily request quota exceeded.") {
    super(message);
  }
}

export class ConcurrencyLimitError extends DomainError {
  readonly statusCode = 429;
  readonly errorType = "rate_limit_error";
  readonly errorCode = "inference_busy";

  constructor(message = "Inference service is at capacity. Please try again shortly.") {
    super(message);
  }
}

export class PayloadTooLargeError extends DomainError {
  readonly statusCode = 413;
  readonly errorType = "invalid_request_error";
  readonly errorCode = "payload_too_large";

  constructor(message = "Request payload exceeds size limit.") {
    super(message);
  }
}

export class UpstreamServiceError extends DomainError {
  readonly statusCode = 502;
  readonly errorType = "server_error";
  readonly errorCode = "upstream_service_error";

  constructor(message = "Upstream inference engine failed.") {
    super(message);
  }
}
