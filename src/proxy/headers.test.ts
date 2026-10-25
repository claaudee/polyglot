import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredGateway, gatewayEnv } from "../claude-env.js";
import { clientResponseHeaders, upstreamRequestHeaders } from "./headers.js";
import { SseParser } from "./sse.js";

describe("upstreamRequestHeaders", () => {
  it("keeps the client's sign-in and betas, drops transport, connection-listed and proxy headers", () => {
    const headers = upstreamRequestHeaders({
      host: "127.0.0.1:1234",
      connection: "keep-alive, X-Hop",
      "x-hop": "only for this hop",
      "content-length": "12",
      "accept-encoding": "gzip, br",
      "x-forwarded-for": "10.0.0.1",
      via: "1.1 corp",
      authorization: "Bearer oauth-test",
      "anthropic-beta": ["a", "b"],
    });
    assert.deepEqual(headers, {
      authorization: "Bearer oauth-test",
      "anthropic-beta": "a,b",
      "accept-encoding": "identity",
    });
  });
});

describe("clientResponseHeaders", () => {
  it("drops framing headers, since the proxy re-frames the body", () => {
    const response = new Response("", {
      headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "request-id": "req_1" },
    });
    assert.deepEqual(clientResponseHeaders(response), { "content-type": "text/event-stream", "request-id": "req_1" });
  });
});

describe("gatewayEnv", () => {
  it("points every gateway variable at the proxy and exempts loopback from HTTP proxies", () => {
    const env = gatewayEnv({ NO_PROXY: "corp.local, localhost", HTTPS_PROXY: "http://corp:3128" }, "http://127.0.0.1:9");
    assert.equal(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:9");
    assert.equal(env["ANTHROPIC_API_BASE_URL"], "http://127.0.0.1:9");
    assert.equal(env["CLAUDE_AGENT_API_BASE_URL"], "http://127.0.0.1:9");
    assert.equal(env["NO_PROXY"], "corp.local,localhost,127.0.0.1,::1");
    assert.equal(env["no_proxy"], "127.0.0.1,localhost,::1");
    assert.equal(env["HTTPS_PROXY"], "http://corp:3128");
  });

  it("finds an already configured gateway in Claude Code's order", () => {
    assert.equal(configuredGateway({ CLAUDE_AGENT_API_BASE_URL: "https://b", ANTHROPIC_BASE_URL: " " }), "https://b");
    assert.equal(configuredGateway({}), undefined);
  });
});

describe("SseParser data", () => {
  it("joins multi-line data and treats [DONE] as no data", () => {
    const [joined, done] = new SseParser().push('event: x\ndata: {"a":\ndata: 1}\n\ndata: [DONE]\n\n');
    assert.deepEqual(joined?.data, { a: 1 });
    assert.equal(done?.data, undefined);
  });
});
