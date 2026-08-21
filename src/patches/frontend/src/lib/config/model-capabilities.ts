// Auto-generated from model_catalog.yaml - DO NOT EDIT MANUALLY
// Generated at build time by src/scripts/generate-model-config.cjs
// Run: node src/scripts/generate-model-config.cjs

export type ReasoningEffortOption = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ModelPickerProvider = 'anthropic' | 'openai' | 'google';
export type ModelPickerTier = 'general' | 'heavy' | 'premium' | 'lightweight';

export interface ModelCapability {
  maxTokens: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  supportsFunctionCalling: boolean;
  // Available reasoning effort options for this model
  // null means widget should be hidden (no reasoning or single forced option)
  reasoningEffortOptions: ReasoningEffortOption[] | null;
  pickerProvider: ModelPickerProvider;
  pickerTier: ModelPickerTier;
}

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  "Atlas Sonnet 5": {
    "maxTokens": 1000000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "anthropic",
    "pickerTier": "general"
  },
  "Atlas Sonnet 4.6": {
    "maxTokens": 1000000,
    "maxOutputTokens": 64000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high",
      "max"
    ],
    "pickerProvider": "anthropic",
    "pickerTier": "general"
  },
  "Atlas Opus 5": {
    "maxTokens": 1000000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "anthropic",
    "pickerTier": "heavy"
  },
  "Atlas Opus 4.8": {
    "maxTokens": 1000000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "anthropic",
    "pickerTier": "heavy"
  },
  "Atlas Haiku 4.5": {
    "maxTokens": 200000,
    "maxOutputTokens": 64000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high",
      "max"
    ],
    "pickerProvider": "anthropic",
    "pickerTier": "lightweight"
  },
  "GPT-5.6 Sol": {
    "maxTokens": 1050000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "openai",
    "pickerTier": "heavy"
  },
  "GPT-5.6 Sol Pro": {
    "maxTokens": 1050000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "openai",
    "pickerTier": "premium"
  },
  "GPT-5.6 Terra": {
    "maxTokens": 1050000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "openai",
    "pickerTier": "general"
  },
  "GPT-5.6 Luna": {
    "maxTokens": 1050000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pickerProvider": "openai",
    "pickerTier": "lightweight"
  },
  "GPT-5.5": {
    "maxTokens": 1050000,
    "maxOutputTokens": 128000,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high",
      "max"
    ],
    "pickerProvider": "openai",
    "pickerTier": "heavy"
  },
  "Gemini 3.6 Flash": {
    "maxTokens": 1048576,
    "maxOutputTokens": 65536,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high"
    ],
    "pickerProvider": "google",
    "pickerTier": "general"
  },
  "Gemini 3.5 Flash": {
    "maxTokens": 1048576,
    "maxOutputTokens": 65536,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high"
    ],
    "pickerProvider": "google",
    "pickerTier": "general"
  },
  "Gemini 3.1 Pro Preview": {
    "maxTokens": 1048576,
    "maxOutputTokens": 65536,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high"
    ],
    "pickerProvider": "google",
    "pickerTier": "premium"
  },
  "Gemini 3.5 Flash-Lite": {
    "maxTokens": 1048576,
    "maxOutputTokens": 65536,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high"
    ],
    "pickerProvider": "google",
    "pickerTier": "lightweight"
  },
  "Gemini 3.1 Flash-Lite": {
    "maxTokens": 1048576,
    "maxOutputTokens": 65536,
    "supportsReasoning": true,
    "supportsFunctionCalling": true,
    "reasoningEffortOptions": [
      "low",
      "medium",
      "high"
    ],
    "pickerProvider": "google",
    "pickerTier": "lightweight"
  }
};

export const MODEL_MIGRATIONS: Readonly<Record<string, string>> = {
  "Atlas Opus 4.6": "Atlas Opus 5",
  "Atlas Opus 4.7": "Atlas Opus 5",
  "GPT-5.4": "GPT-5.6 Sol",
  "GPT-5.4 pro": "GPT-5.6 Sol Pro",
  "GPT-4.1": "GPT-5.6 Sol",
  "GPT-4.1 mini": "GPT-5.6 Terra",
  "GPT-4.1 nano": "GPT-5.6 Luna"
};

export const MODEL_PICKER_ALIASES: Readonly<Record<string, string>> = {
  "atlas sonnet 5": "Atlas Sonnet 5",
  "us.anthropic.atlas-sonnet-5": "Atlas Sonnet 5",
  "bedrock/converse_like/us.anthropic.atlas-sonnet-5": "Atlas Sonnet 5",
  "atlas sonnet 4.6": "Atlas Sonnet 4.6",
  "us.anthropic.atlas-sonnet-4-6": "Atlas Sonnet 4.6",
  "bedrock/converse_like/us.anthropic.atlas-sonnet-4-6": "Atlas Sonnet 4.6",
  "atlas opus 5": "Atlas Opus 5",
  "us.anthropic.atlas-opus-5": "Atlas Opus 5",
  "bedrock/converse_like/us.anthropic.atlas-opus-5": "Atlas Opus 5",
  "atlas opus 4.8": "Atlas Opus 4.8",
  "us.anthropic.atlas-opus-4-8": "Atlas Opus 4.8",
  "bedrock/converse_like/us.anthropic.atlas-opus-4-8": "Atlas Opus 4.8",
  "atlas haiku 4.5": "Atlas Haiku 4.5",
  "us.anthropic.atlas-haiku-4-5-20251001-v1:0": "Atlas Haiku 4.5",
  "bedrock/converse_like/us.anthropic.atlas-haiku-4-5-20251001-v1:0": "Atlas Haiku 4.5",
  "gpt-5.6 sol": "GPT-5.6 Sol",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "openai/responses/gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6 sol pro": "GPT-5.6 Sol Pro",
  "gpt-5.6-sol-pro": "GPT-5.6 Sol Pro",
  "openai/responses/gpt-5.6-sol-pro": "GPT-5.6 Sol Pro",
  "gpt-5.6 terra": "GPT-5.6 Terra",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "openai/responses/gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6 luna": "GPT-5.6 Luna",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "openai/responses/gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "openai/responses/gpt-5.5": "GPT-5.5",
  "gemini 3.6 flash": "Gemini 3.6 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini/vertex/gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini 3.5 flash": "Gemini 3.5 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini/vertex/gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini 3.1 pro preview": "Gemini 3.1 Pro Preview",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  "gemini/vertex/gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  "gemini 3.5 flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini/vertex/gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini 3.1 flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini/vertex/gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "atlas opus 4.6": "Atlas Opus 5",
  "atlas opus 4.7": "Atlas Opus 5",
  "gpt-5.4": "GPT-5.6 Sol",
  "gpt-5.4 pro": "GPT-5.6 Sol Pro",
  "gpt-4.1": "GPT-5.6 Sol",
  "gpt-4.1 mini": "GPT-5.6 Terra",
  "gpt-4.1 nano": "GPT-5.6 Luna"
};

const NORMALIZED_MODEL_MIGRATIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MODEL_MIGRATIONS).map(([source, target]) => [source.toLowerCase(), target])
);

/**
 * Resolve a retired picker id to its active replacement without mutating
 * historical chat metadata. Retired :latest aliases resolve to the
 * unversioned selectable target, matching startup migrations.
 */
export function resolveMigratedModelId(modelId: unknown): string | null {
  if (typeof modelId !== 'string') {
    return null;
  }

  const normalized = modelId.trim();
  if (!normalized) {
    return null;
  }

  const latestSuffix = ':latest';
  const baseId = normalized.toLowerCase().endsWith(latestSuffix)
    ? normalized.slice(0, -latestSuffix.length)
    : normalized;
  const replacement = NORMALIZED_MODEL_MIGRATIONS[baseId.toLowerCase()];
  return replacement ?? normalized;
}

export function resolveModelPickerMetadata(
  ...values: unknown[]
): Pick<ModelCapability, 'pickerProvider' | 'pickerTier'> | null {
  for (const value of values) {
    const normalized = String(value ?? '').trim().replace(/:latest$/i, '').toLowerCase();
    if (!normalized) continue;
    const candidates = [normalized, normalized.split('/').filter(Boolean).at(-1) ?? ''];
    for (const candidate of candidates) {
      const modelName = MODEL_PICKER_ALIASES[candidate];
      const capability = modelName ? MODEL_CAPABILITIES[modelName] : undefined;
      if (capability) {
        return {
          pickerProvider: capability.pickerProvider,
          pickerTier: capability.pickerTier
        };
      }
    }
  }
  return null;
}

/**
 * Get all capabilities for a model by name
 */
export function getModelCapability(modelName: string): ModelCapability | undefined {
  return MODEL_CAPABILITIES[modelName];
}

/**
 * Check if a model supports reasoning (extended thinking)
 */
export function supportsReasoning(modelName: string): boolean {
  return MODEL_CAPABILITIES[modelName]?.supportsReasoning ?? false;
}

/**
 * Get the maximum context window tokens for a model
 */
export function getMaxTokens(modelName: string): number {
  return MODEL_CAPABILITIES[modelName]?.maxTokens ?? 128000;
}

/**
 * Get the maximum output tokens for a model
 */
export function getMaxOutputTokens(modelName: string): number {
  return MODEL_CAPABILITIES[modelName]?.maxOutputTokens ?? 128000;
}

/**
 * Check if a model supports function calling
 */
export function supportsFunctionCalling(modelName: string): boolean {
  return MODEL_CAPABILITIES[modelName]?.supportsFunctionCalling ?? false;
}

/**
 * Get available reasoning effort options for a model
 * Returns null if the reasoning widget should be hidden for this model
 */
export function getReasoningEffortOptions(modelName: string): ReasoningEffortOption[] | null {
  return MODEL_CAPABILITIES[modelName]?.reasoningEffortOptions ?? null;
}
