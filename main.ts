import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getProviders, getProviderBudget, recordSuccess, recordFailure, type Provider } from "./lib/providers.ts";
import { 
  SERVED_MODELS, 
  handleModelsList, 
  handleAnthropicModelsList, 
  handleGeminiModelsList, 
  makeErrorResponse, 
  makeAnthropicErrorResponse, 
  makeGeminiErrorResponse,
  translateAnthropicToOpenAI,
  translateGeminiToOpenAI,
  translateOpenAIToAnthropicResponse,
  translateOpenAIToGeminiResponse
} from "./lib/wire.ts";

const REGISTRATION_URL = "https://make.fun/api/register";
const POLL_URL = "https://make.fun/api/poll";

async function registerEntry() {
  const url = Deno.env.get("MAKEFUN_REGISTRATION_URL") || REGISTRATION_URL;
  const token = Deno.env.get("MAKEFUN_REGISTRATION_TOKEN");
  const entryUrl = Deno.env.get("MAKEFUN_ENTRY_URL");

  if (!token || !entryUrl) {
    console.log("Skipping registration: MAKEFUN_REGISTRATION_TOKEN or MAKEFUN_ENTRY_URL not set.");
    return;
  }

  try {
    console.log(`Registering entry at ${url} with URL ${entryUrl}...`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: entryUrl, models: SERVED_MODELS.map((m) => m.id) }),
    });
    const text = await res.text();
    console.log(`Registration response (${res.status}):`, text);
  } catch (err) {
    console.error("Failed to register entry:", err);
  }
}

async function pollChallenges() {
  const url = Deno.env.get("MAKEFUN_POLL_URL") || POLL_URL;
  const token = Deno.env.get("MAKEFUN_REGISTRATION_TOKEN");

  if (!token) {
    console.log("Skipping poll: MAKEFUN_REGISTRATION_TOKEN not set.");
    return;
  }

  try {
    console.log(`Polling challenges from ${url}...`);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const text = await res.text();
    console.log(`Poll response (${res.status}):`, text);
  } catch (err) {
    console.error("Failed to poll challenges:", err);
  }
}

// Rating-based routing with budget spreading
function selectProviders(modelId: string): Provider[] {
  const all = getProviders();
  // Filter providers that support the model or have capacity
  const eligible = all.filter((p) => p.remainingBudget > 0);
  if (eligible.length === 0) {
    return all.length > 0 ? all : [];
  }
  // Sort by rating desc, then remaining budget desc
  eligible.sort((a, b) => {
    if (b.rating !== a.rating) {
      return b.rating - a.rating;
    }
    return b.remainingBudget - a.remainingBudget;
  });
  return eligible;
}

async function handleProxyRequest(req: Request, clientWire: "openai" | "anthropic" | "gemini"): Promise<Response> {
  const url = new URL(req.url);

  // Model list endpoints
  if (req.method === "GET" || req.method === "HEAD") {
    if (url.pathname.includes("/models")) {
      if (clientWire === "anthropic") return handleAnthropicModelsList();
      if (clientWire === "gemini") return handleGeminiModelsList();
      return handleModelsList();
    }
  }

  let bodyText = "";
  try {
    bodyText = await req.text();
  } catch {
    // empty body
  }

  let body: Record<string, unknown> = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      if (clientWire === "anthropic") return makeAnthropicErrorResponse(400, "Invalid JSON body");
      if (clientWire === "gemini") return makeGeminiErrorResponse(400, "Invalid JSON body");
      return makeErrorResponse(400, "Invalid JSON body");
    }
  }

  let requestedModel = typeof body.model === "string" ? body.model : "gpt-4o";
  // Strip gemini prefix if present
  if (requestedModel.startsWith("models/")) {
    requestedModel = requestedModel.replace("models/", "");
  }

  // Translate request to OpenAI upstream wire if needed
  let upstreamBody: Record<string, unknown> = body;
  if (clientWire === "anthropic") {
    upstreamBody = translateAnthropicToOpenAI(body);
  } else if (clientWire === "gemini") {
    upstreamBody = translateGeminiToOpenAI(body);
  }

  // Ensure model is set on upstream body
  upstreamBody.model = requestedModel;

  const providers = selectProviders(requestedModel);
  if (providers.length === 0) {
    if (clientWire === "anthropic") return makeAnthropicErrorResponse(503, "No available providers with budget");
    if (clientWire === "gemini") return makeGeminiErrorResponse(503, "No available providers with budget");
    return makeErrorResponse(503, "No available providers with budget");
  }

  let lastError = "Unknown error";
  for (const provider of providers) {
    const startTime = Date.now();
    try {
      const upstreamRes = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text();
        recordFailure(provider.id);
        lastError = `Provider ${provider.id} error ${upstreamRes.status}: ${errText}`;
        continue;
      }

      recordSuccess(provider.id, Date.now() - startTime);

      // Handle response based on client wire and streaming flag
      const isStreaming = body.stream === true;

      if (clientWire === "openai") {
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: upstreamRes.headers,
        });
      } else if (clientWire === "anthropic") {
        if (isStreaming) {
          // Translate OpenAI SSE to Anthropic SSE
          return translateOpenAIStreamToAnthropicStream(upstreamRes);
        } else {
          const oaiJson = await upstreamRes.json();
          const anthropicJson = translateOpenAIToAnthropicResponse(oaiJson);
          return Response.json(anthropicJson);
        }
      } else if (clientWire === "gemini") {
        if (isStreaming) {
          return new Response(upstreamRes.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        } else {
          const oaiJson = await upstreamRes.json();
          const geminiJson = translateOpenAIToGeminiResponse(oaiJson);
          return Response.json(geminiJson);
        }
      }
    } catch (err) {
      recordFailure(provider.id);
      lastError = `Provider ${provider.id} exception: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (clientWire === "anthropic") return makeAnthropicErrorResponse(502, lastError);
  if (clientWire === "gemini") return makeGeminiErrorResponse(502, lastError);
  return makeErrorResponse(502, lastError);
}

function translateOpenAIStreamToAnthropicStream(upstreamRes: Response): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamRes.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const msgId = "msg_" + Math.random().toString(36).slice(2, 10);
      
      // Send message_start
      controller.enqueue(encoder.encode(`event: message_start
data: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: "claude-3-5-sonnet-20241022", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}

`));
      
      // Send content_block_start
      controller.enqueue(encoder.encode(`event: content_block_start
data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}

`));

      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("
");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            try {
              const chunk = JSON.parse(dataStr);
              const choices = chunk.choices;
              if (Array.isArray(choices) && choices.length > 0) {
                const delta = choices[0].delta;
                if (delta && typeof delta.content === "string" && delta.content) {
                  const ev = {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: delta.content },
                  };
                  controller.enqueue(encoder.encode(`event: content_block_delta
data: ${JSON.stringify(ev)}

`));
                }
              }
            } catch {
              // ignore parse errors on partial chunks
            }
          }
        }
      } catch {
        // stream read error
      }

      // Send content_block_stop
      controller.enqueue(encoder.encode(`event: content_block_stop
data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}

`));
      // Send message_delta
      controller.enqueue(encoder.encode(`event: message_delta
data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } })}

`));
      // Send message_stop
      controller.enqueue(encoder.encode(`event: message_stop
data: ${JSON.stringify({ type: "message_stop" })}

`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// CLI args handling
const args = Deno.args;
if (args.includes("--list")) {
  console.log(JSON.stringify(SERVED_MODELS, null, 2));
  Deno.exit(0);
}
if (args.includes("register")) {
  await registerEntry();
  Deno.exit(0);
}
if (args.includes("poll")) {
  await pollChallenges();
  Deno.exit(0);
}

const portStr = Deno.env.get("PORT") || "8000";
const port = parseInt(portStr, 10);

console.log(`Starting competition entry on port ${port}...`);
serve(
  async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/v1/messages") || path.startsWith("/anthropic/v1/messages")) {
      return handleProxyRequest(req, "anthropic");
    } else if (path.startsWith("/v1/chat/completions") || path.startsWith("/chat/completions")) {
      return handleProxyRequest(req, "openai");
    } else if (path.startsWith("/v1/models") || path.startsWith("/models")) {
      return handleProxyRequest(req, "openai");
    } else if (path.startsWith("/v1beta/models") || path.startsWith("/v1/models")) {
      if (path.includes("gemini")) {
        return handleProxyRequest(req, "gemini");
      }
    }

    // Default route
    if (path.includes("messages")) {
      return handleProxyRequest(req, "anthropic");
    } else {
      return handleProxyRequest(req, "openai");
    }
  },
  { port }
);
