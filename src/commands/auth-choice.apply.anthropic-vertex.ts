import { checkVertexCredentials } from "../agents/anthropic-vertex-provider.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

const ANTHROPIC_VERTEX_DEFAULT_MODEL = "anthropic-vertex/claude-sonnet-4-5";

export async function applyAuthChoiceAnthropicVertex(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "anthropic-vertex") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;

  // Verify credentials are available via environment variables
  const check = checkVertexCredentials();

  if (!check.available) {
    await params.prompter.note(
      [
        "Anthropic Vertex AI requires environment variables:",
        "  - GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID",
        "  - GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON)",
        "  - GOOGLE_CLOUD_REGION or VERTEX_REGION (optional, defaults to us-east5)",
        "",
        "These should be set in your Docker environment.",
      ].join("\n"),
      "Missing credentials",
    );
    return { config: nextConfig };
  }

  await params.prompter.note(
    [
      `Project: ${check.projectId}`,
      `Region: ${check.region}`,
      "",
      "Using Google Cloud Application Default Credentials.",
    ].join("\n"),
    "Anthropic Vertex AI configured",
  );

  // Register the auth profile for anthropic-vertex
  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "anthropic-vertex:default",
    provider: "anthropic-vertex",
    mode: "api_key", // Uses ADC, but we use api_key mode for config structure
  });

  // Set the default model
  if (params.setDefaultModel) {
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: { primary: ANTHROPIC_VERTEX_DEFAULT_MODEL },
        },
      },
    };
    await params.prompter.note(
      `Default model set to ${ANTHROPIC_VERTEX_DEFAULT_MODEL}`,
      "Model configured",
    );
  } else {
    agentModelOverride = ANTHROPIC_VERTEX_DEFAULT_MODEL;
    if (params.agentId) {
      await params.prompter.note(
        `Default model set to ${ANTHROPIC_VERTEX_DEFAULT_MODEL} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
  }

  return { config: nextConfig, agentModelOverride };
}
