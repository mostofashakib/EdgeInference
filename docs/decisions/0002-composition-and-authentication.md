# ADR 0002: Composition Root, Dependency Inversion, and Authentication

## Status
Accepted

## Context
In Milestone 2, we must establish the application skeleton for the EdgeInference service.
Key requirements:
- The HTTP layer must depend on application services, which depend strictly on domain contracts (interfaces).
- No global singletons, service locators, or heavyweight reflection-based DI containers (NestJS, Inversify).
- Mandatory Bearer API secret authentication must execute before expensive request body parsing and image processing.
- The authenticator must use constant-time comparison to protect against timing side-channel attacks.
- Rotated secrets must be supported with stable internal key identity.
- Secrets must never be leaked in logs, metrics, or error responses.
- The test suite must be able to swap out infrastructure dependencies with lightweight test fakes without changing application logic.

## Decision

1. **Layered Architecture & Manual Constructor Injection**:
   - Presentation Layer: Fastify routes and `ChatCompletionController`.
   - Application Layer: `InferenceService` and `QuotaService`.
   - Domain Contracts: Core interfaces (`InferenceClient`, `ApiKeyAuthenticator`, `QuotaRepository`, `AdmissionController`, `ImageProcessor`, `Clock`, `MetricsRecorder`).
   - Infrastructure Layer: Concrete adapters (`BearerTokenAuthenticator`, `SystemClock`, `StructuredMetricsRecorder`).
   - Composition Root: `gateway/src/app.ts` (`createApp`) and `gateway/src/composition/createDependencies.ts` (`createDependencies`).
2. **Early Authentication in `onRequest` Hook**:
   - `onRequest` executes prior to Fastify's body parsing. Requests without valid `Authorization: Bearer <token>` headers are immediately rejected with HTTP 401, preventing unauthenticated clients from consuming memory or CPU on body parsing and image decompression.
3. **Timing-Safe Secret Comparison**:
   - `timingSafeEqualString` hashes both the expected secret and the user-supplied token using SHA-256 before running `crypto.timingSafeEqual`, guaranteeing fixed-length buffers and eliminating timing side-channels.
4. **Log Redaction**:
   - Fastify logger is explicitly configured to redact `req.headers.authorization`, `cf-access-client-secret`, `cf-access-client-id`, `cookie`, and any object fields matching `*secret*`, `*key*`, or `*token*`.
5. **Standardized Error Representation**:
   - Domain errors inherit from `DomainError` and serialize directly into OpenAI-compatible format (`{ error: { message, type, param, code } }`).

## Consequences
- Every component is fully unit testable in isolation.
- Integration tests can exercise the full Fastify HTTP pipeline using `app.inject` with zero external network or database dependencies.
- Zero secret leakage in logs, traces, or HTTP responses.

