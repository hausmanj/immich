import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AssistantChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']).describe('Message author'),
    content: z.string().trim().min(1).max(8000).describe('Message content'),
  })
  .meta({ id: 'AssistantChatMessageDto' });

const AssistantChatRequestSchema = z
  .object({
    provider: z.enum(['openai', 'anthropic', 'claude-cli', 'codex-cli']).optional().describe('Assistant provider'),
    messages: z.array(AssistantChatMessageSchema).min(1).max(20).describe('Conversation messages'),
  })
  .meta({ id: 'AssistantChatRequestDto' });

const AssistantActionSchema = z
  .object({
    type: z.enum(['search', 'album_plan', 'folder_plan', 'metadata_audit', 'original_file_audit', 'review']),
    title: z.string(),
    rationale: z.string(),
    query: z.string().nullable(),
    albumName: z.string().nullable(),
    assetIds: z.array(z.uuidv4()),
    confidence: z.number().min(0).max(1),
  })
  .meta({ id: 'AssistantActionDto' });

const AssistantChatResponseSchema = z
  .object({
    status: z.enum(['success', 'disabled', 'error']),
    provider: z.enum(['openai', 'anthropic', 'claude-cli', 'codex-cli', 'local-cli']).optional(),
    model: z.string().optional(),
    answer: z.string(),
    actions: z.array(AssistantActionSchema),
    error: z.string().optional(),
    context: z.object({
      albums: z.number(),
      sampledAssets: z.number(),
      unorganizedAssets: z.number(),
    }),
  })
  .meta({ id: 'AssistantChatResponseDto' });

export class AssistantChatRequestDto extends createZodDto(AssistantChatRequestSchema) {}
export class AssistantChatResponseDto extends createZodDto(AssistantChatResponseSchema) {}

const AssistantAssessmentBucketSchema = z
  .object({
    label: z.string(),
    count: z.number(),
  })
  .meta({ id: 'AssistantAssessmentBucketDto' });

const AssistantAssessmentFindingSchema = z
  .object({
    type: z.enum(['album_plan', 'folder_plan', 'metadata_audit', 'original_file_audit', 'review']),
    title: z.string(),
    detail: z.string(),
    assetCount: z.number().nullable(),
    query: z.string().nullable(),
  })
  .meta({ id: 'AssistantAssessmentFindingDto' });

const AssistantAssessmentResponseSchema = z
  .object({
    generatedAt: z.string(),
    summary: z.object({
      totalAssets: z.number(),
      imageAssets: z.number(),
      videoAssets: z.number(),
      audioAssets: z.number(),
      otherAssets: z.number(),
      albums: z.number(),
      unorganizedAssets: z.number(),
      favoriteAssets: z.number(),
      archivedAssets: z.number(),
    }),
    topYears: z.array(AssistantAssessmentBucketSchema),
    cameraMakes: z.array(z.string()),
    cameraModels: z.array(z.string()),
    countries: z.array(z.string()),
    cities: z.array(z.string()),
    findings: z.array(AssistantAssessmentFindingSchema),
  })
  .meta({ id: 'AssistantAssessmentResponseDto' });

export class AssistantAssessmentResponseDto extends createZodDto(AssistantAssessmentResponseSchema) {}
