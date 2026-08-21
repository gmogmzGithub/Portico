#!/usr/bin/env node
/**
 * Generate Model Capabilities TypeScript Config
 *
 * Parses model_catalog.yaml and generates a TypeScript module with model
 * capabilities (max tokens, reasoning support, etc.) for the frontend.
 *
 * Run: node src/scripts/generate-model-config.cjs
 */

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

// Support both local development and Docker build contexts
// Docker: script is at /build/src/scripts/, config at /build/model_catalog.yaml, output to /build/src/lib/config/
// Local: script is at src/scripts/, config at model_catalog.yaml, output to src/patches/frontend/src/lib/config/
const isDockerBuild = __dirname.startsWith('/build');

const configuredInputPath = String(process.env.MODEL_CONFIG_INPUT_PATH || '').trim();
const configuredOutputPath = String(process.env.MODEL_CONFIG_OUTPUT_PATH || '').trim();
const checkOnly = process.argv.includes('--check');

const configPath = configuredInputPath
  ? path.resolve(configuredInputPath)
  : isDockerBuild
    ? '/build/model_catalog.yaml'
    : path.join(__dirname, '../../model_catalog.yaml');

const outputPath = configuredOutputPath
  ? path.resolve(configuredOutputPath)
  : isDockerBuild
    ? '/build/src/lib/config/model-capabilities.ts'
    : path.join(__dirname, '../patches/frontend/src/lib/config/model-capabilities.ts');

console.log('Reading model_catalog.yaml...');
const configContent = fs.readFileSync(configPath, 'utf8');
const config = yaml.load(configContent);

const modelCapabilities = {};
const modelPickerAliases = {};
const reasoningEffortOptionSet = new Set();
const reasoningEffortOptionOrder = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const modelPickerProviders = new Set(['anthropic', 'openai', 'google']);
const modelPickerTiers = new Set(['general', 'heavy', 'premium', 'lightweight']);
const guiReasoningEffortCaps = new Map([
  ['gpt-5.6 sol', 'max']
]);
const modelMigrations = config.model_migrations || {};

function normalizeModelPickerAlias(value) {
  return String(value || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function registerModelPickerAlias(value, modelName) {
  const normalized = normalizeModelPickerAlias(value);
  if (!normalized) return;
  const existing = modelPickerAliases[normalized];
  if (existing && existing !== modelName) {
    throw new Error(`model picker alias '${value}' maps to both '${existing}' and '${modelName}'`);
  }
  modelPickerAliases[normalized] = modelName;
}

function applyGuiReasoningEffortCap(modelName, options) {
  if (!Array.isArray(options)) {
    return options;
  }

  const cap = guiReasoningEffortCaps.get(String(modelName || '').trim().toLowerCase());
  const capIndex = reasoningEffortOptionOrder.indexOf(cap);
  if (capIndex < 0) {
    return options;
  }

  return options.filter((option) => {
    const optionIndex = reasoningEffortOptionOrder.indexOf(option);
    return optionIndex >= 0 && optionIndex <= capIndex;
  });
}

/**
 * Determine available reasoning effort options for a model.
 * Returns null for models that don't support the reasoning widget.
 *
 * Prefer explicit values from model_catalog.yaml when present so new model
 * families do not require extra frontend code changes.
 */
function getReasoningEffortOptionsForModel(modelName, modelInfo = {}) {
  if (Array.isArray(modelInfo.reasoning_effort_options) && modelInfo.reasoning_effort_options.length > 0) {
    return applyGuiReasoningEffortCap(modelName, modelInfo.reasoning_effort_options);
  }

  const nameLower = modelName.toLowerCase();

  // Models with no reasoning support (widget hidden)
  // GPT-4.x, Atlas Haiku 3.5 (not 4.5), GPT-5 pro (only supports high, auto-applied by backend)
  // Note: Haiku 4.5+ supports extended thinking, so we check for 3.5 specifically
  if (nameLower.includes('gpt-4') || nameLower.includes('haiku 3.5') || nameLower === 'gpt-5 pro') {
    return null;
  }

  // Haiku 4.5+ supports extended thinking with full options
  if (nameLower.includes('haiku')) {
    return ['low', 'medium', 'high', 'max'];
  }

  // GPT-5.1, GPT-5 mini, GPT-5 nano - only 3 options (no max/xhigh)
  if (nameLower.includes('gpt-5.1') || nameLower.includes('gpt-5 mini') || nameLower.includes('gpt-5 nano')) {
    return ['low', 'medium', 'high'];
  }

  // Legacy GPT-5.2/GPT-5.4, GPT-5.5, and Atlas models - full 4 options
  if (nameLower.includes('gpt-5.2') || nameLower.includes('gpt-5.4') || nameLower.includes('gpt-5.5') || nameLower.includes('atlas') || nameLower.includes('sonnet') || nameLower.includes('opus')) {
    return ['low', 'medium', 'high', 'max'];
  }

  // Default for other reasoning models - 4 options
  return ['low', 'medium', 'high', 'max'];
}

for (const model of config.model_list) {
  const name = model.model_name;
  const info = model.model_info || {};

  // Skip embedding models (no supports_reasoning field)
  if (info.supports_reasoning === undefined) {
    console.log(`  Skipping ${name} (no reasoning support field - likely embedding model)`);
    continue;
  }

  const picker = model.picker;
  if (!picker || typeof picker !== 'object' || Array.isArray(picker)) {
    throw new Error(`selectable model '${name}' is missing picker metadata`);
  }
  const pickerProvider = String(picker.provider || '').trim();
  const pickerTier = String(picker.tier || '').trim();
  if (!modelPickerProviders.has(pickerProvider)) {
    throw new Error(`selectable model '${name}' has invalid picker.provider '${pickerProvider}'`);
  }
  if (!modelPickerTiers.has(pickerTier)) {
    throw new Error(`selectable model '${name}' has invalid picker.tier '${pickerTier}'`);
  }

  const supportsReasoning = info.supports_reasoning || false;
  const reasoningOptions = supportsReasoning ? getReasoningEffortOptionsForModel(name, info) : null;
  const advertisedReasoningOptions = Array.isArray(info.reasoning_effort_options)
    ? info.reasoning_effort_options
    : reasoningOptions;
  if (Array.isArray(advertisedReasoningOptions)) {
    for (const option of advertisedReasoningOptions) {
      reasoningEffortOptionSet.add(option);
    }
  }

  modelCapabilities[name] = {
    maxTokens: info.max_tokens || 128000,
    maxOutputTokens: info.max_output_tokens || info.max_tokens || 128000,
    supportsReasoning: supportsReasoning,
    supportsFunctionCalling: info.supports_function_calling || false,
    reasoningEffortOptions: reasoningOptions,
    pickerProvider,
    pickerTier
  };

  const rawProviderModel = model.litellm_params?.model;
  for (const alias of [name, info.base_model, rawProviderModel]) {
    registerModelPickerAlias(alias, name);
    const normalized = normalizeModelPickerAlias(alias);
    if (normalized.includes('/')) {
      registerModelPickerAlias(normalized.split('/').filter(Boolean).at(-1), name);
    }
  }

  const optionsStr = reasoningOptions ? reasoningOptions.join(',') : 'none';
  console.log(`  ${name}: maxTokens=${modelCapabilities[name].maxTokens}, reasoning=${supportsReasoning}, options=[${optionsStr}]`);
}

const reasoningEffortOptionValues = [
  ...reasoningEffortOptionOrder.filter((option) => reasoningEffortOptionSet.has(option)),
  ...Array.from(reasoningEffortOptionSet)
    .filter((option) => !reasoningEffortOptionOrder.includes(option))
    .sort()
];
const reasoningEffortOptionUnion =
  reasoningEffortOptionValues.map((option) => `'${option}'`).join(' | ') || 'never';

for (const [source, target] of Object.entries(modelMigrations)) {
  if (typeof source !== 'string' || source.trim().length === 0 || typeof target !== 'string' || target.trim().length === 0) {
    throw new Error('model_migrations keys and values must be non-empty strings');
  }
  if (!(target in modelCapabilities)) {
    throw new Error(`model migration target is not in model_list: ${source} -> ${target}`);
  }
  if (source in modelCapabilities) {
    throw new Error(`retired model migration source is still active in model_list: ${source}`);
  }
  registerModelPickerAlias(source, target);
}

const output = `// Auto-generated from model_catalog.yaml - DO NOT EDIT MANUALLY
// Generated at build time by src/scripts/generate-model-config.cjs
// Run: node src/scripts/generate-model-config.cjs

export type ReasoningEffortOption = ${reasoningEffortOptionUnion};
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

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = ${JSON.stringify(modelCapabilities, null, 2)};

export const MODEL_MIGRATIONS: Readonly<Record<string, string>> = ${JSON.stringify(modelMigrations, null, 2)};

export const MODEL_PICKER_ALIASES: Readonly<Record<string, string>> = ${JSON.stringify(modelPickerAliases, null, 2)};

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
`;

if (checkOnly) {
  let existingOutput = null;
  try {
    existingOutput = fs.readFileSync(outputPath, 'utf8');
  } catch (_error) {
    // Report the missing output using the same drift failure below.
  }
  if (existingOutput !== output) {
    console.error(`\nGenerated model config is out of date: ${outputPath}`);
    console.error('Run: node src/scripts/generate-model-config.cjs');
    process.exitCode = 1;
  } else {
    console.log(`\nGenerated model config is current: ${outputPath}`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log(`\nGenerated ${outputPath}`);
}
console.log(`Total models with capabilities: ${Object.keys(modelCapabilities).length}`);
