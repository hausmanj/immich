import { wrapper } from '@immich/plugin-sdk';
import type { Manifest } from '../dist/index.d.ts';

type AssetDescriptionOutput = {
  description?: unknown;
  tags?: unknown;
  confidence?: unknown;
};

const descriptionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: {
      type: 'string',
      description: 'A concise, factual, one-sentence asset description.',
    },
    tags: {
      type: 'array',
      description: 'Short organizational tag suggestions.',
      items: { type: 'string' },
    },
    confidence: {
      type: 'number',
      description: 'Confidence score from 0 to 1.',
      minimum: 0,
      maximum: 1,
    },
  },
  required: ['description', 'tags', 'confidence'],
};

const renderPrompt = (
  template: string | undefined,
  metadata: Record<string, unknown>,
) => {
  const fallback =
    'Describe this personal photo or video frame in one natural sentence. Return JSON with description, tags, and confidence. Avoid identifying unknown people. Use concrete visible details only. Metadata: {{metadata}}';
  return (template || fallback).replace(
    '{{metadata}}',
    JSON.stringify(metadata),
  );
};

const toDescription = (output: unknown) => {
  if (!output || typeof output !== 'object') {
    return;
  }

  const description = (output as AssetDescriptionOutput).description;
  if (typeof description !== 'string') {
    return;
  }

  const normalized = description.trim();
  return normalized || undefined;
};

const methods = wrapper<Manifest>({
  assetSuggestDescription: ({ config, data, functions }) => {
    const currentDescription = data.asset.exifInfo?.description?.trim();
    if (config.onlyIfEmptyDescription !== false && currentDescription) {
      const auditData = {
        status: 'skipped-existing-description',
        assetId: data.asset.id,
        originalFileName: data.asset.originalFileName,
        isEdited: data.asset.isEdited,
      };
      functions.writeWorkflowAuditLog({
        message: 'LLM description suggestion skipped',
        data: auditData,
      });
      return {
        data: {
          llm: auditData,
        },
      };
    }

    const metadata = {
      id: data.asset.id,
      type: data.asset.type,
      originalFileName: data.asset.originalFileName,
      localDateTime: data.asset.localDateTime,
      isEdited: data.asset.isEdited,
      exifInfo: data.asset.exifInfo,
    };
    const result = functions.analyzeAssetWithLlm({
      assetId: data.asset.id,
      provider:
        config.provider === 'openai' || config.provider === 'anthropic'
          ? config.provider
          : undefined,
      model: config.model,
      prompt: renderPrompt(config.prompt, metadata),
      schema: descriptionSchema,
      variant:
        config.variant === 'thumbnail' || config.variant === 'preview'
          ? config.variant
          : undefined,
      maxBytes: config.maxBytes,
      maxOutputTokens: config.maxOutputTokens,
    });

    if (result.status !== 'success') {
      const auditData = {
        ...result,
        assetId: data.asset.id,
        originalFileName: data.asset.originalFileName,
        isEdited: data.asset.isEdited,
      };
      functions.writeWorkflowAuditLog({
        message: 'LLM description suggestion unavailable',
        data: auditData,
      });
      return {
        data: {
          llm: auditData,
        },
      };
    }

    const description = toDescription(result.output);
    const llmData = {
      ...result,
      assetId: data.asset.id,
      originalFileName: data.asset.originalFileName,
      isEdited: data.asset.isEdited,
      description,
      dryRun: config.dryRun !== false,
    };
    functions.writeWorkflowAuditLog({
      message: 'LLM description suggestion completed',
      data: llmData,
    });

    if (config.dryRun !== false || !description) {
      return { data: { llm: llmData } };
    }

    return {
      changes: {
        asset: {
          exifInfo: {
            description,
          },
        },
      },
      data: {
        llm: llmData,
      },
    };
  },
});

const { assetSuggestDescription, ...rest } = methods;

export { assetSuggestDescription };

'All methods must be destructured and exported' satisfies string & typeof rest;
