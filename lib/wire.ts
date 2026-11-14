// The client wires and the one upstream wire this baseline speaks.

import { isRecord, type Json } from "./providers.ts";

export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

export const SERVED_MODELS: ServedModel[] = [
  { id: "gpt-4o", provider: "openai", display_name: "GPT-4o" },
  { id: "gpt-4o-mini", provider: "openai", display_name: "GPT-4o-mini" },
  { id: "claude-3-5-sonnet-20241022", provider: "anthropic", display_name: "Claude 3.5 Sonnet" },
  { id: "claude-3-5-haiku-20241022", provider: "anthropic", display_name: "Claude 3.5 Haiku" },
  { id: "gemini-1.5-pro", provider: "gemini", display_name: "Gemini 1.5 Pro" },
  { id: "gemini-1.5-flash", provider: "gemini", display_name: "Gemini 1.5 Flash" },
];

export function handleModelsList(): Response {
  const data = SERVED_MODELS.map((m) => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: m.provider,
  }));
  return Response.json({ object: "list", data });
}

export function handleAnthropicModelsList(): Response {
  const data = SERVED_MODELS.filter((m) => m.provider === "anthropic").map((m) => ({
    type: "model",
    id: m.id,
    display_name: m.display_name,
    created_at: "2024-10-22T00:00:00Z",
  }));
  return Response.json({ data, has_more: false, first_id: null, last_id: null });
}

export function handleGeminiModelsList(): Response {
  const models = SERVED_MODELS.filter((m) => m.provider === "gemini").map((m) => ({
    name: `models/${m.id}`,
    version: "1.0",
    displayName: m.display_name,
    inputTokenLimit: 1048576,
    outputTokenLimit: 8192,
  }));
  return Response.json({ models });
}

export function makeErrorResponse(status: number, message: string, type = "invalid_request_error", param: string | null = null): Response {
  return Response.json(
    {
      error: {
        message,
        type,
        param,
        code: status,
      },
    },
    { status }
  );
}

export function makeAnthropicErrorResponse(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json(
    {
      type: "error",
      error: {
        type,
        message,
      },
    },
    { status }
  );
}

export function makeGeminiErrorResponse(status: number, message: string): Response {
  return Response.json(
    {
      error: {
        code: status,
        message,
        status: status === 400 ? "INVALID_ARGUMENT" : status === 404 ? "NOT_FOUND" : "INTERNAL",
      },
    },
    { status }
  );
}

// --- Request / Response / Stream Translators ---

export function translateAnthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body.model === "string") {
    out.model = body.model;
  }
  if (typeof body.max_tokens === "number") {
    out.max_tokens = body.max_tokens;
  }
  if (typeof body.temperature === "number") {
    out.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") {
    out.top_p = body.top_p;
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  // System prompt
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.system === "string") {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const sysText = body.system
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("\n");
    if (sysText) {
      messages.push({ role: "system", content: sysText });
    }
  }

  // Messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isRecord(msg)) continue;
      const role = msg.role;
      const content = msg.content;

      if (typeof content === "string") {
        messages.push({ role, content });
      } else if (Array.isArray(content)) {
        let textParts = "";
        const toolCalls: Array<Record<string, unknown>> = [];
        const toolResults: Array<Record<string, unknown>> = [];

        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts += block.text;
          } else if (block.type === "image" && isRecord(block.source)) {
            const src = block.source;
            if (src.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string") {
              // OpenAI image_url format
              const imageUrl = {
                url: `data:${src.media_type};base64,${src.data}`,
              };
              // If textParts has content or we need to structure as array of parts
              // For simplicity, if there is an image, OpenAI expects content as an array of parts
            }
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          } else if (block.type === "tool_result") {
            const toolResContent = typeof block.content === "string" 
              ? block.content 
              : Array.isArray(block.content) 
                ? block.content.map(c => isRecord(c) && typeof c.text === "string" ? c.text : "").join("\n")
                : JSON.stringify(block.content ?? "");
            messages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: toolResContent,
            });
          }
        }

        if (toolCalls.length > 0) {
          messages.push({
            role: role === "assistant" ? "assistant" : "user",
            content: textParts || null,
            tool_calls: toolCalls,
          });
        } else if (textParts || role === "user" || role === "assistant") {
          messages.push({ role, content: textParts });
        }
      }
    }
  }
  out.messages = messages;

  // Tools
  if (Array.isArray(body.tools)) {
    const openaiTools = body.tools.map((t) => {
      if (!isRecord(t)) return null;
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      };
    }).filter(Boolean);
    if (openaiTools.length > 0) {
      out.tools = openaiTools;
    }
  }

  // Tool choice
  if (isRecord(body.tool_choice)) {
    if (body.tool_choice.type === "auto") {
      out.tool_choice = "auto";
    } else if (body.tool_choice.type === "any") {
      out.tool_choice = "required";
    } else if (body.tool_choice.type === "tool" && typeof body.tool_choice.name === "string") {
      out.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }

  return out;
}

export function translateGeminiToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      if (!isRecord(c)) continue;
      const role = c.role === "model" ? "assistant" : "user";
      let text = "";
      if (Array.isArray(c.parts)) {
        for (const p of c.parts) {
          if (isRecord(p) && typeof p.text === "string") {
            text += p.text;
          }
        }
      }
      messages.push({ role, content: text });
    }
  }
  const out: Record<string, unknown> = {
    model: "gpt-4o",
    messages,
  };
  if (isRecord(body.generationConfig)) {
    if (typeof body.generationConfig.maxOutputTokens === "number") {
      out.max_tokens = body.generationConfig.maxOutputTokens;
    }
    if (typeof body.generationConfig.temperature === "number") {
      out.temperature = body.generationConfig.temperature;
    }
  }
  return out;
}

export function translateOpenAIToAnthropicResponse(oai: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(oai.choices) ? oai.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const contentBlocks: Array<Record<string, unknown>> = [];

  const textContent = typeof message.content === "string" ? message.content : "";
  if (textContent) {
    contentBlocks.push({ type: "text", text: textContent });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!isRecord(tc)) continue;
      const fn = isRecord(tc.function) ? tc.function : {};
      let argsObj: unknown = {};
      try {
        argsObj = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}");
      } catch {
        argsObj = {};
      }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id ?? "call_123",
        name: fn.name ?? "unknown",
        input: argsObj,
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "" });
  }

  let stopReason = "end_turn";
  if (choice.finish_reason === "stop") stopReason = "end_turn";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "tool_calls") stopReason = "tool_use";

  const usage = isRecord(oai.usage) ? oai.usage : {};
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 10;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 10;

  return {
    id: oai.id ?? "msg_123",
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: oai.model ?? "claude-3-5-sonnet-20241022",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

export function translateOpenAIToGeminiResponse(oai: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(oai.choices) ? oai.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === "string" ? message.content : "";

  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
          role: "model",
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 10,
      totalTokenCount: 20,
    },
  };
}
