import { expect, it } from "vitest";
import { createInferenceClient } from "../../examples/openai-client.js";
import { hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";

it("pre-hashes the local application secret before passing it to the OpenAI SDK", () => {
  const secret = "client-secret-for-authentication-test";
  const client = createInferenceClient(secret);
  expect(client.apiKey).toBe(hashSecretSha256(secret));
  expect(client.apiKey).not.toBe(secret);
});
