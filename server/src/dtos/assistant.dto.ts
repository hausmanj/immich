import { createZodDto } from 'nestjs-zod';
import { isoDatetimeToDate } from 'src/validation';
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

const AssistantCohortTypeSchema = z.enum(['source_path', 'date', 'camera', 'location']);

const AssistantToolTypeSchema = z.enum([
  'content_hash_audit',
  'sidecar_pair_audit',
  'metadata_search',
  'mobile_original_compare',
]);

const AssistantToolInputSchema = z
  .object({
    cohortType: AssistantCohortTypeSchema.nullable().optional(),
    cohortKey: z.string().nullable().optional(),
    originalPathContains: z.string().trim().min(1).max(500).nullable().optional(),
    originalFileNameContains: z.string().trim().min(1).max(250).nullable().optional(),
    fileExtension: z.string().trim().min(1).max(20).nullable().optional(),
    checksumAlgorithm: z.string().trim().min(1).max(50).nullable().optional(),
    type: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'OTHER']).nullable().optional(),
    takenAfter: isoDatetimeToDate.nullable().optional(),
    takenBefore: isoDatetimeToDate.nullable().optional(),
    make: z.string().trim().min(1).max(250).nullable().optional(),
    model: z.string().trim().min(1).max(250).nullable().optional(),
    country: z.string().trim().min(1).max(250).nullable().optional(),
    state: z.string().trim().min(1).max(250).nullable().optional(),
    city: z.string().trim().min(1).max(250).nullable().optional(),
    noGps: z.boolean().nullable().optional(),
    unknownCamera: z.boolean().nullable().optional(),
    hasMobileMetadata: z.boolean().nullable().optional(),
    desktopSourcePrefix: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .meta({ id: 'AssistantToolInputDto' });

const AssistantActionSchema = z
  .object({
    type: z.enum(['search', 'album_plan', 'folder_plan', 'metadata_audit', 'original_file_audit', 'review']),
    title: z.string(),
    rationale: z.string(),
    query: z.string().nullable(),
    albumName: z.string().nullable(),
    assetIds: z.array(z.uuidv4()),
    cohortType: AssistantCohortTypeSchema.nullable().optional(),
    cohortKey: z.string().nullable().optional(),
    toolType: AssistantToolTypeSchema.nullable().optional(),
    toolInput: AssistantToolInputSchema.nullable().optional(),
    confidence: z.number().min(0).max(1),
  })
  .meta({ id: 'AssistantActionDto' });

const AssistantReviewAlbumRequestSchema = z
  .object({
    albumName: z.string().trim().min(1).max(250),
    assetIds: z.array(z.uuidv4()).optional(),
    cohortType: AssistantCohortTypeSchema.nullable().optional(),
    cohortKey: z.string().nullable().optional(),
  })
  .meta({ id: 'AssistantReviewAlbumRequestDto' });

const AssistantToolRequestSchema = z
  .object({
    toolType: AssistantToolTypeSchema,
    input: AssistantToolInputSchema.optional().default({}),
  })
  .meta({ id: 'AssistantToolRequestDto' });

const AssistantToolResponseSchema = z
  .object({
    toolType: AssistantToolTypeSchema,
    generatedAt: z.string(),
    summary: z.record(z.string(), z.unknown()),
    results: z.array(z.record(z.string(), z.unknown())),
    errors: z.array(z.record(z.string(), z.unknown())),
    logFilePath: z.string().nullable().optional(),
    logFileFormat: z.literal('json').nullable().optional(),
    resultCount: z.number().optional(),
    errorCount: z.number().optional(),
    inlineResultsOmitted: z.boolean().optional(),
  })
  .meta({ id: 'AssistantToolResponseDto' });

const AssistantReviewAlbumResponseSchema = z
  .object({
    albumId: z.uuidv4(),
    albumName: z.string(),
    assetCount: z.number(),
    truncated: z.boolean(),
    changeLogFilePath: z.string(),
    undoAvailable: z.boolean(),
    undoAction: z.literal('delete_created_review_album'),
  })
  .meta({ id: 'AssistantReviewAlbumResponseDto' });

const AssistantUndoRequestSchema = z
  .object({
    changeLogFilePath: z.string().trim().min(1).max(1000),
  })
  .meta({ id: 'AssistantUndoRequestDto' });

const AssistantUndoResponseSchema = z
  .object({
    status: z.enum(['undone']),
    actionType: z.literal('assistant_review_album_create'),
    changeLogFilePath: z.string(),
    undoneAlbumId: z.uuidv4(),
    undoneAlbumName: z.string(),
    message: z.string(),
  })
  .meta({ id: 'AssistantUndoResponseDto' });

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
export class AssistantReviewAlbumRequestDto extends createZodDto(AssistantReviewAlbumRequestSchema) {}
export class AssistantReviewAlbumResponseDto extends createZodDto(AssistantReviewAlbumResponseSchema) {}
export class AssistantToolRequestDto extends createZodDto(AssistantToolRequestSchema) {}
export class AssistantToolResponseDto extends createZodDto(AssistantToolResponseSchema) {}
export class AssistantUndoRequestDto extends createZodDto(AssistantUndoRequestSchema) {}
export class AssistantUndoResponseDto extends createZodDto(AssistantUndoResponseSchema) {}

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
