import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { calculateCost, parseStreamingJson, streamSimple } from "@mariozechner/pi-ai";
// Import the class directly from the source module to avoid export type issues
import { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createAnthropicVertexClientIfAvailable } from "../anthropic-vertex-provider.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
// NOTE: We only force `store=true` for *direct* OpenAI Responses.
// Codex responses (chatgpt.com/backend-api/codex/responses) require `store=false`.
const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai"]);

/** Provider name for Anthropic Vertex AI */
const ANTHROPIC_VERTEX_PROVIDER = "anthropic-vertex";

/** Map internal model IDs to Vertex AI API model names when they differ */
const VERTEX_MODEL_ID_MAP: Record<string, string> = {
  "claude-opus-4-6-1m": "claude-opus-4-6",
};

/** Models that require the 1M context beta header */
const VERTEX_1M_CONTEXT_MODELS = new Set(["claude-opus-4-6-1m"]);

/** Beta header value for 1M context window */
const VERTEX_1M_BETA_HEADER = "context-1m-2025-08-07";

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheRetention = "none" | "short" | "long";
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Only applies to Anthropic provider (OpenRouter uses openai-completions API
 * with hardcoded cache_control, not the cacheRetention stream option).
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }
  return undefined;
}

/**
 * Check if a model is using the Anthropic Vertex AI provider.
 */
function isAnthropicVertexModel(model: Model<Api>): boolean {
  const result =
    model.provider === ANTHROPIC_VERTEX_PROVIDER ||
    model.id.startsWith(`${ANTHROPIC_VERTEX_PROVIDER}/`);
  console.error(
    `[VERTEX-DEBUG] isAnthropicVertexModel: provider="${model.provider}" id="${model.id}" result=${result}`,
  );
  return result;
}

/**
 * Map Anthropic stop reason to pi-ai StopReason.
 */
function mapStopReason(
  reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | "pause_turn",
): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn":
      return "stop";
    case "stop_sequence":
      return "stop";
    default: {
      // Exhaustive check - should never reach here if all cases are handled
      throw new Error(`Unhandled stop reason: ${reason as string}`);
    }
  }
}

/**
 * Convert user/assistant messages to Anthropic API format for Vertex.
 */
function convertMessagesForVertex(
  messages: Context["messages"],
  systemPrompt?: string,
): {
  system?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
} {
  const result: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          result.push({ role: "user", content: msg.content });
        }
      } else {
        const blocks = msg.content.map((item) => {
          if (item.type === "text") {
            return { type: "text", text: item.text };
          }
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: item.mimeType,
              data: item.data,
            },
          };
        });
        if (blocks.length > 0) {
          result.push({ role: "user", content: blocks });
        }
      }
    } else if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          if (block.thinking.trim().length === 0) continue;
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({ type: "text", text: block.thinking });
          } else {
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "toolResult") {
      // Collect consecutive tool results into a single user message
      const toolResults: Array<Record<string, unknown>> = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content:
          msg.content.length === 1 && msg.content[0].type === "text"
            ? msg.content[0].text
            : msg.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : c)),
        is_error: msg.isError,
      });

      // Look ahead for more consecutive tool results
      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") {
        const nextMsg = messages[j] as typeof msg;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content:
            nextMsg.content.length === 1 && nextMsg.content[0].type === "text"
              ? nextMsg.content[0].text
              : nextMsg.content.map((c) =>
                  c.type === "text" ? { type: "text", text: c.text } : c,
                ),
          is_error: nextMsg.isError,
        });
        j++;
      }
      i = j - 1;
      result.push({ role: "user", content: toolResults });
    }
  }

  const systemBlocks = systemPrompt
    ? [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  return { system: systemBlocks, messages: result };
}

/**
 * Convert tools to Anthropic API format.
 */
function convertToolsForVertex(
  tools?: Context["tools"],
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  if (!tools) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: (tool.parameters as Record<string, unknown>).properties || {},
      required: (tool.parameters as Record<string, unknown>).required || [],
    },
  }));
}

/**
 * Stream responses from Anthropic Vertex AI using the official SDK.
 *
 * This function creates a pi-ai compatible event stream that uses the
 * @anthropic-ai/vertex-sdk instead of making HTTP requests directly.
 */
function streamAnthropicVertex(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  // Use void to explicitly mark the promise as intentionally unhandled
  // The stream handles errors internally by emitting error events
  void (async () => {
    console.error(
      `[VERTEX-DEBUG] streamAnthropicVertex called: model.id="${model.id}" model.provider="${model.provider}"`,
    );
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const client = createAnthropicVertexClientIfAvailable();
      if (!client) {
        throw new Error(
          "Anthropic Vertex AI credentials not configured. Set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS.",
        );
      }

      const { system, messages } = convertMessagesForVertex(context.messages, context.systemPrompt);
      const tools = convertToolsForVertex(context.tools);

      const params: Record<string, unknown> = {
        model: VERTEX_MODEL_ID_MAP[model.id] ?? model.id,
        messages,
        max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
        stream: true,
      };
      console.error(`[VERTEX-DEBUG] API model name: "${params.model}" (mapped from "${model.id}")`);

      if (system) {
        params.system = system;
      }
      if (options?.temperature !== undefined) {
        params.temperature = options.temperature;
      }
      if (tools.length > 0) {
        params.tools = tools;
      }

      // Handle thinking/reasoning mode
      if (options?.reasoning && model.reasoning) {
        const budgets = options.thinkingBudgets ?? {};
        const defaultBudgets: Record<string, number> = {
          minimal: 512,
          low: 1024,
          medium: 4096,
          high: 16384,
        };
        // ThinkingBudgets only has minimal/low/medium/high, skip xhigh
        const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
        const budgetTokens =
          (budgets as Record<string, number | undefined>)[level] ?? defaultBudgets[level] ?? 1024;
        params.thinking = {
          type: "enabled",
          budget_tokens: budgetTokens,
        };
      }

      // Ensure max_tokens > thinking.budget_tokens (API requirement)
      if (params.thinking) {
        const budgetTokens = (params.thinking as { budget_tokens: number }).budget_tokens;
        const currentMax = params.max_tokens as number;
        if (currentMax <= budgetTokens) {
          params.max_tokens = budgetTokens + Math.max(currentMax, 1024);
        }
      }

      log.debug(`streaming via Vertex SDK for model ${model.id}`);

      // Cast through unknown to avoid strict type checking on the params object
      const streamOptions = VERTEX_1M_CONTEXT_MODELS.has(model.id)
        ? { headers: { "anthropic-beta": VERTEX_1M_BETA_HEADER } }
        : undefined;
      const anthropicStream = client.messages.stream(
        params as unknown as Parameters<typeof client.messages.stream>[0],
        streamOptions as unknown as Parameters<typeof client.messages.stream>[1],
      );

      stream.push({ type: "start", partial: output });

      type ContentBlock =
        | TextContent
        | ThinkingContent
        | (ToolCall & { partialJson?: string; index?: number });
      const blocks = output.content as Array<ContentBlock & { index?: number }>;

      for await (const event of anthropicStream) {
        // Use unknown as intermediate type to avoid strict type checking on SDK event types
        const anyEvent = event as unknown as Record<string, unknown>;

        if (event.type === "message_start") {
          const messageStart = anyEvent as { message?: { usage?: Record<string, number> } };
          const usage = messageStart.message?.usage;
          if (usage) {
            output.usage.input = usage.input_tokens || 0;
            output.usage.output = usage.output_tokens || 0;
            output.usage.cacheRead = usage.cache_read_input_tokens || 0;
            output.usage.cacheWrite = usage.cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        } else if (event.type === "content_block_start") {
          const blockStart = anyEvent as { content_block: Record<string, unknown>; index: number };
          const contentBlock = blockStart.content_block;
          const index = blockStart.index;

          if (contentBlock.type === "text") {
            const block: TextContent & { index?: number } = {
              type: "text",
              text: "",
              index,
            };
            output.content.push(block);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (contentBlock.type === "thinking") {
            const block: ThinkingContent & { index?: number } = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index,
            };
            output.content.push(block);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (contentBlock.type === "tool_use") {
            const block: ToolCall & { partialJson?: string; index?: number } = {
              type: "toolCall",
              id: contentBlock.id as string,
              name: contentBlock.name as string,
              arguments: (contentBlock.input as Record<string, unknown>) || {},
              partialJson: "",
              index,
            };
            output.content.push(block);
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const blockDelta = anyEvent as { delta: Record<string, unknown>; index: number };
          const delta = blockDelta.delta;
          const eventIndex = blockDelta.index;

          if (delta.type === "text_delta") {
            const blockIndex = blocks.findIndex((b) => b.index === eventIndex);
            const block = blocks[blockIndex];
            if (block && block.type === "text") {
              block.text += delta.text as string;
              stream.push({
                type: "text_delta",
                contentIndex: blockIndex,
                delta: delta.text as string,
                partial: output,
              });
            }
          } else if (delta.type === "thinking_delta") {
            const blockIndex = blocks.findIndex((b) => b.index === eventIndex);
            const block = blocks[blockIndex];
            if (block && block.type === "thinking") {
              block.thinking += delta.thinking as string;
              stream.push({
                type: "thinking_delta",
                contentIndex: blockIndex,
                delta: delta.thinking as string,
                partial: output,
              });
            }
          } else if (delta.type === "input_json_delta") {
            const blockIndex = blocks.findIndex((b) => b.index === eventIndex);
            const block = blocks[blockIndex];
            if (block && block.type === "toolCall") {
              block.partialJson = (block.partialJson || "") + (delta.partial_json as string);
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                type: "toolcall_delta",
                contentIndex: blockIndex,
                delta: delta.partial_json as string,
                partial: output,
              });
            }
          } else if (delta.type === "signature_delta") {
            const blockIndex = blocks.findIndex((b) => b.index === eventIndex);
            const block = blocks[blockIndex];
            if (block && block.type === "thinking") {
              block.thinkingSignature =
                (block.thinkingSignature || "") + (delta.signature as string);
            }
          }
        } else if (event.type === "content_block_stop") {
          const blockStop = anyEvent as { index: number };
          const eventIndex = blockStop.index;
          const blockIndex = blocks.findIndex((b) => b.index === eventIndex);
          const block = blocks[blockIndex];
          if (block) {
            delete block.index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: blockIndex,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: blockIndex,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson || "");
              delete block.partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: blockIndex,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (event.type === "message_delta") {
          const messageDelta = anyEvent as {
            delta?: { stop_reason?: string };
            usage?: Record<string, number>;
          };
          const delta = messageDelta.delta;
          const usage = messageDelta.usage;

          if (delta?.stop_reason) {
            output.stopReason = mapStopReason(
              delta.stop_reason as
                | "end_turn"
                | "max_tokens"
                | "stop_sequence"
                | "tool_use"
                | "refusal"
                | "pause_turn",
            );
          }
          if (usage) {
            output.usage.input = usage.input_tokens || 0;
            output.usage.output = usage.output_tokens || 0;
            output.usage.cacheRead = usage.cache_read_input_tokens || 0;
            output.usage.cacheWrite = usage.cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      console.error(
        `[VERTEX-DEBUG] streamAnthropicVertex ERROR:`,
        error instanceof Error ? error.message : error,
      );
      for (const block of output.content as Array<{ index?: number }>) {
        delete block.index;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

/**
 * Create a stream function with extra params and Vertex SDK interception.
 *
 * This wrapper applies extra params (like temperature, maxTokens, cacheControlTtl)
 * and also intercepts anthropic-vertex provider calls to route them through the
 * Vertex SDK instead of letting pi-ai make HTTP requests.
 */
function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    // Still need to wrap for anthropic-vertex interception even without extra params
    if (provider !== ANTHROPIC_VERTEX_PROVIDER) {
      return undefined;
    }
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (extraParams) {
    if (typeof extraParams.temperature === "number") {
      streamParams.temperature = extraParams.temperature;
    }
    if (typeof extraParams.maxTokens === "number") {
      streamParams.maxTokens = extraParams.maxTokens;
    }
    const cacheRetention = resolveCacheRetention(extraParams, provider);
    if (cacheRetention) {
      streamParams.cacheRetention = cacheRetention;
    }
  }

  if (Object.keys(streamParams).length === 0 && provider !== ANTHROPIC_VERTEX_PROVIDER) {
    return undefined;
  }

  if (Object.keys(streamParams).length > 0) {
    log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);
  }

  const underlying = baseStreamFn ?? streamSimple;

  const wrappedStreamFn: StreamFn = (model, context, options) => {
    const typedModel = model as Model<Api>;

    // Check if this is an anthropic-vertex provider request
    if (isAnthropicVertexModel(typedModel)) {
      log.debug(`intercepting anthropic-vertex request for model ${typedModel.id}`);
      return streamAnthropicVertex(typedModel, context, {
        ...streamParams,
        ...options,
      });
    }

    // Fall through to the underlying stream function for other providers
    return underlying(typedModel, context, {
      ...streamParams,
      ...options,
    });
  };

  return wrappedStreamFn;
}

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host === "chatgpt.com";
  } catch {
    const normalized = baseUrl.toLowerCase();
    return normalized.includes("api.openai.com") || normalized.includes("chatgpt.com");
  }
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.api !== "string" || typeof model.provider !== "string") {
    return false;
  }
  if (!OPENAI_RESPONSES_APIS.has(model.api)) {
    return false;
  }
  if (!OPENAI_RESPONSES_PROVIDERS.has(model.provider)) {
    return false;
  }
  return isDirectOpenAIBaseUrl(model.baseUrl);
}

function createOpenAIResponsesStoreWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldForceResponsesStore(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as { store?: unknown }).store = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers.
 * These headers allow OpenClaw to appear on OpenRouter's leaderboard.
 */
function createOpenRouterHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
    });
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * This function also intercepts anthropic-vertex provider calls and routes them
 * through the Vertex SDK instead of letting pi-ai make HTTP requests directly.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider);
  if (wrappedStreamFn) {
    agent.streamFn = wrappedStreamFn;
  }

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);
}
