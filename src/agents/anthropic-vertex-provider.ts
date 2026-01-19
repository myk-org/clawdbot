/**
 * Anthropic Vertex AI Provider
 *
 * Integrates Claude models via Google Cloud Vertex AI.
 *
 * This provider uses the @anthropic-ai/vertex-sdk under the hood, which handles
 * authentication via Google Cloud Application Default Credentials (ADC).
 *
 * Environment Variables:
 * - GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID: GCP project ID (required)
 * - GOOGLE_CLOUD_REGION or VERTEX_REGION: GCP region (default: "us-east5")
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account JSON (required for ADC)
 *
 * Vertex AI API Endpoint Format:
 * https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict
 *
 * Usage:
 * ```typescript
 * import { createAnthropicVertexClient } from "./anthropic-vertex-provider.js";
 *
 * const client = createAnthropicVertexClient();
 * const response = await client.messages.create({
 *   model: "claude-sonnet-4-5",
 *   max_tokens: 1024,
 *   messages: [{ role: "user", content: "Hello!" }],
 * });
 * ```
 */

import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";

// Default region for Vertex AI - us-east5 has Claude model availability
const VERTEX_DEFAULT_REGION = "us-east5";

// Vertex AI pricing (per 1M tokens) - matches Anthropic API pricing
// Note: Vertex AI pricing may differ; override in models.json for accurate costs
const VERTEX_CLAUDE_COST = {
  // claude-sonnet-4-5 pricing
  sonnet: {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  // claude-haiku-4-5 pricing
  haiku: {
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1,
  },
  // claude-opus-4-5 pricing
  opus: {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
} as const;

// Claude model specifications for Vertex AI
// Model IDs follow Anthropic's Vertex AI naming convention (no -latest suffix)
const VERTEX_CLAUDE_MODELS: readonly ModelDefinitionConfig[] = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    input: ["text", "image"],
    cost: VERTEX_CLAUDE_COST.sonnet,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    cost: VERTEX_CLAUDE_COST.haiku,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: VERTEX_CLAUDE_COST.opus,
    contextWindow: 200000,
    maxTokens: 32000,
  },
] as const;

/**
 * Vertex AI authentication configuration
 */
export type AnthropicVertexAuth = {
  projectId: string;
  region: string;
  credentialsPath?: string;
  source: string;
};

/**
 * Result from checking Vertex AI credentials availability
 */
export type VertexCredentialsCheck = {
  available: boolean;
  projectId?: string;
  region?: string;
  credentialsPath?: string;
  missingEnvVars?: string[];
};

/**
 * Check if Vertex AI credentials are available in the environment.
 *
 * Required environment variables:
 * - GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID
 * - GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON)
 *
 * Optional:
 * - GOOGLE_CLOUD_REGION or VERTEX_REGION (defaults to us-east5)
 */
export function checkVertexCredentials(
  env: NodeJS.ProcessEnv = process.env,
): VertexCredentialsCheck {
  const projectId = env.GOOGLE_CLOUD_PROJECT ?? env.VERTEX_PROJECT_ID;
  const region = env.GOOGLE_CLOUD_REGION ?? env.VERTEX_REGION ?? VERTEX_DEFAULT_REGION;
  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;

  const missingEnvVars: string[] = [];

  if (!projectId) {
    missingEnvVars.push("GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID");
  }

  if (!credentialsPath) {
    missingEnvVars.push("GOOGLE_APPLICATION_CREDENTIALS");
  }

  if (missingEnvVars.length > 0) {
    return {
      available: false,
      missingEnvVars,
    };
  }

  return {
    available: true,
    projectId: projectId!,
    region,
    credentialsPath,
  };
}

/**
 * Get Anthropic Vertex AI authentication info from environment variables.
 *
 * @throws Error if required credentials are not available
 */
export function getAnthropicVertexAuth(env: NodeJS.ProcessEnv = process.env): AnthropicVertexAuth {
  const check = checkVertexCredentials(env);

  if (!check.available) {
    throw new Error(
      `Anthropic Vertex AI credentials not found. Missing: ${check.missingEnvVars?.join(", ")}.`,
    );
  }

  // Determine source description based on which env vars were used
  const projectSource = env.GOOGLE_CLOUD_PROJECT ? "GOOGLE_CLOUD_PROJECT" : "VERTEX_PROJECT_ID";
  const regionSource = env.GOOGLE_CLOUD_REGION
    ? "GOOGLE_CLOUD_REGION"
    : env.VERTEX_REGION
      ? "VERTEX_REGION"
      : "default";

  return {
    projectId: check.projectId!,
    region: check.region!,
    credentialsPath: check.credentialsPath,
    source: `vertex-ai (project: ${projectSource}, region: ${regionSource})`,
  };
}

/**
 * Build the Vertex AI API base URL for Anthropic models.
 *
 * Vertex AI uses a regional endpoint format:
 * https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/anthropic/models
 */
export function buildVertexBaseUrl(projectId: string, region: string): string {
  return `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models`;
}

/**
 * Build the Anthropic Vertex AI provider configuration.
 *
 * Returns a ModelProviderConfig compatible with the Clawdbot models system.
 * The provider uses the Anthropic Messages API format via Vertex AI.
 *
 * Note: Authentication is handled by @anthropic-ai/vertex-sdk using
 * Google Cloud Application Default Credentials (ADC). The apiKey field
 * is set to a placeholder since Vertex AI uses ADC, not API keys.
 *
 * @param env - Environment variables to read credentials from
 * @returns Provider config or null if credentials are not available
 */
export function buildAnthropicVertexProvider(
  env: NodeJS.ProcessEnv = process.env,
): ModelProviderConfig | null {
  const check = checkVertexCredentials(env);

  if (!check.available) {
    return null;
  }

  const baseUrl = buildVertexBaseUrl(check.projectId!, check.region!);

  return {
    baseUrl,
    // Vertex AI uses ADC, not API keys. We use a placeholder to satisfy
    // the ModelProviderConfig type. The actual auth is handled by the
    // @anthropic-ai/vertex-sdk at runtime.
    apiKey: "vertex-ai-adc",
    // Vertex AI uses the Anthropic Messages API format
    api: "anthropic-messages",
    models: [...VERTEX_CLAUDE_MODELS],
  };
}

/**
 * Get the list of available Claude models for Vertex AI.
 */
export function getVertexClaudeModels(): readonly ModelDefinitionConfig[] {
  return VERTEX_CLAUDE_MODELS;
}

/**
 * Resolve the Vertex AI environment variable configuration.
 *
 * Returns environment variable names and their current values for debugging.
 */
export function resolveVertexEnvConfig(env: NodeJS.ProcessEnv = process.env): {
  projectId: { value?: string; envVar: string };
  region: { value: string; envVar: string };
  credentials: { value?: string; envVar: string };
} {
  const projectEnvVar = env.GOOGLE_CLOUD_PROJECT ? "GOOGLE_CLOUD_PROJECT" : "VERTEX_PROJECT_ID";
  const regionEnvVar = env.GOOGLE_CLOUD_REGION
    ? "GOOGLE_CLOUD_REGION"
    : env.VERTEX_REGION
      ? "VERTEX_REGION"
      : "default";

  return {
    projectId: {
      value: env.GOOGLE_CLOUD_PROJECT ?? env.VERTEX_PROJECT_ID,
      envVar: projectEnvVar,
    },
    region: {
      value: env.GOOGLE_CLOUD_REGION ?? env.VERTEX_REGION ?? VERTEX_DEFAULT_REGION,
      envVar: regionEnvVar,
    },
    credentials: {
      value: env.GOOGLE_APPLICATION_CREDENTIALS,
      envVar: "GOOGLE_APPLICATION_CREDENTIALS",
    },
  };
}

/**
 * Options for creating the Anthropic Vertex client.
 */
export type AnthropicVertexClientOptions = {
  /** GCP project ID. If not provided, uses GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID env var. */
  projectId?: string;
  /** GCP region. If not provided, uses GOOGLE_CLOUD_REGION or VERTEX_REGION env var, defaults to "us-east5". */
  region?: string;
};

/**
 * Create an Anthropic Vertex AI client.
 *
 * This function initializes the @anthropic-ai/vertex-sdk client with proper
 * configuration. Authentication is handled automatically via Google Cloud
 * Application Default Credentials (ADC) - set the GOOGLE_APPLICATION_CREDENTIALS
 * environment variable to point to your service account JSON file.
 *
 * @example
 * ```typescript
 * // Using environment variables (recommended)
 * const client = createAnthropicVertexClient();
 *
 * // Or with explicit options
 * const client = createAnthropicVertexClient({
 *   projectId: "my-gcp-project",
 *   region: "us-east5",
 * });
 *
 * // Make API calls
 * const response = await client.messages.create({
 *   model: "claude-sonnet-4-5",
 *   max_tokens: 1024,
 *   messages: [{ role: "user", content: "Hello!" }],
 * });
 * ```
 *
 * @param options - Optional configuration (projectId, region)
 * @returns Configured AnthropicVertex client instance
 * @throws Error if required credentials (project ID, GOOGLE_APPLICATION_CREDENTIALS) are missing
 */
export function createAnthropicVertexClient(
  options: AnthropicVertexClientOptions = {},
): AnthropicVertex {
  const auth = getAnthropicVertexAuth();

  const projectId = options.projectId ?? auth.projectId;
  const region = options.region ?? auth.region;

  return new AnthropicVertex({
    projectId,
    region,
  });
}

/**
 * Create an Anthropic Vertex AI client if credentials are available.
 *
 * Unlike `createAnthropicVertexClient`, this function returns null instead of
 * throwing if credentials are not configured.
 *
 * @param options - Optional configuration (projectId, region)
 * @returns Configured AnthropicVertex client instance, or null if credentials are missing
 */
export function createAnthropicVertexClientIfAvailable(
  options: AnthropicVertexClientOptions = {},
): AnthropicVertex | null {
  const check = checkVertexCredentials();
  if (!check.available) {
    return null;
  }

  const projectId = options.projectId ?? check.projectId!;
  const region = options.region ?? check.region!;

  return new AnthropicVertex({
    projectId,
    region,
  });
}

// Re-export the SDK type for consumers
export { AnthropicVertex };

// Re-export types for external use
export type { ModelDefinitionConfig, ModelProviderConfig };
