import type { FastifyRequest, FastifyReply } from "fastify";
import { ChatCompletionRequestSchema } from "../schemas/chatCompletion.js";
import { InferenceService } from "../../application/InferenceService.js";
import { InvalidRequestError, UnauthorizedError } from "../../domain/errors/index.js";

declare module "fastify" {
  interface FastifyRequest {
    authKeyId?: string;
  }
}

export class ChatCompletionController {
  constructor(private readonly inferenceService: InferenceService) {}

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const keyId = req.authKeyId;
    if (!keyId) {
      throw new UnauthorizedError("Missing authenticated context");
    }

    // 1. Validate request payload against strict Zod schema
    const parseResult = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const field = issue ? issue.path.join(".") : undefined;
      const message = issue ? `${issue.message} at '${field}'` : "Invalid request schema";
      throw new InvalidRequestError(message, field);
    }

    const body = parseResult.data;
    const abortController = new AbortController();
    req.raw.on("close", () => {
      if (req.raw.destroyed) {
        abortController.abort();
      }
    });

    const inferenceReq = {
      model: body.model,
      messages: body.messages,
      stream: body.stream,
      temperature: body.temperature,
      maxTokens: body.max_tokens
    };

    if (body.stream) {
      // Configure Server-Sent Events headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no" // Prevent proxy buffering
      });

      try {
        const stream = this.inferenceService.stream(
          inferenceReq,
          keyId,
          req.id,
          abortController.signal
        );

        for await (const chunk of stream) {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        reply.raw.write("data: [DONE]\n\n");
      } finally {
        reply.raw.end();
      }
    } else {
      const result = await this.inferenceService.generate(
        inferenceReq,
        keyId,
        req.id,
        abortController.signal
      );
      await reply.status(200).send(result);
    }
  }
}

