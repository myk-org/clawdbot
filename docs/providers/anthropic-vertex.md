---
summary: "Use Anthropic Claude models via Google Cloud Vertex AI in OpenClaw"
read_when:
  - You want to run Claude models through Google Cloud Vertex AI
  - You need GCP-managed billing and access control for Claude
title: "Anthropic Vertex AI"
---

# Anthropic Vertex AI

OpenClaw can run **Anthropic Claude** models through **Google Cloud Vertex AI**
instead of the direct Anthropic API. This is useful for organizations that manage
access, billing, and compliance through GCP projects and service accounts.

## Prerequisites

- A GCP project with the **Vertex AI API** enabled
- Claude models enabled in the **Vertex AI Model Garden**
- **Google Application Default Credentials (ADC)** configured (service account JSON)

## CLI setup

```bash
openclaw onboard
# choose: Anthropic Vertex AI
```

The wizard checks that the required environment variables are set and displays
your project ID and region.

## Environment variables

Set these on the **gateway host** (or in your Docker environment):

| Variable                         | Required | Default    | Description                           |
| -------------------------------- | -------- | ---------- | ------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Yes\*    | --         | GCP project ID                        |
| `VERTEX_PROJECT_ID`              | Yes\*    | --         | GCP project ID (alternative)          |
| `GOOGLE_CLOUD_REGION`            | No       | `us-east5` | Vertex AI region                      |
| `VERTEX_REGION`                  | No       | `us-east5` | Vertex AI region (alternative)        |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes      | --         | Path to service account JSON key file |

\*Provide **one of** `GOOGLE_CLOUD_PROJECT` or `VERTEX_PROJECT_ID`.

```bash
export GOOGLE_CLOUD_PROJECT="my-gcp-project"
export GOOGLE_CLOUD_REGION="us-east5"
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

## Config snippet

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic-vertex/claude-opus-4-6" },
    },
  },
}
```

No `apiKey` is needed in the config -- authentication is handled automatically
via Google Cloud ADC.

## Available models

| Model ID             | Name               | Context | Max output | Reasoning |
| -------------------- | ------------------ | ------- | ---------- | --------- |
| `claude-sonnet-4-5`  | Claude Sonnet 4.5  | 200k    | 8,192      | No        |
| `claude-haiku-4-5`   | Claude Haiku 4.5   | 200k    | 8,192      | No        |
| `claude-opus-4-5`    | Claude Opus 4.5    | 200k    | 32,000     | Yes       |
| `claude-opus-4-6`    | Claude Opus 4.6    | 200k    | 32,000     | Yes       |
| `claude-opus-4-6-1m` | Claude Opus 4.6 1M | 1M      | 32,000     | Yes       |

Model refs use `anthropic-vertex/<model>`, for example
`anthropic-vertex/claude-opus-4-6`.

The default model is **`anthropic-vertex/claude-opus-4-6`**.

## Authentication flow

The provider uses the `@anthropic-ai/vertex-sdk`, which authenticates via
Google Cloud Application Default Credentials (ADC):

1. Set `GOOGLE_APPLICATION_CREDENTIALS` to the path of your service account JSON
   key file.
2. The SDK reads the key file and automatically obtains and refreshes OAuth2
   access tokens.
3. Requests are sent to `{region}-aiplatform.googleapis.com`.

No Anthropic API key (`ANTHROPIC_API_KEY`) is needed.

## Differences from the direct Anthropic API

| Aspect         | Direct Anthropic API | Vertex AI                              |
| -------------- | -------------------- | -------------------------------------- |
| Authentication | `ANTHROPIC_API_KEY`  | GCP service account (ADC)              |
| Billing        | Anthropic Console    | GCP project billing                    |
| Endpoint       | `api.anthropic.com`  | `{region}-aiplatform.googleapis.com`   |
| 1M context     | Available            | Available (`claude-opus-4-6-1m`)       |
| Prompt caching | Supported            | Behavior may differ from Anthropic API |

## Notes

- Model access must be enabled in the **Vertex AI Model Garden** for your GCP
  project and region before models can be used.
- The `us-east5` region has Claude model availability by default. If you use a
  different region, confirm that Claude models are available there.
- All models accept `text` and `image` inputs.
- Pricing follows Anthropic rates; override in your config if your GCP contract
  differs.

## Troubleshooting

**Missing credentials error**

If you see `Anthropic Vertex AI credentials not found`, verify that the required
environment variables are set:

```bash
echo $GOOGLE_CLOUD_PROJECT
echo $GOOGLE_APPLICATION_CREDENTIALS
```

Both must be non-empty. The credentials file must exist at the given path.

**Region errors or model not found**

- Confirm your region has Claude models enabled in the Model Garden.
- Try setting `GOOGLE_CLOUD_REGION=us-east5` (the default region with
  availability).

**Permission denied (403)**

- Ensure the service account has the `Vertex AI User` role
  (`roles/aiplatform.user`) or equivalent permissions on the project.
- Verify the Vertex AI API is enabled: `gcloud services list --enabled | grep aiplatform`.

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).
