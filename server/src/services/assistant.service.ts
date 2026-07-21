import { BadRequestException, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { AlbumResponseDto } from 'src/dtos/album.dto';
import { AssetResponseDto } from 'src/dtos/asset-response.dto';
import { AssetMetadataResponseDto } from 'src/dtos/asset.dto';
import {
  AssistantAgentCommandRequestDto,
  AssistantAgentCommandResponseDto,
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
  AssistantExecuteReviewPlanRequestDto,
  AssistantExecuteReviewPlanResponseDto,
  AssistantIndexRunRequestDto,
  AssistantIndexRunResponseDto,
  AssistantIndexRunsResponseDto,
  AssistantMutationCapabilitiesResponseDto,
  AssistantMutationRequestDto,
  AssistantMutationResponseDto,
  AssistantReviewAlbumRequestDto,
  AssistantReviewAlbumResponseDto,
  AssistantToolRequestDto,
  AssistantToolResponseDto,
  AssistantUndoRequestDto,
  AssistantUndoResponseDto,
} from 'src/dtos/assistant.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { LibraryResponseDto } from 'src/dtos/library.dto';
import { SearchSuggestionType } from 'src/dtos/search.dto';
import { AssetOrder, AssetOrderBy, AssetType, AssetVisibility, JobName, Permission } from 'src/enum';
import type {
  AssistantAuditAsset,
  AssistantAuditAssetSearch,
  AssistantEventAuditBucket,
  AssistantLibraryAuditBucket,
  AssistantLibraryAuditSummary,
} from 'src/repositories/asset.repository';
import type { EnvData } from 'src/repositories/config.repository';
import type { AssistantRawIndexFile } from 'src/repositories/assistant-index.repository';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { BaseService } from 'src/services/base.service';
import { LibraryService } from 'src/services/library.service';
import { SearchService } from 'src/services/search.service';
import { StackService } from 'src/services/stack.service';
import { mimeTypes } from 'src/utils/mime-types';

type AssistantProvider = 'openai' | 'anthropic' | 'claude-cli' | 'codex-cli';
type LlmProvider = AssistantProvider | 'local-cli';
type AssistantToolType =
  | 'content_hash_audit'
  | 'sidecar_pair_audit'
  | 'metadata_search'
  | 'mobile_original_compare';

type RemoteProviderConfig = {
  provider: Exclude<LlmProvider, 'local-cli'>;
  apiKey: string;
  model: string;
};

type LocalCliProviderConfig = {
  provider: 'claude-cli' | 'codex-cli' | 'local-cli';
  command?: string;
  args: string[];
  url?: string;
  timeoutSeconds: number;
  model: string;
};

type ProviderConfig = RemoteProviderConfig | LocalCliProviderConfig;

type AssistantModelOutput = {
  answer?: unknown;
  actions?: unknown;
};

type AssistantAgentBridgeCommandResponse = {
  status?: unknown;
  command?: unknown;
  target?: unknown;
  targetKind?: unknown;
  cwd?: unknown;
  exitCode?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  stdoutTruncated?: unknown;
  stderrTruncated?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationMs?: unknown;
  hostLogFilePath?: unknown;
  error?: unknown;
};

type AssistantIndexRunRecord = {
  id: string;
  ownerId: string;
  libraryId: string | null;
  mode: string;
  status: string;
  originalPathPrefix: string | null;
  totalAssets: number | string;
  indexedAssets: number | string;
  errorCount: number | string;
  parameters: Record<string, unknown>;
  summary: Record<string, unknown>;
  logFilePath: string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type AssistantIndexGroupRecord = {
  id: string;
  groupType: string;
  groupKey: string;
  label: string;
  assetCount: number | string;
  confidence: number | string;
  evidence: Record<string, unknown>;
};

type AssistantOrganizationCoverageItem = {
  stage: 'event' | 'source_path';
  title: string;
  rationale: string;
  cohortType: 'event' | 'source_path';
  cohortKey: string;
  assetCount: number;
  confidence: number;
  reviewStrategy?: 'review_album' | 'decompose_first';
  generatedLikeCount?: number;
  smallDimensionCount?: number;
  activeDayCount?: number;
  dateSpanDays?: number | null;
  distinctCameraCount?: number;
  distinctPlaceCount?: number;
  decompositionReasons?: string[];
  gpsAnchorCount?: number;
  noLocationSupportCount?: number;
};

type AssistantOrganizationCoverageLedgerItem = {
  order: number;
  status: 'ready_for_review_album' | 'needs_decomposition_audit';
  title: string;
  assetCount: number;
  rationale: string;
  cohortType: 'event' | 'source_path';
  cohortKey: string;
  reviewStrategy: 'review_album' | 'decompose_first';
  nextAction:
    | {
        type: 'review';
        albumName: string;
        cohortType: 'event' | 'source_path';
        cohortKey: string;
      }
    | {
        type: 'metadata_audit';
        toolType: 'metadata_search' | 'sidecar_pair_audit';
        toolInput: { originalPathContains: string };
      };
};

type AssistantOrganizationCoveragePlan = {
  selectedEventReviewCohorts: AssistantOrganizationCoverageItem[];
  remainingSourcePathReviewCohorts: AssistantOrganizationCoverageItem[];
  coverageExecutionLedger: AssistantOrganizationCoverageLedgerItem[];
  [key: string]: unknown;
};

type AssistantMutationActionType =
  | 'assistant_review_album_create'
  | 'metadata_edit'
  | 'archive_favorite'
  | 'stack_change'
  | 'folder_move'
  | 'duplicate_resolution';

type AssistantChangeJournal = {
  version: 1;
  actionType: AssistantMutationActionType;
  status: 'planned' | 'applied' | 'blocked' | 'failed' | 'undone' | 'undo_failed';
  generatedAt: string;
  updatedAt: string;
  ownerId: string;
  changeLogFilePath: string;
  request: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  undo: {
    strategy:
      | 'delete_created_review_album'
      | 'restore_asset_fields'
      | 'delete_created_stack'
      | 'recreate_deleted_stack'
      | 'restore_stack_primary'
      | 'not_available';
    available: boolean;
    albumId: string | null;
    albumName: string | null;
    assetIds?: string[];
    stackId?: string | null;
    stackAssetIds?: string[];
    primaryAssetId?: string | null;
  };
  error?: string;
  undoResult?: Record<string, unknown>;
};

const assistantActionTypes = [
  'search',
  'album_plan',
  'folder_plan',
  'metadata_audit',
  'original_file_audit',
  'review',
  'agent_command',
] as const;

const assistantToolInputProperties = {
  cohortType: { type: ['string', 'null'], enum: ['source_path', 'date', 'camera', 'location', 'event', null] },
  cohortKey: { type: ['string', 'null'] },
  originalPathContains: { type: ['string', 'null'] },
  originalFileNameContains: { type: ['string', 'null'] },
  fileExtension: { type: ['string', 'null'] },
  checksumAlgorithm: { type: ['string', 'null'] },
  type: { type: ['string', 'null'], enum: ['IMAGE', 'VIDEO', 'AUDIO', 'OTHER', null] },
  takenAfter: { type: ['string', 'null'] },
  takenBefore: { type: ['string', 'null'] },
  make: { type: ['string', 'null'] },
  model: { type: ['string', 'null'] },
  country: { type: ['string', 'null'] },
  state: { type: ['string', 'null'] },
  city: { type: ['string', 'null'] },
  noGps: { type: ['boolean', 'null'] },
  unknownCamera: { type: ['boolean', 'null'] },
  hasMobileMetadata: { type: ['boolean', 'null'] },
  desktopSourcePrefix: { type: ['string', 'null'] },
};

const assistantOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: {
      type: 'string',
      description: 'A concise answer to show in the Immich assistant chat.',
    },
    actions: {
      type: 'array',
      description: 'Suggested organization actions. These are proposals only and must not imply changes were applied.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: {
            type: 'string',
            enum: assistantActionTypes,
          },
          title: { type: 'string' },
          rationale: { type: 'string' },
          query: { type: ['string', 'null'] },
          albumName: { type: ['string', 'null'] },
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Concrete asset IDs for a reversible review album. Leave empty unless every listed asset is visible in the provided context and belongs in the proposed set.',
          },
          cohortType: {
            type: ['string', 'null'],
            enum: ['source_path', 'date', 'camera', 'location', 'event', null],
            description:
              'Deterministic Immich cohort type for a reversible review album. Use only when the cohort appears in deterministicAudits.',
          },
          cohortKey: {
            type: ['string', 'null'],
            description:
              'Exact deterministic cohort key from deterministicAudits. Use with cohortType to let Immich materialize the cohort at action time.',
          },
          toolType: {
            type: ['string', 'null'],
            enum: ['content_hash_audit', 'sidecar_pair_audit', 'metadata_search', 'mobile_original_compare', null],
            description:
              'Read-only Immich assistant tool to run when this action needs deterministic evidence beyond the preloaded context.',
          },
          toolInput: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: assistantToolInputProperties,
            required: Object.keys(assistantToolInputProperties),
            description:
              'Input for toolType. Use cohortType/cohortKey, path/name/date/camera/location filters, or desktopSourcePrefix as needed. Assistant tools scan every matching asset.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
          command: {
            type: ['string', 'null'],
            description:
              'A shell command to run through the audited agent terminal. Use for read-only inventory, EXIF, checksum, dedupe assessment, source-tree inspection, or status probes. Avoid destructive commands unless the user explicitly requested them and a rollback path exists.',
          },
          target: {
            type: ['string', 'null'],
            enum: ['local', 'synology', 'immich', null],
            description:
              'Command target. Use local for Mac host tools, synology for NAS data under /volume1, and immich for commands inside the Immich server container.',
          },
          cwd: {
            type: ['string', 'null'],
            description:
              'Working directory for command actions. Prefer /Users/johnhausman/source/immich for local, /volume1 for synology, and /usr/src/app or /data for immich.',
          },
          timeoutSeconds: {
            type: ['number', 'null'],
            description: 'Optional command timeout in seconds, up to 3600.',
          },
        },
        required: [
          'type',
          'title',
          'rationale',
          'query',
          'albumName',
          'assetIds',
          'cohortType',
          'cohortKey',
          'toolType',
          'toolInput',
          'command',
          'target',
          'cwd',
          'timeoutSeconds',
          'confidence',
        ],
      },
    },
  },
  required: ['answer', 'actions'],
};

@Injectable()
export class AssistantService extends BaseService {
  private readonly assetSampleSize = 75;
  private readonly assetMetadataSampleSize = 60;
  private readonly auditBucketLimit = 80;
  private readonly duplicateCandidateLimit = 40;
  private readonly assistantToolInlineResultThreshold = 100;
  private readonly assistantToolLogDirectory = '/data/assistant-audits';
  private readonly assistantChangeJournalDirectory = '/data/assistant-audits/change-journal';
  private readonly assistantAgentCommandLogDirectory = '/data/assistant-audits/agent-terminal';
  private readonly assistantChatDiagnosticDirectory = '/data/assistant-audits/assistant-chat';
  private readonly assistantAutoToolIterationLimit = 1;
  private readonly assistantAutoToolActionLimit = 3;

  async assess(auth: AuthDto): Promise<AssistantAssessmentResponseDto> {
    const albumService = BaseService.create(AlbumService, this);
    const searchService = BaseService.create(SearchService, this);

    const [
      albums,
      total,
      images,
      videos,
      audio,
      other,
      unorganized,
      favorites,
      archived,
      timeBuckets,
      cameraMakes,
      cameraModels,
      countries,
      cities,
    ] = await Promise.all([
      albumService.getAll(auth, { isOwned: true }),
      searchService.searchStatistics(auth, {}),
      searchService.searchStatistics(auth, { type: AssetType.Image }),
      searchService.searchStatistics(auth, { type: AssetType.Video }),
      searchService.searchStatistics(auth, { type: AssetType.Audio }),
      searchService.searchStatistics(auth, { type: AssetType.Other }),
      searchService.searchStatistics(auth, { isNotInAlbum: true }),
      searchService.searchStatistics(auth, { isFavorite: true }),
      searchService.searchStatistics(auth, { visibility: AssetVisibility.Archive }),
      this.assetRepository.getTimeBuckets({
        userIds: [auth.user.id],
        withStacked: true,
        orderBy: AssetOrderBy.TakenAt,
        order: AssetOrder.Desc,
      }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.CAMERA_MAKE }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.CAMERA_MODEL }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.COUNTRY }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.CITY }),
    ]);

    const topYears = this.toTopYears(timeBuckets);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalAssets: total.total,
        imageAssets: images.total,
        videoAssets: videos.total,
        audioAssets: audio.total,
        otherAssets: other.total,
        albums: albums.length,
        unorganizedAssets: unorganized.total,
        favoriteAssets: favorites.total,
        archivedAssets: archived.total,
      },
      topYears,
      cameraMakes: this.toStringList(cameraMakes),
      cameraModels: this.toStringList(cameraModels),
      countries: this.toStringList(countries),
      cities: this.toStringList(cities),
      findings: this.getAssessmentFindings({
        totalAssets: total.total,
        unorganizedAssets: unorganized.total,
        albums: albums.length,
        topYears,
        cameraMakes: this.toStringList(cameraMakes),
        countries: this.toStringList(countries),
        cities: this.toStringList(cities),
      }),
    };
  }

  async chat(auth: AuthDto, dto: AssistantChatRequestDto): Promise<AssistantChatResponseDto> {
    const requestId = this.cryptoRepository.randomUUID();
    const startedAt = new Date().toISOString();
    const diagnostic = {
      requestId,
      startedAt,
      finishedAt: null as string | null,
      durationMs: null as number | null,
      status: 'started',
      requestedProvider: dto.provider ?? null,
      userId: auth.user.id,
      messageCount: dto.messages.length,
      lastMessagePreview: dto.messages.at(-1)?.content.slice(0, 500) ?? '',
      contextSummary: null as AssistantChatResponseDto['context'] | null,
      providerAttempts: [] as Array<{
        provider: ProviderConfig['provider'];
        model?: string;
        startedAt: string;
        finishedAt?: string;
        durationMs?: number;
        status: 'started' | 'success' | 'error';
        actionCount?: number;
        error?: string;
      }>,
      error: null as string | null,
    };

    const context = await this.getLibraryContext(auth, dto);
    diagnostic.contextSummary = context.summary;
    const providerConfigs = this.getLlmProviders(dto.provider);
    this.logger.log(
      `Assistant chat ${requestId} started provider=${dto.provider ?? 'auto'} providers=${providerConfigs
        .map((provider) => provider.provider)
        .join(',')}`,
    );

    if (providerConfigs.length === 0) {
      const response = {
        status: 'disabled',
        answer:
          'The assistant is not configured. Set IMMICH_ASSISTANT_CLAUDE_COMMAND, IMMICH_ASSISTANT_CODEX_COMMAND, or set IMMICH_LLM_PROVIDER with the matching provider API key.',
        actions: [],
        context: context.summary,
      } satisfies AssistantChatResponseDto;
      await this.writeAssistantChatDiagnostic(diagnostic, response.status);
      return response;
    }

    let lastProviderConfig: ProviderConfig | undefined;
    let lastError: string | undefined;
    for (const providerConfig of providerConfigs) {
      lastProviderConfig = providerConfig;
      const providerStartedAt = new Date().toISOString();
      const providerAttempt: (typeof diagnostic.providerAttempts)[number] = {
        provider: providerConfig.provider,
        model: providerConfig.model,
        startedAt: providerStartedAt,
        status: 'started',
      };
      diagnostic.providerAttempts.push(providerAttempt);

      try {
        let output = await this.callAssistantProvider(providerConfig, dto, context);
        let responseContext = context;

        for (let iteration = 0; iteration < this.assistantAutoToolIterationLimit; iteration++) {
          const autoToolResults = await this.runAutoToolActions(auth, this.toActions(output));
          if (autoToolResults.length === 0) {
            break;
          }

          responseContext = this.withRequestedToolResults(responseContext, autoToolResults);
          output = await this.callAssistantProvider(providerConfig, dto, responseContext);
        }

        const response = {
          status: 'success',
          provider: providerConfig.provider,
          model: providerConfig.model,
          answer: this.toAnswer(output),
          actions: this.toActions(output),
          context: responseContext.summary,
        } satisfies AssistantChatResponseDto;
        providerAttempt.status = 'success';
        providerAttempt.finishedAt = new Date().toISOString();
        providerAttempt.durationMs = new Date(providerAttempt.finishedAt).getTime() - new Date(providerStartedAt).getTime();
        providerAttempt.actionCount = response.actions.length;
        diagnostic.contextSummary = responseContext.summary;
        await this.writeAssistantChatDiagnostic(diagnostic, response.status);
        this.logger.log(
          `Assistant chat ${requestId} succeeded provider=${providerConfig.provider} durationMs=${providerAttempt.durationMs} actions=${response.actions.length}`,
        );
        return response;
      } catch (error: unknown) {
        lastError = this.getErrorMessage(error);
        providerAttempt.status = 'error';
        providerAttempt.finishedAt = new Date().toISOString();
        providerAttempt.durationMs = new Date(providerAttempt.finishedAt).getTime() - new Date(providerStartedAt).getTime();
        providerAttempt.error = lastError.slice(0, 2000);
        this.logger.warn(`Assistant chat failed for ${providerConfig.provider}: ${lastError}`);
      }
    }

    const response = {
      status: 'error',
      provider: lastProviderConfig?.provider,
      model: lastProviderConfig?.model,
      answer: 'The assistant request failed. No library changes were made.',
      actions: [],
      error: lastError,
      context: context.summary,
    } satisfies AssistantChatResponseDto;
    diagnostic.error = lastError ?? null;
    await this.writeAssistantChatDiagnostic(diagnostic, response.status);
    return response;
  }

  async createReviewAlbum(
    auth: AuthDto,
    dto: AssistantReviewAlbumRequestDto,
  ): Promise<AssistantReviewAlbumResponseDto> {
    const albumService = BaseService.create(AlbumService, this);
    const assetIds = await this.getReviewAlbumAssetIds(auth, dto);
    if (assetIds.length === 0) {
      throw new BadRequestException('The assistant review album request did not resolve any assets');
    }

    const journal = await this.createAssistantReviewAlbumJournal(auth, dto, assetIds);

    try {
      const album = await albumService.create(auth, {
        albumName: dto.albumName,
        description: this.getReviewAlbumDescription(dto),
        assetIds,
      });

      journal.status = 'applied';
      journal.updatedAt = new Date().toISOString();
      journal.after = {
        createdAlbum: this.toAlbumJournalSummary(album),
        assetIds,
      };
      journal.undo = {
        strategy: 'delete_created_review_album',
        available: true,
        albumId: album.id,
        albumName: album.albumName,
      };
      await this.writeAssistantChangeJournal(journal);

      return {
        albumId: album.id,
        albumName: album.albumName,
        assetCount: assetIds.length,
        truncated: false,
        changeLogFilePath: journal.changeLogFilePath,
        undoAvailable: true,
        undoAction: 'delete_created_review_album',
      };
    } catch (error: unknown) {
      journal.status = 'failed';
      journal.updatedAt = new Date().toISOString();
      journal.error = this.getErrorMessage(error);
      await this.writeAssistantChangeJournal(journal);
      throw error;
    }
  }

  async executeReviewPlan(
    auth: AuthDto,
    dto: AssistantExecuteReviewPlanRequestDto,
  ): Promise<AssistantExecuteReviewPlanResponseDto> {
    const albums: AssistantReviewAlbumResponseDto[] = [];
    for (const album of dto.albums) {
      albums.push(await this.createReviewAlbum(auth, album));
    }

    const assetCount = albums.reduce((sum, album) => sum + album.assetCount, 0);
    return {
      status: 'applied',
      albumCount: albums.length,
      assetCount,
      albums,
      message: `Created ${albums.length} assistant review albums covering ${assetCount} album placements. Each album has its own change journal and undo action.`,
    };
  }

  async undoAssistantChange(auth: AuthDto, dto: AssistantUndoRequestDto): Promise<AssistantUndoResponseDto> {
    const journal = await this.readAssistantChangeJournal(dto.changeLogFilePath);

    if (journal.ownerId !== auth.user.id) {
      throw new BadRequestException('Assistant change journal does not belong to this user');
    }

    if (!journal.undo.available) {
      throw new BadRequestException('Assistant change journal does not have an available undo action');
    }

    if (journal.status === 'undone') {
      return {
        status: 'undone',
        actionType: journal.actionType,
        changeLogFilePath: journal.changeLogFilePath,
        undoneTargetId: journal.undo.albumId ?? journal.undo.stackId ?? journal.undo.assetIds?.[0] ?? journal.actionType,
        undoneTargetName: journal.undo.albumName ?? null,
        message: 'Assistant change was already undone.',
      };
    }

    try {
      const undoResult = await this.applyAssistantUndo(auth, journal);
      journal.status = 'undone';
      journal.updatedAt = new Date().toISOString();
      journal.undoResult = {
        undoneAt: journal.updatedAt,
        ...undoResult,
      };
      journal.undo.available = false;
      await this.writeAssistantChangeJournal(journal);

      return {
        status: 'undone',
        actionType: journal.actionType,
        changeLogFilePath: journal.changeLogFilePath,
        undoneTargetId: undoResult.targetId,
        undoneTargetName: undoResult.targetName,
        message: undoResult.message,
      };
    } catch (error: unknown) {
      journal.status = 'undo_failed';
      journal.updatedAt = new Date().toISOString();
      journal.error = this.getErrorMessage(error);
      await this.writeAssistantChangeJournal(journal);
      throw error;
    }
  }

  getMutationCapabilities(): AssistantMutationCapabilitiesResponseDto {
    return {
      changeJournalDirectory: this.assistantChangeJournalDirectory,
      capabilities: [
        {
          actionType: 'metadata_edit',
          label: 'Metadata edits',
          applySupported: true,
          undoSupported: true,
          journalRequired: true,
          notes: 'Supports description, date, GPS, and rating updates with per-asset before-state restore.',
        },
        {
          actionType: 'archive_favorite',
          label: 'Archive and favorite changes',
          applySupported: true,
          undoSupported: true,
          journalRequired: true,
          notes: 'Supports favorite and visibility changes with per-asset before-state restore.',
        },
        {
          actionType: 'stack_change',
          label: 'Stack changes',
          applySupported: true,
          undoSupported: true,
          journalRequired: true,
          notes: 'Supports stack create, delete, and primary-asset changes. Deleted stacks are restored as a new stack with the same assets.',
        },
        {
          actionType: 'folder_move',
          label: 'Folder moves',
          applySupported: false,
          undoSupported: false,
          journalRequired: true,
          notes: 'Registered as a planned capability only. Apply is blocked until filesystem and database path rollback is implemented.',
        },
        {
          actionType: 'duplicate_resolution',
          label: 'Duplicate resolution',
          applySupported: false,
          undoSupported: false,
          journalRequired: true,
          notes: 'Registered as a planned capability only. Apply is blocked until trash/metadata/album/tag merge rollback is implemented.',
        },
      ],
    };
  }

  async runAssistantMutation(
    auth: AuthDto,
    dto: AssistantMutationRequestDto,
  ): Promise<AssistantMutationResponseDto> {
    const mode = dto.mode ?? 'plan';
    const targetCount = this.getAssistantMutationTargetCount(dto);
    const journal = await this.createAssistantMutationJournal(auth, dto, targetCount);

    if (mode === 'plan') {
      return {
        status: 'planned',
        actionType: dto.actionType,
        changeLogFilePath: journal.changeLogFilePath,
        applySupported: this.isAssistantMutationApplySupported(dto),
        undoAvailable: false,
        targetCount,
        message: 'Assistant mutation plan journal was written. No library changes were made.',
      };
    }

    if (!this.isAssistantMutationApplySupported(dto)) {
      journal.status = 'blocked';
      journal.updatedAt = new Date().toISOString();
      journal.error = 'Apply is blocked until a typed undo implementation exists for this action.';
      await this.writeAssistantChangeJournal(journal);
      return {
        status: 'blocked',
        actionType: dto.actionType,
        changeLogFilePath: journal.changeLogFilePath,
        applySupported: false,
        undoAvailable: false,
        targetCount,
        message: journal.error,
      };
    }

    try {
      const applyResult = await this.applyAssistantMutation(auth, dto);
      journal.status = 'applied';
      journal.updatedAt = new Date().toISOString();
      journal.after = applyResult.after;
      journal.undo = applyResult.undo;
      await this.writeAssistantChangeJournal(journal);
      return {
        status: 'applied',
        actionType: dto.actionType,
        changeLogFilePath: journal.changeLogFilePath,
        applySupported: true,
        undoAvailable: applyResult.undo.available,
        targetCount,
        message: applyResult.message,
      };
    } catch (error: unknown) {
      journal.status = 'failed';
      journal.updatedAt = new Date().toISOString();
      journal.error = this.getErrorMessage(error);
      await this.writeAssistantChangeJournal(journal);
      throw error;
    }
  }

  async runTool(auth: AuthDto, dto: AssistantToolRequestDto): Promise<AssistantToolResponseDto> {
    let response: AssistantToolResponseDto;

    switch (dto.toolType) {
      case 'content_hash_audit': {
        response = await this.runContentHashAudit(auth, dto);
        break;
      }

      case 'sidecar_pair_audit': {
        response = await this.runSidecarPairAudit(auth, dto);
        break;
      }

      case 'metadata_search': {
        response = await this.runMetadataSearch(auth, dto);
        break;
      }

      case 'mobile_original_compare': {
        response = await this.runMobileOriginalCompare(auth, dto);
        break;
      }
    }

    return this.withAssistantToolLog(auth, response);
  }

  private async callAssistantProvider(
    providerConfig: ProviderConfig,
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ) {
    return this.isLocalCliProvider(providerConfig)
      ? await this.callLocalAssistant(providerConfig, dto, context)
      : providerConfig.provider === 'openai'
        ? await this.callOpenAi(providerConfig, dto, context)
        : await this.callAnthropic(providerConfig, dto, context);
  }

  private async runAutoToolActions(auth: AuthDto, actions: AssistantChatResponseDto['actions']) {
    const requests = this.toAutoToolRequests(actions);
    const results = [];

    for (const request of requests) {
      try {
        const result = await this.runTool(auth, {
          toolType: request.toolType,
          input: request.toolInput ?? {},
        });
        results.push(this.toRequestedToolResultContext(result, request.actionTitle));
      } catch (error: unknown) {
        results.push({
          toolType: request.toolType,
          generatedAt: new Date().toISOString(),
          autoExecuted: true,
          sourceActionTitle: request.actionTitle,
          summary: { failed: true, error: this.getErrorMessage(error), input: request.toolInput ?? {} },
          resultCount: 0,
          errorCount: 1,
          logFilePath: null,
          fullResultsAvailableByRunningToolAction: false,
        });
      }
    }

    return results;
  }

  private toAutoToolRequests(actions: AssistantChatResponseDto['actions']) {
    const requests: Array<{
      actionTitle: string;
      toolType: AssistantToolType;
      toolInput: Record<string, unknown> | null;
    }> = [];
    const seen = new Set<string>();

    for (const action of actions) {
      if (
        action.type !== 'metadata_audit' &&
        action.type !== 'original_file_audit' &&
        action.type !== 'search' &&
        action.type !== 'album_plan'
      ) {
        continue;
      }
      if (!action.toolType || action.toolType === 'content_hash_audit' || action.toolType === 'mobile_original_compare') {
        continue;
      }

      const key = JSON.stringify({ toolType: action.toolType, toolInput: action.toolInput ?? {} });
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      requests.push({
        actionTitle: action.title,
        toolType: action.toolType,
        toolInput: action.toolInput ? { ...action.toolInput } : null,
      });

      if (requests.length >= this.assistantAutoToolActionLimit) {
        break;
      }
    }

    return requests;
  }

  private toRequestedToolResultContext(result: AssistantToolResponseDto, sourceActionTitle?: string) {
    return {
      toolType: result.toolType,
      generatedAt: result.generatedAt,
      autoExecuted: true,
      sourceActionTitle: sourceActionTitle ?? null,
      summary: result.summary,
      resultCount: result.resultCount ?? result.results.length,
      errorCount: result.errorCount ?? result.errors.length,
      logFilePath: result.logFilePath ?? null,
      inlineResultsOmitted: result.inlineResultsOmitted ?? false,
      sampleResults: result.results.slice(0, 10),
      sampleErrors: result.errors.slice(0, 5),
      fullResultsAvailableByRunningToolAction: true,
    };
  }

  private withRequestedToolResults(
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
    requestedToolResults: Array<Record<string, unknown>>,
  ): Awaited<ReturnType<AssistantService['getLibraryContext']>> {
    return {
      ...context,
      deterministicAudits: {
        ...context.deterministicAudits,
        requestedToolResults: [...context.deterministicAudits.requestedToolResults, ...requestedToolResults],
      },
    };
  }

  async getIndexRuns(auth: AuthDto): Promise<AssistantIndexRunsResponseDto> {
    const runs = await this.assistantIndexRepository.getRuns(auth.user.id);
    return { runs: runs.map((run) => this.toAssistantIndexRunResponse(run)) };
  }

  async getIndexRun(auth: AuthDto, id: string): Promise<AssistantIndexRunResponseDto> {
    const run = await this.assistantIndexRepository.getRun(auth.user.id, id);
    if (!run) {
      throw new BadRequestException('Assistant index run not found');
    }

    const groups = await this.assistantIndexRepository.getGroups(id);
    return this.toAssistantIndexRunResponse(run, groups);
  }

  async createIndexRun(auth: AuthDto, dto: AssistantIndexRunRequestDto): Promise<AssistantIndexRunResponseDto> {
    let importPaths: string[] = [];
    if (dto.libraryId) {
      const library = await this.libraryRepository.get(dto.libraryId);
      if (!library || library.ownerId !== auth.user.id) {
        throw new BadRequestException('Assistant index library not found');
      }
      importPaths = library.importPaths;
    }

    if (dto.originalPathPrefix && !dto.originalPathPrefix.startsWith('/')) {
      throw new BadRequestException('originalPathPrefix must be an absolute Immich/container path');
    }

    if (!dto.libraryId && (dto.includeRawFiles ?? true) && !dto.originalPathPrefix) {
      const libraries = await this.libraryRepository.getAll();
      importPaths = libraries
        .filter((library) => library.ownerId === auth.user.id)
        .flatMap((library) => library.importPaths);
    }

    const startedAt = new Date();
    const run = await this.assistantIndexRepository.createRun({
      ownerId: auth.user.id,
      libraryId: dto.libraryId ?? null,
      mode: 'inventory',
      status: 'running',
      originalPathPrefix: dto.originalPathPrefix ?? null,
      parameters: {
        libraryId: dto.libraryId ?? null,
        originalPathPrefix: dto.originalPathPrefix ?? null,
        includeContentHash: dto.includeContentHash ?? true,
        includeRawFiles: dto.includeRawFiles ?? true,
        includeSidecars: dto.includeSidecars ?? true,
        indexedSource: 'imported_immich_assets',
        classifierVersion: 2,
      },
      summary: {},
      startedAt,
    });

    void this.executeIndexRun(auth, dto, run.id, importPaths);
    return this.toAssistantIndexRunResponse(run);
  }

  async runAgentCommand(
    auth: AuthDto,
    dto: AssistantAgentCommandRequestDto,
  ): Promise<AssistantAgentCommandResponseDto> {
    const { assistant } = this.configRepository.getEnv();
    const generatedAt = new Date().toISOString();
    if (!assistant.agent.terminalEnabled || !assistant.agent.url) {
      return {
        status: 'disabled',
        command: dto.command,
        target: dto.target ?? 'local',
        targetKind: null,
        cwd: dto.cwd ?? null,
        exitCode: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: generatedAt,
        finishedAt: generatedAt,
        durationMs: 0,
        hostLogFilePath: null,
        serverLogFilePath: null,
        message:
          'Assistant agent terminal is disabled. Set IMMICH_ASSISTANT_AGENT_TERMINAL_ENABLED=true and IMMICH_ASSISTANT_AGENT_URL.',
      };
    }

    const timeoutSeconds = Math.min(dto.timeoutSeconds ?? assistant.agent.timeoutSeconds, assistant.agent.timeoutSeconds);
    const maxOutputBytes = Math.min(dto.maxOutputBytes ?? assistant.agent.maxOutputBytes, assistant.agent.maxOutputBytes);
    const response = await fetch(assistant.agent.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: dto.command,
        target: dto.target ?? 'local',
        cwd: dto.cwd,
        timeoutSeconds,
        maxOutputBytes,
      }),
      signal: AbortSignal.timeout((timeoutSeconds + 5) * 1000),
    });
    const payload = (await this.readLlmResponse(response)) as AssistantAgentBridgeCommandResponse;
    const result = this.toAssistantAgentCommandResponse(dto, payload);
    const serverLogFilePath = await this.writeAssistantAgentCommandLog(auth, result);

    return {
      ...result,
      serverLogFilePath,
    };
  }

  private async executeIndexRun(
    auth: AuthDto,
    dto: AssistantIndexRunRequestDto,
    runId: string,
    importPaths: string[],
  ) {
    try {
      const indexedAssets = await this.assistantIndexRepository.indexImportedAssets(runId, auth.user.id, {
        libraryId: dto.libraryId ?? null,
        originalPathPrefix: dto.originalPathPrefix ?? null,
      });
      await this.updateIndexRunProgress(runId, 'raw_inventory', {
        indexedImportedAssets: indexedAssets,
        indexedRawFiles: 0,
        contentHashIndexedAssets: 0,
        contentHashErrorCount: 0,
      });
      const indexedRawFiles = (dto.includeRawFiles ?? true)
        ? await this.indexRawFiles(
            auth,
            runId,
            dto.libraryId ?? null,
            dto.originalPathPrefix,
            importPaths,
            {
              includeSidecars: dto.includeSidecars ?? true,
            },
            async (indexedRawFiles) =>
              this.updateIndexRunProgress(runId, 'raw_inventory', {
                indexedImportedAssets: indexedAssets,
                indexedRawFiles,
                contentHashIndexedAssets: 0,
                contentHashErrorCount: 0,
              }),
          )
        : 0;
      await this.updateIndexRunProgress(runId, (dto.includeContentHash ?? true) ? 'content_hash' : 'grouping', {
        indexedImportedAssets: indexedAssets,
        indexedRawFiles,
        contentHashIndexedAssets: 0,
        contentHashErrorCount: 0,
      });
      const hashResult = (dto.includeContentHash ?? true)
        ? await this.hashAssistantIndexAssets(runId, async (hashResult) =>
            this.updateIndexRunProgress(runId, 'content_hash', {
              indexedImportedAssets: indexedAssets,
              indexedRawFiles,
              contentHashIndexedAssets: hashResult.hashed,
              contentHashErrorCount: hashResult.errors,
            }),
          )
        : { hashed: 0, errors: 0 };
      await this.updateIndexRunProgress(runId, 'grouping', {
        indexedImportedAssets: indexedAssets,
        indexedRawFiles,
        contentHashIndexedAssets: hashResult.hashed,
        contentHashErrorCount: hashResult.errors,
      });
      const groupCount = await this.assistantIndexRepository.rebuildGroups(runId);
      const summary = await this.assistantIndexRepository.getRunSummary(runId);
      await this.assistantIndexRepository.updateRun(runId, {
        status: 'completed',
        totalAssets: indexedAssets + indexedRawFiles,
        indexedAssets: indexedAssets + indexedRawFiles,
        errorCount: hashResult.errors,
        summary: {
          ...summary,
          groupCount,
          indexedImportedAssets: indexedAssets,
          indexedRawFiles,
          contentHashIndexedAssets: hashResult.hashed,
          contentHashErrorCount: hashResult.errors,
        },
        finishedAt: new Date(),
      });
    } catch (error: unknown) {
      await this.assistantIndexRepository.updateRun(runId, {
        status: 'failed',
        errorCount: 1,
        summary: {
          error: this.getErrorMessage(error),
          note: 'The assistant index run failed before mutating any source assets. Index rows are assistant-owned evidence only.',
        },
        finishedAt: new Date(),
      });
    }
  }

  private async indexRawFiles(
    auth: AuthDto,
    runId: string,
    libraryId: string | null,
    originalPathPrefix: string | null | undefined,
    importPaths: string[],
    options: { includeSidecars: boolean },
    onProgress?: (indexed: number) => Promise<void>,
  ) {
    const roots = this.toUniqueStrings(originalPathPrefix ? [originalPathPrefix] : importPaths).map((item) =>
      normalize(item),
    );
    let indexed = 0;
    const batch: AssistantRawIndexFile[] = [];
    const flush = async () => {
      indexed += await this.assistantIndexRepository.insertRawFileBatch(runId, auth.user.id, libraryId, batch.splice(0));
      await onProgress?.(indexed);
    };

    for (const root of roots) {
      for await (const file of this.walkRawFiles(root, options)) {
        batch.push(file);
        if (batch.length >= 1000) {
          await flush();
        }
      }
    }

    await flush();
    return indexed;
  }

  private async *walkRawFiles(
    root: string,
    options: { includeSidecars: boolean },
  ): AsyncGenerator<AssistantRawIndexFile> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const originalPath = join(root, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkRawFiles(originalPath, options);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = extname(entry.name).toLowerCase();
      if (!options.includeSidecars && mimeTypes.isSidecar(entry.name)) {
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(originalPath);
      } catch {
        continue;
      }

      yield {
        originalPath,
        sourceDirectory: dirname(originalPath),
        originalFileName: entry.name,
        fileExtension: extension ? extension.slice(1) : null,
        type: mimeTypes.assetType(entry.name),
        fileSizeInByte: String(fileStat.size),
        localDateTime: fileStat.mtime,
        noiseLabels: this.toAssistantNoiseLabels(entry.name, originalPath, fileStat.size),
        riskLabels: this.toAssistantRawRiskLabels(entry.name, originalPath),
        evidence: {
          inventoryKind: 'raw_file',
          supportedByImmich: mimeTypes.isAsset(entry.name),
          sidecar: mimeTypes.isSidecar(entry.name),
          rawCameraFile: mimeTypes.isRaw(entry.name),
          fileModifiedAt: fileStat.mtime,
          fileCreatedAt: fileStat.birthtime,
        },
      };
    }
  }

  private toAssistantNoiseLabels(fileName: string, originalPath: string, fileSize: number) {
    const labels: string[] = [];
    const haystack = `${originalPath}/${fileName}`.toLowerCase();
    if (/(^|[_ .-])(thumb|thumbnail|preview|icon|avatar|sticker|tmp|temp|cache)([_ .-]|$)/i.test(fileName)) {
      labels.push('filename_or_path_noise');
    }
    if (/\/(thumbs?|thumbnails?|previews?|cache|icons?)\//.test(haystack)) {
      labels.push('filename_or_path_noise');
    }
    if (fileSize <= 100_000) {
      labels.push('small_file');
    }
    if (/^(screenshot|screen shot)/i.test(fileName)) {
      labels.push('screenshot');
    }
    if (/(message attachments|messages|imessage)/.test(haystack)) {
      labels.push('message_attachment');
    }
    return this.toUniqueStrings(labels);
  }

  private toAssistantRawRiskLabels(fileName: string, originalPath: string) {
    const labels: string[] = [];
    if (!mimeTypes.isAsset(fileName)) {
      labels.push(mimeTypes.isSidecar(fileName) ? 'sidecar_file' : 'unsupported_file');
    }
    if (mimeTypes.isRaw(fileName)) {
      labels.push('raw_camera_file');
    }
    if (originalPath.startsWith('/external/')) {
      labels.push('external_raw_inventory');
    }
    return labels;
  }

  private async hashAssistantIndexAssets(
    runId: string,
    onProgress?: (result: { hashed: number; errors: number }) => Promise<void>,
  ) {
    let cursor: string | null = null;
    let hashed = 0;
    let errors = 0;

    while (true) {
      const targets = await this.assistantIndexRepository.getHashTargets(runId, cursor, 250);
      if (targets.length === 0) {
        break;
      }

      for (const target of targets) {
        cursor = target.id;
        try {
          const contentSha1Buffer = await this.cryptoRepository.hashFile(target.originalPath);
          const contentSha1 = contentSha1Buffer.toString('base64');
          await this.assistantIndexRepository.updateHashSuccess(target.id, contentSha1);
          hashed += 1;
        } catch (error: unknown) {
          await this.assistantIndexRepository.updateHashError(target.id, this.getErrorMessage(error));
          errors += 1;
        }
      }
      await onProgress?.({ hashed, errors });
    }

    return { hashed, errors };
  }

  private async updateIndexRunProgress(
    runId: string,
    phase: 'raw_inventory' | 'content_hash' | 'grouping',
    progress: {
      indexedImportedAssets: number;
      indexedRawFiles: number;
      contentHashIndexedAssets: number;
      contentHashErrorCount: number;
    },
  ) {
    const indexedAssets = progress.indexedImportedAssets + progress.indexedRawFiles;
    await this.assistantIndexRepository.updateRun(runId, {
      totalAssets: indexedAssets,
      indexedAssets,
      errorCount: progress.contentHashErrorCount,
      summary: {
        phase,
        ...progress,
        indexedAssetCount: indexedAssets,
        note:
          'This assistant index run is executing in the background. Poll GET /assistant/index-runs/:id for progress.',
      },
    });
  }

  private toAssistantIndexRunResponse(
    run: AssistantIndexRunRecord,
    groups: AssistantIndexGroupRecord[] = [],
  ): AssistantIndexRunResponseDto {
    return {
      id: run.id,
      ownerId: run.ownerId,
      libraryId: run.libraryId ?? null,
      mode: run.mode,
      status: this.toAssistantIndexRunStatus(run.status),
      originalPathPrefix: run.originalPathPrefix ?? null,
      totalAssets: Number(run.totalAssets ?? 0),
      indexedAssets: Number(run.indexedAssets ?? 0),
      errorCount: Number(run.errorCount ?? 0),
      parameters: run.parameters ?? {},
      summary: run.summary ?? {},
      logFilePath: run.logFilePath ?? null,
      startedAt: this.toIsoString(run.startedAt),
      finishedAt: this.toIsoString(run.finishedAt),
      createdAt: this.toIsoString(run.createdAt) ?? new Date().toISOString(),
      updatedAt: this.toIsoString(run.updatedAt) ?? new Date().toISOString(),
      groups: groups.map((group) => ({
        id: group.id,
        groupType: group.groupType,
        groupKey: group.groupKey,
        label: group.label,
        assetCount: Number(group.assetCount ?? 0),
        confidence: Number(group.confidence ?? 0),
        evidence: group.evidence ?? {},
      })),
    };
  }

  private toIsoString(value: unknown): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value);
  }

  private toAssistantIndexRunStatus(status: string): 'pending' | 'running' | 'completed' | 'failed' {
    return status === 'pending' || status === 'running' || status === 'completed' || status === 'failed'
      ? status
      : 'failed';
  }

  private async withAssistantToolLog(
    auth: AuthDto,
    response: AssistantToolResponseDto,
  ): Promise<AssistantToolResponseDto> {
    const resultCount = response.results.length;
    const errorCount = response.errors.length;
    const inlineResultsOmitted = resultCount + errorCount > this.assistantToolInlineResultThreshold;

    if (!inlineResultsOmitted) {
      return {
        ...response,
        resultCount,
        errorCount,
        inlineResultsOmitted: false,
      };
    }

    const logFilePath = await this.writeAssistantToolLog(auth, response, resultCount, errorCount);

    return {
      ...response,
      summary: {
        ...response.summary,
        resultCount,
        errorCount,
        logFilePath,
        logFileFormat: 'json',
        inlineResultsOmitted,
      },
      results: [],
      errors: [],
      logFilePath,
      logFileFormat: 'json',
      resultCount,
      errorCount,
      inlineResultsOmitted,
    };
  }

  private async writeAssistantToolLog(
    auth: AuthDto,
    response: AssistantToolResponseDto,
    resultCount: number,
    errorCount: number,
  ) {
    this.storageRepository.mkdirSync(this.assistantToolLogDirectory);
    const timestamp = response.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
    const logFilePath = join(
      this.assistantToolLogDirectory,
      `${timestamp}-${response.toolType}-${this.cryptoRepository.randomUUID()}.json`,
    );
    const payload = {
      ...response,
      ownerId: auth.user.id,
      logFilePath,
      logFileFormat: 'json',
      resultCount,
      errorCount,
      inlineResultsOmitted: false,
    };

    await this.storageRepository.createOrOverwriteFile(logFilePath, Buffer.from(JSON.stringify(payload)));
    return logFilePath;
  }

  private async writeAssistantChatDiagnostic(
    diagnostic: {
      requestId: string;
      startedAt: string;
      finishedAt: string | null;
      durationMs: number | null;
      status: string;
      error: string | null;
    } & Record<string, unknown>,
    status: AssistantChatResponseDto['status'],
  ) {
    try {
      const finishedAt = new Date().toISOString();
      const payload = {
        ...diagnostic,
        status,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(diagnostic.startedAt).getTime(),
      };
      this.storageRepository.mkdirSync(this.assistantChatDiagnosticDirectory);
      const timestamp = diagnostic.startedAt.replaceAll(':', '-').replaceAll('.', '-');
      const logFilePath = join(
        this.assistantChatDiagnosticDirectory,
        `${timestamp}-assistant-chat-${diagnostic.requestId}.json`,
      );
      await this.storageRepository.createOrOverwriteFile(logFilePath, Buffer.from(JSON.stringify(payload, null, 2)));
      this.logger.log(`Assistant chat ${diagnostic.requestId} diagnostic log: ${logFilePath}`);
    } catch (error) {
      this.logger.warn(`Failed to write assistant chat diagnostic: ${this.getErrorMessage(error)}`);
    }
  }

  private toAssistantAgentCommandResponse(
    dto: AssistantAgentCommandRequestDto,
    payload: AssistantAgentBridgeCommandResponse,
  ): AssistantAgentCommandResponseDto {
    const now = new Date().toISOString();
    const status = this.toAssistantAgentCommandStatus(payload.status);
    const startedAt = typeof payload.startedAt === 'string' ? payload.startedAt : now;
    const finishedAt = typeof payload.finishedAt === 'string' ? payload.finishedAt : now;

    return {
      status,
      command: typeof payload.command === 'string' ? payload.command : dto.command,
      target:
        payload.target === 'local' || payload.target === 'synology' || payload.target === 'immich'
          ? payload.target
          : dto.target === 'local' || dto.target === 'synology' || dto.target === 'immich'
            ? dto.target
            : 'local',
      targetKind: typeof payload.targetKind === 'string' ? payload.targetKind : null,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : (dto.cwd ?? null),
      exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
      stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
      stderr:
        typeof payload.stderr === 'string'
          ? payload.stderr
          : typeof payload.error === 'string'
            ? payload.error
            : '',
      stdoutTruncated: payload.stdoutTruncated === true,
      stderrTruncated: payload.stderrTruncated === true,
      startedAt,
      finishedAt,
      durationMs:
        typeof payload.durationMs === 'number'
          ? payload.durationMs
          : Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
      hostLogFilePath: typeof payload.hostLogFilePath === 'string' ? payload.hostLogFilePath : null,
      serverLogFilePath: null,
    };
  }

  private toAssistantAgentCommandStatus(status: unknown): AssistantAgentCommandResponseDto['status'] {
    switch (status) {
      case 'completed':
      case 'failed':
      case 'timed_out':
      case 'error':
      case 'disabled': {
        return status;
      }
      default: {
        return 'error';
      }
    }
  }

  private async writeAssistantAgentCommandLog(auth: AuthDto, response: AssistantAgentCommandResponseDto) {
    this.storageRepository.mkdirSync(this.assistantAgentCommandLogDirectory);
    const timestamp = response.startedAt.replaceAll(':', '-').replaceAll('.', '-');
    const logFilePath = join(
      this.assistantAgentCommandLogDirectory,
      `${timestamp}-agent-command-${this.cryptoRepository.randomUUID()}.json`,
    );
    const payload = {
      ...response,
      ownerId: auth.user.id,
      serverLogFilePath: logFilePath,
      note:
        'Audited assistant agent command execution. Source-library mutations should still use typed assistant journals and undo paths.',
    };

    await this.storageRepository.createOrOverwriteFile(logFilePath, Buffer.from(JSON.stringify(payload)));
    return logFilePath;
  }

  private async createAssistantMutationJournal(
    auth: AuthDto,
    dto: AssistantMutationRequestDto,
    targetCount: number,
  ): Promise<AssistantChangeJournal> {
    const generatedAt = new Date().toISOString();
    const changeLogFilePath = this.toAssistantChangeJournalPath(generatedAt, dto.actionType);
    const journal: AssistantChangeJournal = {
      version: 1,
      actionType: dto.actionType,
      status: 'planned',
      generatedAt,
      updatedAt: generatedAt,
      ownerId: auth.user.id,
      changeLogFilePath,
      request: {
        ...dto,
        mode: dto.mode ?? 'plan',
        targetCount,
      },
      before: await this.getAssistantMutationBeforeState(auth, dto),
      after: null,
      undo: {
        strategy: 'not_available',
        available: false,
        albumId: null,
        albumName: null,
      },
    };

    await this.writeAssistantChangeJournal(journal);
    return journal;
  }

  private async getAssistantMutationBeforeState(
    auth: AuthDto,
    dto: AssistantMutationRequestDto,
  ): Promise<Record<string, unknown>> {
    switch (dto.actionType) {
      case 'metadata_edit':
      case 'archive_favorite': {
        return { assets: await this.getAssistantAssetSnapshots(auth, this.requireMutationAssetIds(dto)) };
      }

      case 'stack_change': {
        if (dto.stack?.operation === 'create') {
          return { assets: await this.getAssistantAssetSnapshots(auth, this.requireMutationStackAssetIds(dto)) };
        }

        if (!dto.stack?.stackId) {
          throw new BadRequestException('stack.stackId is required for this stack operation');
        }

        return { stack: this.toStackJournalSummary(await BaseService.create(StackService, this).get(auth, dto.stack.stackId)) };
      }

      case 'folder_move': {
        const assetIds = dto.folderMove?.assetIds ?? [];
        return { assets: await this.getAssistantAssetSnapshots(auth, assetIds), destinationPath: dto.folderMove?.destinationPath };
      }

      case 'duplicate_resolution': {
        return { duplicateResolution: dto.duplicateResolution ?? null };
      }
    }
  }

  private async applyAssistantMutation(auth: AuthDto, dto: AssistantMutationRequestDto): Promise<{
    after: Record<string, unknown>;
    undo: AssistantChangeJournal['undo'];
    message: string;
  }> {
    switch (dto.actionType) {
      case 'metadata_edit': {
        const assetIds = this.requireMutationAssetIds(dto);
        await this.applyAssistantMetadataEdit(auth, assetIds, dto.metadata ?? {});
        return {
          after: { assets: await this.getAssistantAssetSnapshots(auth, assetIds) },
          undo: {
            strategy: 'restore_asset_fields',
            available: true,
            albumId: null,
            albumName: null,
            assetIds,
          },
          message: `Applied metadata edits to ${assetIds.length} assets.`,
        };
      }

      case 'archive_favorite': {
        const assetIds = this.requireMutationAssetIds(dto);
        await this.applyAssistantAssetUpdates(auth, assetIds, dto.assetUpdates ?? {});
        return {
          after: { assets: await this.getAssistantAssetSnapshots(auth, assetIds) },
          undo: {
            strategy: 'restore_asset_fields',
            available: true,
            albumId: null,
            albumName: null,
            assetIds,
          },
          message: `Applied archive/favorite updates to ${assetIds.length} assets.`,
        };
      }

      case 'stack_change': {
        return await this.applyAssistantStackChange(auth, dto);
      }

      case 'folder_move':
      case 'duplicate_resolution': {
        throw new BadRequestException('Apply is blocked until a typed undo implementation exists for this action.');
      }
    }
  }

  private async applyAssistantUndo(
    auth: AuthDto,
    journal: AssistantChangeJournal,
  ): Promise<{ targetId: string; targetName: string | null; message: string; [key: string]: unknown }> {
    switch (journal.undo.strategy) {
      case 'delete_created_review_album': {
        if (!journal.undo.albumId || !journal.undo.albumName) {
          throw new BadRequestException('Assistant review album undo is missing album details');
        }
        const albumService = BaseService.create(AlbumService, this);
        const albumBeforeUndo = await albumService.get(auth, journal.undo.albumId);
        await albumService.delete(auth, journal.undo.albumId);
        return {
          targetId: albumBeforeUndo.id,
          targetName: albumBeforeUndo.albumName,
          message: 'Assistant-created review album was deleted. Source assets were not deleted.',
          deletedAlbum: this.toAlbumJournalSummary(albumBeforeUndo),
        };
      }

      case 'restore_asset_fields': {
        const beforeAssets = this.getJournalRecordArray(journal.before, 'assets');
        await this.restoreAssistantAssetSnapshots(auth, beforeAssets);
        return {
          targetId: journal.undo.assetIds?.[0] ?? journal.actionType,
          targetName: null,
          message: `Restored ${beforeAssets.length} assets to their journaled before-state fields.`,
          restoredAssetCount: beforeAssets.length,
        };
      }

      case 'delete_created_stack': {
        if (!journal.undo.stackId) {
          throw new BadRequestException('Assistant stack undo is missing stack ID');
        }
        await BaseService.create(StackService, this).delete(auth, journal.undo.stackId);
        return {
          targetId: journal.undo.stackId,
          targetName: null,
          message: 'Assistant-created stack was deleted. Source assets were not deleted.',
        };
      }

      case 'recreate_deleted_stack': {
        const assetIds = journal.undo.stackAssetIds ?? [];
        if (assetIds.length < 2) {
          throw new BadRequestException('Assistant stack undo is missing stack asset IDs');
        }
        const stack = await BaseService.create(StackService, this).create(auth, { assetIds });
        return {
          targetId: stack.id,
          targetName: null,
          message: 'Deleted stack membership was restored in a new stack.',
          recreatedStack: this.toStackJournalSummary(stack),
        };
      }

      case 'restore_stack_primary': {
        if (!journal.undo.stackId || !journal.undo.primaryAssetId) {
          throw new BadRequestException('Assistant stack primary undo is missing stack details');
        }
        const stack = await BaseService.create(StackService, this).update(auth, journal.undo.stackId, {
          primaryAssetId: journal.undo.primaryAssetId,
        });
        return {
          targetId: stack.id,
          targetName: null,
          message: 'Stack primary asset was restored from the assistant change journal.',
          restoredStack: this.toStackJournalSummary(stack),
        };
      }

      case 'not_available': {
        throw new BadRequestException('Assistant change journal does not have an available undo action');
      }
    }
  }

  private async applyAssistantMetadataEdit(
    auth: AuthDto,
    assetIds: string[],
    metadata: NonNullable<AssistantMutationRequestDto['metadata']>,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: assetIds });
    const exifWrites = this.toDefinedRecord({
      description: metadata.description === null ? '' : metadata.description,
      dateTimeOriginal: metadata.dateTimeOriginal,
      latitude: metadata.latitude,
      longitude: metadata.longitude,
      rating: metadata.rating,
    });

    if (Object.keys(exifWrites).length === 0) {
      throw new BadRequestException('metadata_edit requires at least one metadata field');
    }

    if (
      (Object.hasOwn(exifWrites, 'latitude') && !Object.hasOwn(exifWrites, 'longitude')) ||
      (Object.hasOwn(exifWrites, 'longitude') && !Object.hasOwn(exifWrites, 'latitude'))
    ) {
      throw new BadRequestException('Latitude and longitude must be provided together');
    }

    await this.assetRepository.updateAllExif(assetIds, exifWrites);
    await this.jobRepository.queueAll(assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  }

  private async applyAssistantAssetUpdates(
    auth: AuthDto,
    assetIds: string[],
    updates: NonNullable<AssistantMutationRequestDto['assetUpdates']>,
  ) {
    const assetWrites = this.toDefinedRecord({
      isFavorite: updates.isFavorite,
      visibility: updates.visibility,
    });

    if (Object.keys(assetWrites).length === 0) {
      throw new BadRequestException('archive_favorite requires isFavorite or visibility');
    }

    await BaseService.create(AssetService, this).updateAll(auth, { ids: assetIds, ...assetWrites });
  }

  private async applyAssistantStackChange(
    auth: AuthDto,
    dto: AssistantMutationRequestDto,
  ): Promise<{ after: Record<string, unknown>; undo: AssistantChangeJournal['undo']; message: string }> {
    const stackService = BaseService.create(StackService, this);
    const operation = dto.stack?.operation;

    switch (operation) {
      case 'create': {
        const assetIds = this.requireMutationStackAssetIds(dto);
        const stack = await stackService.create(auth, { assetIds });
        return {
          after: { stack: this.toStackJournalSummary(stack) },
          undo: {
            strategy: 'delete_created_stack',
            available: true,
            albumId: null,
            albumName: null,
            stackId: stack.id,
          },
          message: `Created stack with ${assetIds.length} assets.`,
        };
      }

      case 'delete': {
        if (!dto.stack?.stackId) {
          throw new BadRequestException('stack.stackId is required for delete');
        }
        const stack = await stackService.get(auth, dto.stack.stackId);
        const stackAssetIds = this.toStackAssetIds(stack);
        await stackService.delete(auth, dto.stack.stackId);
        return {
          after: { deletedStack: this.toStackJournalSummary(stack) },
          undo: {
            strategy: 'recreate_deleted_stack',
            available: true,
            albumId: null,
            albumName: null,
            stackId: dto.stack.stackId,
            stackAssetIds,
          },
          message: `Deleted stack ${dto.stack.stackId}.`,
        };
      }

      case 'set_primary': {
        if (!dto.stack?.stackId || !dto.stack.primaryAssetId) {
          throw new BadRequestException('stack.stackId and stack.primaryAssetId are required for set_primary');
        }
        const before = await stackService.get(auth, dto.stack.stackId);
        const stack = await stackService.update(auth, dto.stack.stackId, { primaryAssetId: dto.stack.primaryAssetId });
        return {
          after: { stack: this.toStackJournalSummary(stack) },
          undo: {
            strategy: 'restore_stack_primary',
            available: true,
            albumId: null,
            albumName: null,
            stackId: stack.id,
            primaryAssetId: before.primaryAssetId,
          },
          message: `Updated primary asset for stack ${stack.id}.`,
        };
      }

      default: {
        throw new BadRequestException('stack.operation is required');
      }
    }
  }

  private async getAssistantAssetSnapshots(auth: AuthDto, assetIds: string[]) {
    return await Promise.all(
      assetIds.map(async (id) => this.toAssetJournalSummary((await BaseService.create(AssetService, this).get(auth, id)) as AssetResponseDto)),
    );
  }

  private async restoreAssistantAssetSnapshots(auth: AuthDto, assets: Array<Record<string, unknown>>) {
    const assetIds = assets.map((asset) => this.requireString(asset, 'id'));
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: assetIds });

    for (const asset of assets) {
      const id = this.requireString(asset, 'id');
      await this.assetRepository.updateAll([id], {
        isFavorite: asset.isFavorite as boolean,
        visibility: asset.visibility as AssetVisibility,
      });
      await this.assetRepository.updateAllExif([id], {
        description: (asset.description as string | null) ?? '',
        dateTimeOriginal: (asset.dateTimeOriginal as string | null) ?? null,
        latitude: (asset.latitude as number | null) ?? null,
        longitude: (asset.longitude as number | null) ?? null,
        rating: (asset.rating as number | null) ?? null,
      });
    }

    await this.jobRepository.queueAll(assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  }

  private toAssetJournalSummary(asset: AssetResponseDto): Record<string, unknown> {
    return {
      id: asset.id,
      originalPath: asset.originalPath,
      originalFileName: asset.originalFileName,
      isFavorite: asset.isFavorite,
      visibility: asset.visibility,
      stackId: asset.stack?.id ?? null,
      description: asset.exifInfo?.description ?? '',
      dateTimeOriginal: asset.exifInfo?.dateTimeOriginal ?? null,
      latitude: asset.exifInfo?.latitude ?? null,
      longitude: asset.exifInfo?.longitude ?? null,
      rating: asset.exifInfo?.rating ?? null,
    };
  }

  private toStackJournalSummary(stack: Awaited<ReturnType<StackService['get']>>): Record<string, unknown> {
    return {
      id: stack.id,
      primaryAssetId: stack.primaryAssetId,
      assetIds: this.toStackAssetIds(stack),
      assets: stack.assets.map((asset) => this.toAssetJournalSummary(asset)),
    };
  }

  private toStackAssetIds(stack: Awaited<ReturnType<StackService['get']>>) {
    return stack.assets.map((asset) => asset.id);
  }

  private requireMutationAssetIds(dto: AssistantMutationRequestDto) {
    if (!dto.assetIds || dto.assetIds.length === 0) {
      throw new BadRequestException(`${dto.actionType} requires assetIds`);
    }

    return this.toUniqueStrings(dto.assetIds);
  }

  private requireMutationStackAssetIds(dto: AssistantMutationRequestDto) {
    const assetIds = dto.stack?.assetIds ?? dto.assetIds ?? [];
    const unique = this.toUniqueStrings(assetIds);
    if (unique.length < 2) {
      throw new BadRequestException('stack create requires at least two asset IDs');
    }

    return unique;
  }

  private getAssistantMutationTargetCount(dto: AssistantMutationRequestDto) {
    switch (dto.actionType) {
      case 'metadata_edit':
      case 'archive_favorite': {
        return dto.assetIds?.length ?? 0;
      }
      case 'stack_change': {
        return dto.stack?.assetIds?.length ?? dto.assetIds?.length ?? (dto.stack?.stackId ? 1 : 0);
      }
      case 'folder_move': {
        return dto.folderMove?.assetIds.length ?? 0;
      }
      case 'duplicate_resolution': {
        return dto.duplicateResolution?.groups.length ?? 0;
      }
    }
  }

  private isAssistantMutationApplySupported(dto: AssistantMutationRequestDto) {
    return dto.actionType === 'metadata_edit' || dto.actionType === 'archive_favorite' || dto.actionType === 'stack_change';
  }

  private toDefinedRecord<T extends Record<string, unknown>>(record: T) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
  }

  private getJournalRecordArray(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [];
  }

  private requireString(record: Record<string, unknown>, key: string) {
    const value = record[key];
    if (typeof value !== 'string') {
      throw new BadRequestException(`Assistant change journal is missing ${key}`);
    }

    return value;
  }

  private async createAssistantReviewAlbumJournal(
    auth: AuthDto,
    dto: AssistantReviewAlbumRequestDto,
    assetIds: string[],
  ): Promise<AssistantChangeJournal> {
    const generatedAt = new Date().toISOString();
    const changeLogFilePath = this.toAssistantChangeJournalPath(generatedAt, 'assistant_review_album_create');
    const before = await this.getAssistantReviewAlbumBeforeState(auth, dto.albumName);
    const journal: AssistantChangeJournal = {
      version: 1,
      actionType: 'assistant_review_album_create',
      status: 'planned',
      generatedAt,
      updatedAt: generatedAt,
      ownerId: auth.user.id,
      changeLogFilePath,
      request: {
        albumName: dto.albumName,
        assetCount: assetIds.length,
        assetIds,
        cohortType: dto.cohortType ?? null,
        cohortKey: dto.cohortKey ?? null,
        explicitAssetIds: dto.assetIds ?? [],
      },
      before,
      after: null,
      undo: {
        strategy: 'delete_created_review_album',
        available: false,
        albumId: null,
        albumName: null,
      },
    };

    await this.writeAssistantChangeJournal(journal);
    return journal;
  }

  private async getAssistantReviewAlbumBeforeState(auth: AuthDto, albumName: string): Promise<Record<string, unknown>> {
    const albumService = BaseService.create(AlbumService, this);
    const ownedAlbums = await albumService.getAll(auth, { isOwned: true });
    const matchingAlbums = ownedAlbums.filter((album) => album.albumName === albumName);

    return {
      capturedAt: new Date().toISOString(),
      ownedAlbumCount: ownedAlbums.length,
      matchingAlbumNameCount: matchingAlbums.length,
      matchingAlbums: matchingAlbums.map((album) => this.toAlbumJournalSummary(album)),
    };
  }

  private toAlbumJournalSummary(album: AlbumResponseDto): Record<string, unknown> {
    return {
      id: album.id,
      albumName: album.albumName,
      description: album.description,
      createdAt: album.createdAt,
      updatedAt: album.updatedAt,
      assetCount: album.assetCount,
      startDate: album.startDate,
      endDate: album.endDate,
      shared: album.shared,
      hasSharedLink: album.hasSharedLink,
    };
  }

  private toAssistantChangeJournalPath(generatedAt: string, actionType: AssistantChangeJournal['actionType']) {
    this.storageRepository.mkdirSync(this.assistantChangeJournalDirectory);
    const timestamp = generatedAt.replaceAll(':', '-').replaceAll('.', '-');
    return join(this.assistantChangeJournalDirectory, `${timestamp}-${actionType}-${this.cryptoRepository.randomUUID()}.json`);
  }

  private async writeAssistantChangeJournal(journal: AssistantChangeJournal) {
    this.storageRepository.mkdirSync(this.assistantChangeJournalDirectory);
    await this.storageRepository.createOrOverwriteFile(
      journal.changeLogFilePath,
      Buffer.from(JSON.stringify(journal)),
    );
  }

  private async readAssistantChangeJournal(changeLogFilePath: string): Promise<AssistantChangeJournal> {
    const normalizedDirectory = normalize(this.assistantChangeJournalDirectory);
    const normalizedPath = normalize(changeLogFilePath);
    if (!normalizedPath.startsWith(`${normalizedDirectory}/`) || !normalizedPath.endsWith('.json')) {
      throw new BadRequestException('Assistant change journal path is outside the assistant change-journal directory');
    }

    return await this.storageRepository.readJsonFile<AssistantChangeJournal>(normalizedPath);
  }

  private async getReviewAlbumAssetIds(
    auth: AuthDto,
    dto: AssistantReviewAlbumRequestDto,
  ): Promise<string[]> {
    const explicitAssetIds = this.toUniqueStrings(dto.assetIds ?? []);
    if (explicitAssetIds.length > 0) {
      return explicitAssetIds;
    }

    if (!dto.cohortType || !dto.cohortKey) {
      return [];
    }

    return await this.assetRepository.getAssistantCohortAssetIds(auth.user.id, dto.cohortType, dto.cohortKey);
  }

  private getReviewAlbumDescription(dto: AssistantReviewAlbumRequestDto) {
    const source = dto.cohortType && dto.cohortKey ? `cohort ${dto.cohortType}:${dto.cohortKey}` : 'explicit asset IDs';
    return `Created by Immich Assistant from ${source}.`;
  }

  private getLlmProviders(requested?: AssistantProvider): ProviderConfig[] {
    const { assistant, llm } = this.configRepository.getEnv();
    const providers: ProviderConfig[] = [];
    const pushProvider = (provider: ProviderConfig | undefined) => {
      if (!provider) {
        return;
      }

      const key = `${provider.provider}:${provider.model}`;
      if (!providers.some((item) => `${item.provider}:${item.model}` === key)) {
        providers.push(provider);
      }
    };

    if (requested) {
      pushProvider(this.toProviderConfig(requested, assistant, llm));
      if (providers.length > 0) {
        return providers;
      }
    }

    pushProvider(this.toProviderConfig(assistant.provider, assistant, llm));
    pushProvider(this.toLocalCliProvider('claude-cli', assistant.claude));
    pushProvider(this.toLocalCliProvider('codex-cli', assistant.codex));
    pushProvider(this.toLocalCliProvider('local-cli', assistant.local));

    const provider = llm.provider ?? (llm.openai.apiKey ? 'openai' : llm.anthropic.apiKey ? 'anthropic' : undefined);
    pushProvider(provider ? this.toRemoteProvider(provider, llm) : undefined);

    return providers;
  }

  private toProviderConfig(
    provider: AssistantProvider | undefined,
    assistant: EnvData['assistant'],
    llm: EnvData['llm'],
  ): ProviderConfig | undefined {
    switch (provider) {
      case 'claude-cli': {
        return this.toLocalCliProvider('claude-cli', assistant.claude);
      }
      case 'codex-cli': {
        return this.toLocalCliProvider('codex-cli', assistant.codex);
      }
      case 'openai':
      case 'anthropic': {
        return this.toRemoteProvider(provider, llm);
      }
      default: {
        return undefined;
      }
    }
  }

  private toRemoteProvider(
    provider: Exclude<AssistantProvider, 'claude-cli' | 'codex-cli'>,
    llm: EnvData['llm'],
  ): ProviderConfig | undefined {
    if (!provider || (provider !== 'openai' && provider !== 'anthropic')) {
      return;
    }

    const config = llm[provider];
    if (!config.apiKey) {
      return;
    }

    return { provider, apiKey: config.apiKey, model: config.model };
  }

  private toLocalCliProvider(
    provider: LocalCliProviderConfig['provider'],
    local: { command?: string; args: string[]; url?: string; timeoutSeconds: number },
  ): ProviderConfig | undefined {
    if (!local.command && !local.url) {
      return;
    }

    return {
      provider,
      command: local.command,
      args: local.args,
      url: local.url,
      timeoutSeconds: local.timeoutSeconds,
      model: local.url ?? local.command ?? provider,
    };
  }

  private async getLibraryContext(auth: AuthDto, dto?: AssistantChatRequestDto) {
    const albumService = BaseService.create(AlbumService, this);
    const assetService = BaseService.create(AssetService, this);
    const libraryService = BaseService.create(LibraryService, this);
    const searchService = BaseService.create(SearchService, this);

    const [
      albums,
      recent,
      unorganized,
      statistics,
      unorganizedStatistics,
      timeBuckets,
      cameraMakes,
      cameraModels,
      countries,
      cities,
      libraries,
      libraryAuditSummary,
      sourcePathCohorts,
      dateCohorts,
      eventCohorts,
      cameraCohorts,
      locationCohorts,
      checksumAlgorithmCohorts,
      exactDuplicateCandidates,
      fileTraitDuplicateCandidates,
      videoCohorts,
      mobileAppMetadataCohorts,
    ] = await Promise.all([
      albumService.getAll(auth, { isOwned: true }),
      searchService.searchMetadata(auth, { size: this.assetSampleSize, withExif: true }),
      searchService.searchMetadata(auth, { size: this.assetSampleSize, withExif: true, isNotInAlbum: true }),
      searchService.searchStatistics(auth, {}),
      searchService.searchStatistics(auth, { isNotInAlbum: true }),
      this.assetRepository.getTimeBuckets({
        userIds: [auth.user.id],
        withStacked: true,
        orderBy: AssetOrderBy.TakenAt,
        order: AssetOrder.Desc,
      }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.CAMERA_MAKE }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.CAMERA_MODEL }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.COUNTRY }),
      searchService.getSearchSuggestions(auth, { type: SearchSuggestionType.CITY }),
      libraryService.getAll(),
      this.assetRepository.getAssistantLibraryAuditSummary(auth.user.id),
      this.assetRepository.getAssistantSourcePathCohorts(auth.user.id, this.auditBucketLimit),
      this.assetRepository.getAssistantDateCohorts(auth.user.id, this.auditBucketLimit),
      this.assetRepository.getAssistantEventCohorts(auth.user.id, this.auditBucketLimit),
      this.assetRepository.getAssistantCameraCohorts(auth.user.id, this.auditBucketLimit),
      this.assetRepository.getAssistantLocationCohorts(auth.user.id, this.auditBucketLimit),
      this.assetRepository.getAssistantChecksumAlgorithmCohorts(auth.user.id),
      this.assetRepository.getAssistantExactDuplicateCandidates(auth.user.id, this.duplicateCandidateLimit),
      this.assetRepository.getAssistantFileTraitDuplicateCandidates(auth.user.id, this.duplicateCandidateLimit),
      this.assetRepository.getAssistantVideoCohorts(auth.user.id, this.auditBucketLimit),
      this.assetRepository.getAssistantMobileAppMetadataCohorts(auth.user.id, this.auditBucketLimit),
    ]);
    const sampledAssets = this.toUniqueAssets([...recent.assets.items, ...unorganized.assets.items]);
    const assetMetadata = await this.getAssetMetadataContext(assetService, auth, sampledAssets);
    const externalLibraries = await this.toLibraryContexts(libraryService, libraries);
    const topYears = this.toTopYears(timeBuckets);
    const organizationCoveragePlan = this.toOrganizationCoveragePlan(
      libraryAuditSummary,
      sourcePathCohorts,
      eventCohorts,
    );

    const requestedToolResults = dto ? await this.getAutomaticToolResults(auth, dto) : [];

    return {
      albums: albums.slice(0, 50).map((album) => this.toAlbumContext(album)),
      externalLibraries,
      recentAssets: recent.assets.items.map((asset) => this.toAssetContext(asset, assetMetadata.get(asset.id))),
      unorganizedAssets: unorganized.assets.items.map((asset) => this.toAssetContext(asset, assetMetadata.get(asset.id))),
      sourcePathCohorts: this.toSourcePathCohorts(sampledAssets),
      metadataCoverage: this.toMetadataCoverage(sampledAssets),
      deterministicAudits: {
        checksumSemantics: {
          sha1: 'file-content SHA1 checksum; usable as byte-level duplicate/original evidence',
          'sha1-path':
            'path-derived checksum used by external libraries; useful for source-path identity, not byte-level file integrity',
        },
        librarySummary: libraryAuditSummary,
        sourcePathCohorts: this.toActionableCohorts('source_path', sourcePathCohorts),
        dateCohorts: this.toActionableCohorts('date', dateCohorts),
        eventCohorts: this.toActionableEventCohorts(eventCohorts),
        cameraCohorts: this.toActionableCohorts('camera', cameraCohorts),
        locationCohorts: this.toActionableCohorts('location', locationCohorts),
        checksumAlgorithmCohorts,
        duplicateCandidates: {
          exactContentChecksum: exactDuplicateCandidates,
          matchingFileTraits: fileTraitDuplicateCandidates,
        },
        videoCohorts,
        mobileAppMetadataCohorts,
        organizationCoveragePlan,
        requestedToolResults,
        actionGuidance:
          'For reversible review albums, use organizationCoveragePlan to account for the whole library. Prefer organizationCoveragePlan.coverageExecutionLedger as the ordered queue of exact next steps: ready_for_review_album ledger items become concrete review actions, and needs_decomposition_audit ledger items become exact read-only metadata_audit actions using the provided toolType/toolInput. Source path cohorts are exact source directories, but a source directory can still be a broad container if it has a generic container name or spans many days, places, or cameras. If organizationCoveragePlan.remainingSourcePathReviewCohorts has reviewStrategy=review_album, it can be proposed as a concrete review action with cohortType=source_path and that exact cohortKey. If reviewStrategy=decompose_first or a folder has a generic container name/high generatedLikeCount/smallDimensionCount/dateSpanDays/activeDayCount/distinctPlaceCount/distinctCameraCount, do not propose it as an album yet; propose an exact read-only metadata_search or sidecar_pair_audit tool action with originalPathContains set to that source directory. Never treat No visible location as a reason to leave assets unaddressed. Event cohort assetCount is the materialized review size and includes compatible no-location/date/source-folder support assets; locationAssetCount is only the GPS/place-labeled anchor count. Use cohortType and cohortKey from deterministic cohorts instead of enumerating large asset ID lists. For deeper evidence, propose a read-only tool action with toolType/toolInput so Immich can run content_hash_audit, sidecar_pair_audit, metadata_search, or mobile_original_compare.',
      },
      mutationCapabilities: this.getMutationCapabilities(),
      topYears,
      cameraMakes: this.toStringList(cameraMakes),
      cameraModels: this.toStringList(cameraModels),
      countries: this.toStringList(countries),
      cities: this.toStringList(cities),
      summary: {
        albums: albums.length,
        externalLibraries: externalLibraries.length,
        sampledAssets: sampledAssets.length,
        unorganizedAssets: unorganizedStatistics.total,
      },
      statistics: {
        totalAssets: statistics.total,
        unorganizedAssets: unorganizedStatistics.total,
      },
    };
  }

  private toUniqueAssets(assets: AssetResponseDto[]) {
    const seen = new Set<string>();
    const unique: AssetResponseDto[] = [];
    for (const asset of assets) {
      if (seen.has(asset.id)) {
        continue;
      }
      seen.add(asset.id);
      unique.push(asset);
    }
    return unique;
  }

  private toUniqueStrings(values: string[]) {
    return [...new Set(values)];
  }

  private toActionableCohorts(cohortType: 'source_path' | 'date' | 'camera' | 'location', cohorts: Array<{ key: string }>) {
    return cohorts.map((cohort) => ({
      ...cohort,
      cohortType,
      cohortKey: cohort.key,
    }));
  }

  private toActionableEventCohorts(cohorts: AssistantEventAuditBucket[]) {
    return cohorts.map((cohort) => ({
      ...cohort,
      cohortType: 'event' as const,
      cohortKey: cohort.key,
      title: `${cohort.label} (${this.toDateLabel(cohort.dateStart)} to ${this.toDateLabel(cohort.dateEnd)})`,
      rationale:
        `${cohort.activeDayCount} active days across ${cohort.dateSpanDays} calendar days with ${cohort.assetCount} review assets, anchored by ${cohort.locationAssetCount} location-backed assets and including ${cohort.noLocationAssetCount} no-location support assets. Prefer this over daily albums when organizing a multi-day trip or repeated same-location event.`,
    }));
  }

  private toOrganizationCoveragePlan(
    summary: AssistantLibraryAuditSummary,
    sourcePathCohorts: AssistantLibraryAuditBucket[],
    eventCohorts: AssistantEventAuditBucket[],
  ) {
    const selectedEvents: AssistantOrganizationCoverageItem[] = [];
    const coveredSourcePaths = new Set<string>();

    for (const cohort of eventCohorts) {
      const sourceDirectories = cohort.sourceDirectories ?? [];
      const newSourceDirectories = sourceDirectories.filter((sourceDirectory) => !coveredSourcePaths.has(sourceDirectory));
      if (sourceDirectories.length === 0 || newSourceDirectories.length === 0) {
        continue;
      }

      selectedEvents.push({
        stage: 'event',
        title: `${cohort.label} (${this.toDateLabel(cohort.dateStart)} to ${this.toDateLabel(cohort.dateEnd)})`,
        rationale:
          `Trip/event review cohort anchored by ${cohort.locationAssetCount} GPS/place assets and expanded to include ${cohort.noLocationAssetCount} no-location support assets from the same date/source context.`,
        cohortType: 'event',
        cohortKey: cohort.key,
        assetCount: cohort.assetCount,
        confidence: cohort.confidence,
        gpsAnchorCount: cohort.locationAssetCount,
        noLocationSupportCount: cohort.noLocationAssetCount,
      });

      for (const sourceDirectory of sourceDirectories) {
        coveredSourcePaths.add(sourceDirectory);
      }
    }

    const remainingSourcePathReviewCohorts: AssistantOrganizationCoverageItem[] = sourcePathCohorts
      .filter((cohort) => !coveredSourcePaths.has(cohort.key))
      .map((cohort) => {
        const generatedLikeCount = cohort.generatedLikeCount ?? 0;
        const smallDimensionCount = cohort.smallDimensionCount ?? 0;
        const decompositionReasons = this.toSourcePathDecompositionReasons(cohort);
        const reviewStrategy =
          decompositionReasons.length > 0 ? ('decompose_first' as const) : ('review_album' as const);

        return {
          stage: 'source_path',
          title: cohort.key.replace(/^\/external\/[^/]+\//, ''),
          rationale:
            reviewStrategy === 'decompose_first'
              ? `Container-style source directory: ${decompositionReasons.join('; ')}. Decompose with read-only audits before proposing albums.`
              : 'Older/no-GPS coverage cohort based on the preserved exact source folder. Good reversible review-album candidate before inventing location labels.',
          cohortType: 'source_path',
          cohortKey: cohort.key,
          assetCount: cohort.assetCount,
          confidence: reviewStrategy === 'decompose_first' ? 0.66 : 0.78,
          reviewStrategy,
          generatedLikeCount,
          smallDimensionCount,
          activeDayCount: cohort.activeDayCount,
          dateSpanDays: cohort.dateSpanDays,
          distinctCameraCount: cohort.distinctCameraCount,
          distinctPlaceCount: cohort.distinctPlaceCount,
          decompositionReasons,
        };
      });

    const plannedAssetCount =
      selectedEvents.reduce((sum, item) => sum + item.assetCount, 0) +
      remainingSourcePathReviewCohorts.reduce((sum, item) => sum + item.assetCount, 0);
    const totalAssets = summary.assetCount ?? plannedAssetCount;
    const decompositionAuditCohorts = remainingSourcePathReviewCohorts.filter(
      (item) => item.reviewStrategy === 'decompose_first',
    );
    const reviewAlbumCohorts = remainingSourcePathReviewCohorts.filter((item) => item.reviewStrategy === 'review_album');
    const coverageExecutionLedger = this.toOrganizationCoverageLedger(selectedEvents, remainingSourcePathReviewCohorts);

    return {
      strategy:
        'Full reversible coverage: GPS/place is an anchor for trips, but source folder/date/camera are the primary backbone for older sparse-GPS libraries.',
      totalAssets,
      gpsAssetCount: summary.gpsCount,
      noGpsOrNoVisibleLocationAssetCount: Math.max(0, totalAssets - summary.gpsCount),
      plannedAssetCount,
      unplannedAssetCount: Math.max(0, totalAssets - plannedAssetCount),
      coverageStatusSummary: {
        readyReviewAlbumCount: selectedEvents.length + reviewAlbumCohorts.length,
        readyReviewAssetCount:
          selectedEvents.reduce((sum, item) => sum + item.assetCount, 0) +
          reviewAlbumCohorts.reduce((sum, item) => sum + item.assetCount, 0),
        decompositionAuditCount: decompositionAuditCohorts.length,
        decompositionAuditAssetCount: decompositionAuditCohorts.reduce((sum, item) => sum + item.assetCount, 0),
      },
      selectedEventReviewCohorts: selectedEvents,
      remainingSourcePathReviewCohorts,
      decompositionAuditCohorts,
      reviewAlbumCohorts,
      coverageExecutionLedger,
      selectionRules: [
        'Select non-overlapping event cohorts first when GPS/place evidence identifies a multi-day trip.',
        'Remove source folders already covered by selected event cohorts.',
        'Cover every remaining preserved exact source directory as its own reversible review cohort.',
        'Use reviewStrategy=review_album source directories as concrete review-album candidates.',
        'Use reviewStrategy=decompose_first source directories as exact-folder audit/search candidates before proposing albums.',
        'Use camera cohorts as audit overlays for clock-offset and mixed-camera checks, not as the only organization structure.',
      ],
    };
  }

  private toOrganizationCoverageLedger(
    selectedEvents: AssistantOrganizationCoverageItem[],
    remainingSourcePathReviewCohorts: AssistantOrganizationCoverageItem[],
  ): AssistantOrganizationCoverageLedgerItem[] {
    const eventItems = selectedEvents.map((item) => ({
      ...item,
      reviewStrategy: 'review_album' as const,
    }));
    const orderedItems = [
      ...eventItems,
      ...remainingSourcePathReviewCohorts.filter((item) => item.reviewStrategy === 'decompose_first'),
      ...remainingSourcePathReviewCohorts.filter((item) => item.reviewStrategy === 'review_album'),
    ];

    return orderedItems.map((item, index) => {
      const reviewStrategy = item.reviewStrategy ?? 'review_album';
      const status = reviewStrategy === 'decompose_first' ? 'needs_decomposition_audit' : 'ready_for_review_album';
      return {
        order: index + 1,
        status,
        title: item.title,
        assetCount: item.assetCount,
        rationale: item.rationale,
        cohortType: item.cohortType,
        cohortKey: item.cohortKey,
        reviewStrategy,
        nextAction:
          status === 'needs_decomposition_audit'
            ? {
                type: 'metadata_audit' as const,
                toolType: this.toCoverageDecompositionToolType(item),
                toolInput: { originalPathContains: item.cohortKey },
              }
            : {
                type: 'review' as const,
                albumName: `Review - ${item.title}`,
                cohortType: item.cohortType,
                cohortKey: item.cohortKey,
              },
      };
    });
  }

  private toCoverageDecompositionToolType(
    item: AssistantOrganizationCoverageItem,
  ): 'metadata_search' | 'sidecar_pair_audit' {
    const generatedLikeCount = item.generatedLikeCount ?? 0;
    const smallDimensionCount = item.smallDimensionCount ?? 0;
    const generatedRatio = item.assetCount > 0 ? generatedLikeCount / item.assetCount : 0;
    const folderName = basename(item.cohortKey);
    if (
      generatedRatio >= 0.25 ||
      smallDimensionCount >= 250 ||
      /^(movies?|videos?|home movies|family videos?|photo copies|copies|duplicates?)$/i.test(folderName)
    ) {
      return 'sidecar_pair_audit';
    }

    return 'metadata_search';
  }

  private toSourcePathDecompositionReasons(cohort: AssistantLibraryAuditBucket) {
    const generatedLikeCount = cohort.generatedLikeCount ?? 0;
    const smallDimensionCount = cohort.smallDimensionCount ?? 0;
    const generatedRatio = cohort.assetCount > 0 ? generatedLikeCount / cohort.assetCount : 0;
    const activeDayCount = cohort.activeDayCount ?? 0;
    const dateSpanDays = cohort.dateSpanDays ?? 0;
    const distinctCameraCount = cohort.distinctCameraCount ?? 0;
    const distinctPlaceCount = cohort.distinctPlaceCount ?? 0;
    const folderName = basename(cohort.key);
    const reasons: string[] = [];

    if (this.isGenericSourceContainerName(folderName)) {
      reasons.push(`generic container folder name "${folderName}"`);
    }
    if (cohort.assetCount >= 500) {
      reasons.push(`${cohort.assetCount} assets in one source container`);
    }
    if (generatedRatio >= 0.25) {
      reasons.push(`${generatedLikeCount} generated-like assets`);
    }
    if (smallDimensionCount >= 250) {
      reasons.push(`${smallDimensionCount} small-dimension assets`);
    }
    if (cohort.assetCount >= 100 && activeDayCount >= 3) {
      reasons.push(`${activeDayCount} active capture days`);
    }
    if (cohort.assetCount >= 100 && dateSpanDays >= 7) {
      reasons.push(`${dateSpanDays} day capture span`);
    }
    if (cohort.assetCount >= 100 && distinctPlaceCount >= 2) {
      reasons.push(`${distinctPlaceCount} visible place groups`);
    }
    if (cohort.assetCount >= 100 && distinctCameraCount >= 3) {
      reasons.push(`${distinctCameraCount} camera cohorts`);
    }

    return reasons;
  }

  private isGenericSourceContainerName(folderName: string) {
    const normalized = folderName.trim().toLowerCase();
    return (
      /^(raw )?(photo|photos|picture|pictures|image|images)( \(\d+\))?$/.test(normalized) ||
      /^(raw )?photo and video files$/.test(normalized) ||
      /^(video|videos|movie|movies|home movies|family videos?)$/.test(normalized) ||
      /^(photo copies|copies|duplicates?|library images|camera roll|dcim|gopro|ancestry)$/.test(normalized) ||
      /^random cell phone videos?$/.test(normalized) ||
      /^disney\b/.test(normalized)
    );
  }

  private toDateLabel(value: string | null) {
    return value?.slice(0, 10) ?? 'unknown date';
  }

  private async getAssetMetadataContext(
    assetService: AssetService,
    auth: AuthDto,
    assets: AssetResponseDto[],
  ): Promise<Map<string, AssetMetadataResponseDto[]>> {
    const entries = await Promise.all(
      assets.slice(0, this.assetMetadataSampleSize).map(async (asset) => {
        try {
          const metadata = await assetService.getMetadata(auth, asset.id);
          return [asset.id, metadata] as const;
        } catch (error: unknown) {
          const metadata: AssetMetadataResponseDto[] = [
            {
              key: '_metadata_read_error',
              value: { message: this.getErrorMessage(error) },
              updatedAt: new Date(),
            },
          ];
          return [asset.id, metadata] as const;
        }
      }),
    );

    return new Map(entries);
  }

  private async toLibraryContexts(libraryService: LibraryService, libraries: LibraryResponseDto[]) {
    return await Promise.all(
      libraries.map(async (library) => {
        try {
          const statistics = await libraryService.getStatistics(library.id);
          return { ...this.toLibraryContext(library), statistics };
        } catch (error: unknown) {
          return { ...this.toLibraryContext(library), statistics: null, error: this.getErrorMessage(error) };
        }
      }),
    );
  }

  private toLibraryContext(library: LibraryResponseDto) {
    return {
      id: library.id,
      ownerId: library.ownerId,
      name: library.name,
      assetCount: library.assetCount,
      importPaths: library.importPaths,
      exclusionPatterns: library.exclusionPatterns,
      refreshedAt: library.refreshedAt,
    };
  }

  private toAlbumContext(album: AlbumResponseDto) {
    return {
      id: album.id,
      name: album.albumName,
      description: album.description,
      assetCount: album.assetCount,
      startDate: album.startDate,
      endDate: album.endDate,
    };
  }

  private toAssetContext(asset: AssetResponseDto, metadata: AssetMetadataResponseDto[] = []) {
    const exif = asset.exifInfo;

    return {
      id: asset.id,
      type: asset.type,
      libraryId: asset.libraryId ?? null,
      isExternal: asset.originalPath?.startsWith('/external/') ?? false,
      originalPath: asset.originalPath,
      originalFileName: asset.originalFileName,
      originalMimeType: asset.originalMimeType ?? null,
      checksum: asset.checksum,
      fileCreatedAt: asset.fileCreatedAt,
      fileModifiedAt: asset.fileModifiedAt,
      localDateTime: asset.localDateTime,
      uploadedAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      isFavorite: asset.isFavorite,
      isArchived: asset.visibility === AssetVisibility.Archive,
      isOffline: asset.isOffline,
      isEdited: asset.isEdited,
      hasMetadata: asset.hasMetadata,
      exif: {
        fileSizeInByte: exif?.fileSizeInByte ?? null,
        imageWidth: exif?.exifImageWidth ?? asset.width,
        imageHeight: exif?.exifImageHeight ?? asset.height,
        make: exif?.make ?? null,
        model: exif?.model ?? null,
        lensModel: exif?.lensModel ?? null,
        dateTimeOriginal: exif?.dateTimeOriginal ?? null,
        modifyDate: exif?.modifyDate ?? null,
        timeZone: exif?.timeZone ?? null,
        orientation: exif?.orientation ?? null,
        latitude: exif?.latitude ?? null,
        longitude: exif?.longitude ?? null,
        city: exif?.city ?? null,
        state: exif?.state ?? null,
        country: exif?.country ?? null,
        hasGps: typeof exif?.latitude === 'number' && typeof exif.longitude === 'number',
        hasCamera: !!(exif?.make || exif?.model),
        description: exif?.description ?? null,
      },
      assetMetadata: metadata.map((item) => ({
        key: item.key,
        value: item.value,
        updatedAt: item.updatedAt,
      })),
      tags: asset.tags?.map((tag) => tag.value) ?? [],
    };
  }

  private toSourcePathCohorts(assets: AssetResponseDto[]) {
    const counts = new Map<string, { count: number; examples: string[] }>();
    for (const asset of assets) {
      const bucket = this.toSourcePathBucket(asset.originalPath);
      const current = counts.get(bucket) ?? { count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 5) {
        current.examples.push(asset.originalPath);
      }
      counts.set(bucket, current);
    }

    return [...counts.entries()]
      .map(([path, { count, examples }]) => ({ path, count, examples }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);
  }

  private toSourcePathBucket(originalPath: string) {
    const parts = originalPath.split('/').filter(Boolean);
    const externalIndex = parts.indexOf('external');
    if (externalIndex !== -1) {
      return `/${parts.slice(0, Math.min(parts.length - 1, externalIndex + 3)).join('/')}`;
    }

    return originalPath.slice(0, Math.max(0, originalPath.lastIndexOf('/'))) || originalPath;
  }

  private toMetadataCoverage(assets: AssetResponseDto[]) {
    const total = assets.length || 1;
    const count = (predicate: (asset: AssetResponseDto) => boolean) => assets.filter((asset) => predicate(asset)).length;
    const withExif = count((asset) => !!asset.exifInfo);
    const withFileSize = count((asset) => typeof asset.exifInfo?.fileSizeInByte === 'number');
    const withChecksum = count((asset) => !!asset.checksum);
    const withOriginalPath = count((asset) => !!asset.originalPath);
    const withDimensions = count((asset) => typeof asset.width === 'number' && typeof asset.height === 'number');
    const withGps = count(
      (asset) => typeof asset.exifInfo?.latitude === 'number' && typeof asset.exifInfo.longitude === 'number',
    );
    const withCamera = count((asset) => !!(asset.exifInfo?.make || asset.exifInfo?.model));

    return {
      sampledAssets: assets.length,
      withExif,
      withFileSize,
      withChecksum,
      withOriginalPath,
      withDimensions,
      withGps,
      withCamera,
      percentages: {
        withExif: Math.round((withExif / total) * 100),
        withFileSize: Math.round((withFileSize / total) * 100),
        withChecksum: Math.round((withChecksum / total) * 100),
        withOriginalPath: Math.round((withOriginalPath / total) * 100),
        withDimensions: Math.round((withDimensions / total) * 100),
        withGps: Math.round((withGps / total) * 100),
        withCamera: Math.round((withCamera / total) * 100),
      },
    };
  }

  private async getAutomaticToolResults(
    auth: AuthDto,
    dto: AssistantChatRequestDto,
  ): Promise<Array<Record<string, unknown>>> {
    const latest = dto.messages.toReversed().find((message) => message.role === 'user')?.content.toLowerCase() ?? '';
    const toolRequests: AssistantToolRequestDto[] = [];

    if (/\b(byte|hash|checksum|integrity|content checksum|sha1)\b/.test(latest)) {
      toolRequests.push({ toolType: 'content_hash_audit', input: {} });
    }

    if (/\b(sidecar|aae|xmp|json|rendered|edited pair|variant|original pair)\b/.test(latest)) {
      toolRequests.push({ toolType: 'sidecar_pair_audit', input: {} });
    }

    if (/\b(mobile|iphone|ios|phone upload|desktop export|desktop original)\b/.test(latest)) {
      toolRequests.push({
        toolType: 'mobile_original_compare',
        input: { desktopSourcePrefix: '/external/desktop-icloud-originals' },
      });
    }

    if (toolRequests.length === 0 || toolRequests.length > 2) {
      return [];
    }

    const results = await Promise.all(toolRequests.map((request) => this.runTool(auth, request)));
    return results.map((result) => ({
      toolType: result.toolType,
      generatedAt: result.generatedAt,
      summary: result.summary,
      resultCount: result.resultCount ?? result.results.length,
      errorCount: result.errorCount ?? result.errors.length,
      logFilePath: result.logFilePath ?? null,
      fullResultsAvailableByRunningToolAction: true,
    }));
  }

  private async runContentHashAudit(
    auth: AuthDto,
    dto: AssistantToolRequestDto,
  ): Promise<AssistantToolResponseDto> {
    const filters = this.toAuditAssetSearch(dto.input);
    const totalMatchingAssets = await this.assetRepository.getAssistantAuditAssetCount(auth.user.id, filters);
    const scannedAssets = await this.assetRepository.getAssistantAuditAssets(auth.user.id, filters);
    const errors: AssistantToolResponseDto['errors'] = [];
    const hashedResults: Array<Record<string, unknown>> = [];
    const duplicateGroups = new Map<string, Array<Record<string, unknown>>>();

    for (const asset of scannedAssets) {
      try {
        const actualChecksumBuffer = await this.cryptoRepository.hashFile(asset.originalPath);
        const actualChecksum = actualChecksumBuffer.toString('base64');
        const storedChecksumMatches =
          asset.checksumAlgorithm === 'sha1' && asset.storedChecksum ? actualChecksum === asset.storedChecksum : null;
        const result = {
          assetId: asset.id,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          type: asset.type,
          checksumAlgorithm: asset.checksumAlgorithm,
          storedChecksum: asset.storedChecksum,
          actualSha1: actualChecksum,
          storedChecksumMatches,
          fileSizeInByte: asset.fileSizeInByte,
          width: asset.width,
          height: asset.height,
          dateTimeOriginal: asset.dateTimeOriginal,
          make: asset.make,
          model: asset.model,
        };
        hashedResults.push(result);
        const group = duplicateGroups.get(actualChecksum) ?? [];
        group.push({
          assetId: asset.id,
          originalPath: asset.originalPath,
          fileSizeInByte: asset.fileSizeInByte,
          width: asset.width,
          height: asset.height,
        });
        duplicateGroups.set(actualChecksum, group);
      } catch (error: unknown) {
        errors.push({
          assetId: asset.id,
          originalPath: asset.originalPath,
          reason: this.getErrorMessage(error),
        });
      }
    }

    const exactContentDuplicateGroups = [...duplicateGroups.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([actualSha1, assets]) => ({ actualSha1, assetCount: assets.length, assets }));

    return {
      toolType: dto.toolType,
      generatedAt: new Date().toISOString(),
      summary: {
        totalMatchingAssets,
        scannedAssets: scannedAssets.length,
        hashedAssets: hashedResults.length,
        errorCount: errors.length,
        complete: totalMatchingAssets === scannedAssets.length,
        storedSha1ComparableAssets: hashedResults.filter((item) => item.storedChecksumMatches !== null).length,
        storedSha1MismatchCount: hashedResults.filter((item) => item.storedChecksumMatches === false).length,
        exactContentDuplicateGroupCount: exactContentDuplicateGroups.length,
        note:
          'This reads originalPath bytes from disk and computes fresh SHA1. sha1-path database checksums are not treated as byte-level evidence.',
      },
      results: [...exactContentDuplicateGroups, ...hashedResults],
      errors,
    };
  }

  private async runSidecarPairAudit(
    auth: AuthDto,
    dto: AssistantToolRequestDto,
  ): Promise<AssistantToolResponseDto> {
    const filters = this.toAuditAssetSearch(dto.input);
    const totalMatchingAssets = await this.assetRepository.getAssistantAuditAssetCount(auth.user.id, filters);
    const scannedAssets = await this.assetRepository.getAssistantAuditAssets(auth.user.id, filters);
    const assetsByDirectory = new Map<string, AssistantAuditAsset[]>();
    const sidecarExtensions = new Set(['.aae', '.xmp', '.json']);
    const livePhotoExtensions = new Set(['.mov']);
    const errors: AssistantToolResponseDto['errors'] = [];
    const sidecarMatches: Array<Record<string, unknown>> = [];
    const probableRenderedPairs: Array<Record<string, unknown>> = [];

    for (const asset of scannedAssets) {
      const directory = dirname(asset.originalPath);
      const directoryAssets = assetsByDirectory.get(directory) ?? [];
      directoryAssets.push(asset);
      assetsByDirectory.set(directory, directoryAssets);
    }

    const directories = [...assetsByDirectory.keys()];
    let sidecarFileCount = 0;
    let orphanSidecarCount = 0;

    for (const directory of directories) {
      const directoryAssets = assetsByDirectory.get(directory) ?? [];
      const assetBaseNames = new Map<string, AssistantAuditAsset[]>();
      for (const asset of directoryAssets) {
        const normalized = this.toNormalizedOriginalBase(asset.originalFileName);
        const group = assetBaseNames.get(normalized) ?? [];
        group.push(asset);
        assetBaseNames.set(normalized, group);
      }

      try {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) {
            continue;
          }

          const extension = extname(entry.name).toLowerCase();
          if (!sidecarExtensions.has(extension) && !livePhotoExtensions.has(extension)) {
            continue;
          }

          const normalized = this.toNormalizedOriginalBase(entry.name);
          const entryPath = join(directory, entry.name);
          const matchedAssets = (assetBaseNames.get(normalized) ?? []).filter((asset) =>
            livePhotoExtensions.has(extension) ? asset.originalPath !== entryPath && asset.type !== 'VIDEO' : true,
          );
          if (sidecarExtensions.has(extension)) {
            sidecarFileCount += 1;
            if (matchedAssets.length === 0) {
              orphanSidecarCount += 1;
            }
          }

          if (matchedAssets.length > 0) {
            sidecarMatches.push({
              directory,
              sidecarName: entry.name,
              sidecarType: sidecarExtensions.has(extension) ? extension.slice(1).toUpperCase() : 'MOV paired media',
              matchedAssets: matchedAssets.map((asset) => ({
                assetId: asset.id,
                originalPath: asset.originalPath,
                originalFileName: asset.originalFileName,
                type: asset.type,
              })),
            });
          }
        }
      } catch (error: unknown) {
        errors.push({ directory, reason: this.getErrorMessage(error) });
      }

      for (const [normalizedBase, group] of assetBaseNames) {
        if (group.length <= 1) {
          continue;
        }

        probableRenderedPairs.push({
          directory,
          normalizedBase,
          assetCount: group.length,
          assets: group.map((asset) => ({
            assetId: asset.id,
            originalFileName: asset.originalFileName,
            originalPath: asset.originalPath,
            fileSizeInByte: asset.fileSizeInByte,
            width: asset.width,
            height: asset.height,
            dateTimeOriginal: asset.dateTimeOriginal,
            isEdited: asset.isEdited,
          })),
        });
      }
    }

    return {
      toolType: dto.toolType,
      generatedAt: new Date().toISOString(),
      summary: {
        totalMatchingAssets,
        scannedAssets: scannedAssets.length,
        complete: totalMatchingAssets === scannedAssets.length,
        directoriesFound: assetsByDirectory.size,
        directoriesScanned: directories.length,
        sidecarFileCount,
        sidecarMatchCount: sidecarMatches.length,
        orphanSidecarCount,
        probableRenderedPairCount: probableRenderedPairs.length,
      },
      results: [...sidecarMatches, ...probableRenderedPairs],
      errors,
    };
  }

  private async runMetadataSearch(
    auth: AuthDto,
    dto: AssistantToolRequestDto,
  ): Promise<AssistantToolResponseDto> {
    const filters = this.toAuditAssetSearch(dto.input);
    const totalMatchingAssets = await this.assetRepository.getAssistantAuditAssetCount(auth.user.id, filters);
    const scannedAssets = await this.assetRepository.getAssistantAuditAssets(auth.user.id, filters);

    return {
      toolType: dto.toolType,
      generatedAt: new Date().toISOString(),
      summary: {
        totalMatchingAssets,
        returnedAssets: scannedAssets.length,
        complete: totalMatchingAssets === scannedAssets.length,
        filters: dto.input ?? {},
        breakdown: this.toMetadataSearchBreakdown(scannedAssets),
      },
      results: scannedAssets.map((asset) => this.toAuditAssetResult(asset)),
      errors: [],
    };
  }

  private toMetadataSearchBreakdown(assets: AssistantAuditAsset[]) {
    return {
      dates: this.toAuditAssetBreakdown(assets, (asset) => asset.localDateTime?.slice(0, 10) ?? 'Unknown date'),
      cameras: this.toAuditAssetBreakdown(
        assets,
        (asset) => `${asset.make || 'Unknown make'} ${asset.model || 'Unknown model'}`,
      ),
      places: this.toAuditAssetBreakdown(
        assets,
        (asset) =>
          asset.country || asset.state || asset.city
            ? [asset.country, asset.state, asset.city].filter(Boolean).join(' / ')
            : 'No visible location',
      ),
      mediaTypes: this.toAuditAssetBreakdown(assets, (asset) => asset.type),
      fileExtensions: this.toAuditAssetBreakdown(assets, (asset) => extname(asset.originalFileName).toLowerCase()),
    };
  }

  private toAuditAssetBreakdown(assets: AssistantAuditAsset[], getKey: (asset: AssistantAuditAsset) => string) {
    const buckets = new Map<string, { label: string; count: number; examples: string[] }>();

    for (const asset of assets) {
      const label = getKey(asset) || 'Unknown';
      const bucket = buckets.get(label) ?? { label, count: 0, examples: [] };
      bucket.count += 1;
      if (bucket.examples.length < 3) {
        bucket.examples.push(asset.originalPath);
      }
      buckets.set(label, bucket);
    }

    return [...buckets.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 25);
  }

  private async runMobileOriginalCompare(
    auth: AuthDto,
    dto: AssistantToolRequestDto,
  ): Promise<AssistantToolResponseDto> {
    const input = dto.input ?? {};
    const desktopSourcePrefix = input.desktopSourcePrefix ?? '/external/desktop-icloud-originals';
    const results = await this.assetRepository.getAssistantMobileOriginalComparison(
      auth.user.id,
      desktopSourcePrefix,
    );

    return {
      toolType: dto.toolType,
      generatedAt: new Date().toISOString(),
      summary: {
        desktopSourcePrefix,
        mobileCohortCount: results.length,
        mobileAssetCount: results.reduce((sum, result) => sum + result.mobileAssetCount, 0),
        referenceAssetCount: results.reduce((sum, result) => sum + result.referenceAssetCount, 0),
        exactTraitMatchCount: results.reduce((sum, result) => sum + result.exactTraitMatchCount, 0),
        sizeMismatchCount: results.reduce((sum, result) => sum + result.sizeMismatchCount, 0),
        dimensionsMismatchCount: results.reduce((sum, result) => sum + result.dimensionsMismatchCount, 0),
        dateMismatchCount: results.reduce((sum, result) => sum + result.dateMismatchCount, 0),
        cameraMismatchCount: results.reduce((sum, result) => sum + result.cameraMismatchCount, 0),
        note:
          'Comparison is based on mobile-app metadata assets matched to desktop external-library references by filename, then file size, dimensions, EXIF date, make, and model.',
      },
      results: results as unknown as Array<Record<string, unknown>>,
      errors: [],
    };
  }

  private toAuditAssetSearch(input: AssistantToolRequestDto['input'] = {}): AssistantAuditAssetSearch {
    return {
      cohortType: input.cohortType,
      cohortKey: input.cohortKey,
      originalPathContains: this.toOptionalValue(input.originalPathContains),
      originalFileNameContains: this.toOptionalValue(input.originalFileNameContains),
      fileExtension: this.toOptionalValue(input.fileExtension),
      checksumAlgorithm: this.toOptionalValue(input.checksumAlgorithm),
      type: this.toOptionalValue(input.type),
      takenAfter: this.toOptionalValue(input.takenAfter),
      takenBefore: this.toOptionalValue(input.takenBefore),
      make: this.toOptionalValue(input.make),
      model: this.toOptionalValue(input.model),
      country: this.toOptionalValue(input.country),
      state: this.toOptionalValue(input.state),
      city: this.toOptionalValue(input.city),
      noGps: this.toOptionalValue(input.noGps),
      unknownCamera: this.toOptionalValue(input.unknownCamera),
      hasMobileMetadata: this.toOptionalValue(input.hasMobileMetadata),
    };
  }

  private toOptionalValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }

  private toAuditAssetResult(asset: AssistantAuditAsset): Record<string, unknown> {
    return {
      assetId: asset.id,
      type: asset.type,
      originalPath: asset.originalPath,
      originalFileName: asset.originalFileName,
      checksumAlgorithm: asset.checksumAlgorithm,
      storedChecksum: asset.storedChecksum,
      isExternal: asset.isExternal,
      isEdited: asset.isEdited,
      fileSizeInByte: asset.fileSizeInByte,
      width: asset.width,
      height: asset.height,
      duration: asset.duration,
      localDateTime: asset.localDateTime,
      dateTimeOriginal: asset.dateTimeOriginal,
      make: asset.make,
      model: asset.model,
      latitude: asset.latitude,
      longitude: asset.longitude,
      city: asset.city,
      state: asset.state,
      country: asset.country,
      mobileAppMetadata: asset.mobileAppMetadata,
    };
  }

  private toNormalizedOriginalBase(filename: string) {
    return basename(filename, extname(filename))
      .toLowerCase()
      .replace(/\s*\(\d+\)$/, '')
      .replace(/[-_\s.]+(edited|edit|adjusted|rendered|copy|fullsizeoutput_[a-f0-9]+)$/i, '')
      .replace(/^img_e(\d+)$/i, 'img_$1');
  }

  private buildPrompt(
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ) {
    return {
      instruction:
        'You are an in-app Immich photo library assistant for organizing very large photo and video libraries. Help assess metadata, source cohorts, time ranges, locations, albums, folders, review queues, duplicates, video metadata, and original-file risks using the provided library context. Prefer deterministicAudits over the sampled assets when discussing whole-library counts, cohorts, duplicate candidates, videos, mobile upload audit coverage, and review-album candidates. Use deterministicAudits.organizationCoveragePlan as the first source for whole-library organization because it is designed to account for every asset. For whole-library organization, follow organizationCoveragePlan.coverageExecutionLedger as the ordered ledger of exact next steps. Explain the coverageStatusSummary, then propose the first useful executable actions from the ledger: ready_for_review_album items become concrete review actions, and needs_decomposition_audit items become metadata_audit actions with the ledger nextAction toolType/toolInput. For older libraries with sparse GPS, GPS is only an anchor signal; source folders, capture dates, and camera cohorts are the primary organization backbone. SourcePathCohorts are exact source directories, but exact source directories are not automatically albums: if a source folder has a generic container name or spans many days, places, cameras, or trips, treat it as a container that must be decomposed before album creation. For organizationCoveragePlan.remainingSourcePathReviewCohorts, reviewStrategy=review_album means the item may become a concrete review action; reviewStrategy=decompose_first means the item needs an exact-folder metadata_search or sidecar_pair_audit action first, with toolInput.originalPathContains set to the cohortKey. Never recommend leaving the no-GPS or No visible location majority unaddressed when the user asks to organize the entire library. Prefer deterministicAudits.eventCohorts for multi-day trips, same-location travel, and event-style organization; do not split a trip into daily albums when a higher-confidence event cohort covers the same date/location span. Event cohort assetCount is the materialized review-album size, which includes compatible no-location assets in the event date span plus assets from source folders anchored by GPS/place evidence; locationAssetCount is only the GPS/place anchor count. When the user asks whether nearby days should be included, compare eventCohorts with dateCohorts/sourcePathCohorts/requestedToolResults and explicitly call out adjacent no-location days as review candidates rather than ignoring them. Daily dateCohorts/sourcePathCohorts are fallback coverage units after event cohorts, not discarded leftovers. When deterministicAudits.requestedToolResults is present, treat it as server-run evidence from the current user request; it contains the full tool summary, result count, error count, and logFilePath when large row-level output was written to disk. Full row-level results remain available through a tool action and, when present, the JSON audit log. When proposing a concrete reversible review album from deterministicAudits, use action.type=review, set action.cohortType and action.cohortKey to one exact cohort, and leave assetIds empty unless the action is based on explicit sampled assets. Do not put albumName, assetIds, cohortType, or cohortKey on broad album_plan, metadata_audit, original_file_audit, folder_plan, or search actions; those are not single album mutations. For broad coverage plans, describe the sequence and propose individual review actions for the first concrete cohorts only. When more evidence is needed, include action.toolType and action.toolInput for one of the read-only Immich tools: content_hash_audit, sidecar_pair_audit, metadata_search, or mobile_original_compare. When the deterministic Immich tools are not enough, propose action.type=agent_command with a concrete read-only shell command, target, cwd, and timeoutSeconds. Use target=local for Mac host tools and mounted Desktop paths, target=synology for NAS data under /volume1 over ssh -p 22222 hausmanj@drhaus, and target=immich for commands inside the Immich server container such as inspecting /data logs or /external container mounts. Agent command actions can use tools such as exiftool, osxphotos, find, file, shasum, sqlite, jq, ffprobe, docker-visible paths, or purpose-built scripts. For physical organization outside Immich, prefer node tools/photo-file-organizer.mjs reconcile-plan/plan/apply/undo over ad hoc mv/cp because it creates complete plans, typed journals, and undo records. Use reconcile-plan when comparing backup folders to an existing originals tree: it uses content SHA1 to route existing photos to a duplicates quarantine and new photos to date-prefixed event folders. Agent command actions are powerful operator commands: default to read-only inventory, metadata extraction, hashing, grouping, and report generation. Treat impactful organization changes as requiring read-only evidence first plus a persisted assistant change journal and undo path before the change is considered safe. Use mutationCapabilities to distinguish executable journaled mutations from plan-only blocked mutations: metadata_edit, archive_favorite, and stack_change are currently applyable with typed undo; folder_move and duplicate_resolution are registered but apply-blocked until a reliable typed undo exists. Treat checksumAlgorithm=sha1 as file-content evidence and checksumAlgorithm=sha1-path as external-library path identity, not byte-level integrity. When a field is absent from the provided context, say it is not visible in the assistant context; do not claim it is missing from the source file or Immich database. Do not suggest tagging unless the user explicitly asks for tags. Do not claim any change has been applied. Prefer reversible, review-first organization. Never suggest deleting assets unless the user explicitly asks about deletion.',
      userContent: JSON.stringify({
        libraryContext: this.toCompactLibraryContext(context),
        conversation: dto.messages,
      }),
    };
  }

  private toCompactLibraryContext(context: Awaited<ReturnType<AssistantService['getLibraryContext']>>) {
    const audits = context.deterministicAudits;
    const duplicateCandidates = audits.duplicateCandidates;
    return {
      summary: context.summary,
      statistics: context.statistics,
      externalLibraries: context.externalLibraries,
      mutationCapabilities: context.mutationCapabilities,
      topYears: this.toCompactList(context.topYears, 20),
      cameraMakes: this.toCompactList(context.cameraMakes, 20),
      cameraModels: this.toCompactList(context.cameraModels, 20),
      countries: this.toCompactList(context.countries, 20),
      cities: this.toCompactList(context.cities, 20),
      metadataCoverage: context.metadataCoverage,
      recentAssets: this.toCompactList(context.recentAssets, 10),
      unorganizedAssets: this.toCompactList(context.unorganizedAssets, 10),
      deterministicAudits: {
        checksumSemantics: audits.checksumSemantics,
        librarySummary: audits.librarySummary,
        checksumAlgorithmCohorts: audits.checksumAlgorithmCohorts,
        organizationCoveragePlan: this.toCompactCoveragePlan(audits.organizationCoveragePlan),
        eventCohorts: this.toCompactList(audits.eventCohorts, 15),
        sourcePathCohorts: this.toCompactList(audits.sourcePathCohorts, 35),
        dateCohorts: this.toCompactList(audits.dateCohorts, 25),
        cameraCohorts: this.toCompactList(audits.cameraCohorts, 20),
        locationCohorts: this.toCompactList(audits.locationCohorts, 20),
        duplicateCandidates: {
          exactContentChecksum: this.toCompactList(duplicateCandidates?.exactContentChecksum, 20),
          matchingFileTraits: this.toCompactList(duplicateCandidates?.matchingFileTraits, 20),
        },
        videoCohorts: this.toCompactList(audits.videoCohorts, 20),
        mobileAppMetadataCohorts: this.toCompactList(audits.mobileAppMetadataCohorts, 20),
        requestedToolResults: this.toCompactList(audits.requestedToolResults, 20).map((result) =>
          this.toCompactToolResult(result),
        ),
        actionGuidance: audits.actionGuidance,
      },
    };
  }

  private toCompactCoveragePlan(plan: AssistantOrganizationCoveragePlan | null | undefined) {
    return {
      ...(plan ?? {}),
      selectedEventReviewCohorts: this.toCompactList(plan?.selectedEventReviewCohorts, 8),
      remainingSourcePathReviewCohorts: this.toCompactList(plan?.remainingSourcePathReviewCohorts, 35),
      coverageExecutionLedger: this.toCompactList(plan?.coverageExecutionLedger, 30),
    };
  }

  private toCompactToolResult(result: AssistantToolResponseDto) {
    return {
      toolType: result.toolType,
      generatedAt: result.generatedAt,
      summary: result.summary,
      resultCount: result.resultCount,
      errorCount: result.errorCount,
      logFilePath: result.logFilePath,
      logFileFormat: result.logFileFormat,
      inlineResultsOmitted: result.inlineResultsOmitted,
      results: this.toCompactList(result.results, 10),
      errors: this.toCompactList(result.errors, 5),
    };
  }

  private toCompactList<T>(value: T[] | null | undefined, limit: number): T[] {
    return Array.isArray(value) ? value.slice(0, limit) : [];
  }

  private buildOpenAiInput(
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ) {
    const prompt = this.buildPrompt(dto, context);
    return [
      {
        role: 'system',
        content: prompt.instruction,
      },
      {
        role: 'user',
        content: prompt.userContent,
      },
    ];
  }

  private async callOpenAi(
    { apiKey, model }: RemoteProviderConfig,
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ): Promise<AssistantModelOutput> {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: this.buildOpenAiInput(dto, context),
        max_output_tokens: 1600,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'immich_assistant_response',
            strict: true,
            schema: assistantOutputSchema,
          },
        },
      }),
    });

    const payload = await this.readLlmResponse(response);
    return this.parseJsonOrText(this.findOpenAiOutputText(payload)) as AssistantModelOutput;
  }

  private async callAnthropic(
    { apiKey, model }: RemoteProviderConfig,
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ): Promise<AssistantModelOutput> {
    const prompt = this.buildPrompt(dto, context);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1600,
        system: prompt.instruction,
        messages: [{ role: 'user', content: prompt.userContent }],
        tools: [
          {
            name: 'immich_assistant_response',
            description: 'Return a structured Immich assistant response.',
            input_schema: assistantOutputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'immich_assistant_response' },
      }),
    });

    const payload = await this.readLlmResponse(response);
    const toolUse = this.isRecord(payload)
      ? Array.isArray(payload.content)
        ? payload.content.find(
            (item) => this.isRecord(item) && item.type === 'tool_use' && item.name === 'immich_assistant_response',
          )
        : undefined
      : undefined;

    if (this.isRecord(toolUse) && this.isRecord(toolUse.input)) {
      return toolUse.input as AssistantModelOutput;
    }

    const text =
      this.isRecord(payload) && Array.isArray(payload.content)
        ? payload.content
            .filter((item) => this.isRecord(item) && item.type === 'text' && typeof item.text === 'string')
            .map((item) => (this.isRecord(item) && typeof item.text === 'string' ? item.text : ''))
            .join('\n')
        : '';
    return this.parseJsonOrText(text);
  }

  private buildLocalAssistantInput(
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ) {
    const prompt = this.buildPrompt(dto, context);
    return [
      prompt.instruction,
      '',
      'Return only JSON matching this schema:',
      JSON.stringify(assistantOutputSchema),
      '',
      'Library context and conversation:',
      prompt.userContent,
    ].join('\n');
  }

  private async callLocalAssistant(
    config: LocalCliProviderConfig,
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ): Promise<AssistantModelOutput> {
    const input = this.buildLocalAssistantInput(dto, context);
    return config.url ? await this.callLocalBridge(config, input) : await this.callLocalCli(config, input);
  }

  private async callLocalBridge(
    { url, timeoutSeconds }: LocalCliProviderConfig,
    input: string,
  ): Promise<AssistantModelOutput> {
    if (!url) {
      throw new Error('Local assistant bridge URL is not configured');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, timeoutSeconds }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    const payload = await this.readLlmResponse(response);
    return this.normalizeAssistantOutput(payload);
  }

  private async callLocalCli(
    { command, args, timeoutSeconds }: LocalCliProviderConfig,
    input: string,
  ): Promise<AssistantModelOutput> {
    if (!command) {
      throw new Error('Local assistant command is not configured');
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Local assistant command timed out after ${timeoutSeconds} seconds`));
      }, timeoutSeconds * 1000);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString('utf8').trim();
        const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new Error(`Local assistant command exited with ${code}: ${errorOutput || output}`));
          return;
        }

        resolve(this.parseJsonOrText(output));
      });

      child.stdin.end(input);
    });
  }

  private async readLlmResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }

    if (!response.ok) {
      throw new Error(`Provider request failed with ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
  }

  private findOpenAiOutputText(payload: unknown): string {
    if (!this.isRecord(payload)) {
      return '';
    }

    if (typeof payload.output_text === 'string') {
      return payload.output_text;
    }

    const chunks: string[] = [];
    if (!Array.isArray(payload.output)) {
      return '';
    }

    for (const item of payload.output) {
      if (!this.isRecord(item) || !Array.isArray(item.content)) {
        continue;
      }

      for (const content of item.content) {
        if (this.isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
          chunks.push(content.text);
        }
      }
    }
    return chunks.join('\n');
  }

  private parseJsonOrText(text: string): AssistantModelOutput {
    try {
      return this.normalizeAssistantOutput(JSON.parse(text));
    } catch {
      return { answer: text, actions: [] };
    }
  }

  private normalizeAssistantOutput(output: unknown): AssistantModelOutput {
    if (typeof output === 'string') {
      return this.parseJsonOrText(output);
    }

    if (!this.isRecord(output)) {
      return { answer: String(output), actions: [] };
    }

    if ('answer' in output || 'actions' in output) {
      return output as AssistantModelOutput;
    }

    for (const key of ['stdout', 'result', 'output', 'output_text', 'text', 'message']) {
      const value = output[key];
      if (typeof value === 'string') {
        return this.parseJsonOrText(value);
      }
    }

    return { answer: JSON.stringify(output), actions: [] };
  }

  private toAnswer(output: AssistantModelOutput): string {
    return typeof output.answer === 'string' && output.answer.trim()
      ? output.answer.trim()
      : 'I generated an organization response, but it did not include readable assistant text.';
  }

  private toActions(output: AssistantModelOutput): AssistantChatResponseDto['actions'] {
    if (!Array.isArray(output.actions)) {
      return [];
    }

    const actions: AssistantChatResponseDto['actions'] = [];
    for (const action of output.actions) {
      if (
        !this.isRecord(action) ||
        typeof action.type !== 'string' ||
        !assistantActionTypes.includes(action.type as (typeof assistantActionTypes)[number]) ||
        typeof action.title !== 'string' ||
        typeof action.rationale !== 'string'
      ) {
        continue;
      }

      const cohortKey = typeof action.cohortKey === 'string' ? action.cohortKey : null;
      const cohortType = this.toCohortType(action.cohortType) ?? (this.isEventCohortKey(cohortKey) ? 'event' : null);

      actions.push({
        type: action.type as (typeof assistantActionTypes)[number],
        title: action.title,
        rationale: action.rationale,
        query: typeof action.query === 'string' ? action.query : null,
        albumName: typeof action.albumName === 'string' ? action.albumName : null,
        assetIds: Array.isArray(action.assetIds)
          ? action.assetIds.filter((assetId): assetId is string => typeof assetId === 'string')
          : [],
        cohortType,
        cohortKey,
        toolType: this.toToolType(action.toolType),
        toolInput: this.toToolInput(action.toolInput),
        command: typeof action.command === 'string' ? action.command : null,
        target: this.toAgentCommandTarget(action.target),
        cwd: typeof action.cwd === 'string' ? action.cwd : null,
        timeoutSeconds: typeof action.timeoutSeconds === 'number' ? action.timeoutSeconds : null,
        confidence: typeof action.confidence === 'number' ? action.confidence : 0.5,
      });

      if (actions.length >= 8) {
        break;
      }
    }

    return actions;
  }

  private toCohortType(value: unknown) {
    return value === 'source_path' || value === 'date' || value === 'camera' || value === 'location' || value === 'event'
      ? value
      : null;
  }

  private isEventCohortKey(value: string | null) {
    if (!value) {
      return false;
    }

    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return (
        (parsed.kind === 'place_exact' || parsed.kind === 'place_region' || parsed.kind === 'place_country') &&
        typeof parsed.country === 'string' &&
        typeof parsed.dateStart === 'string' &&
        typeof parsed.dateEnd === 'string'
      );
    } catch {
      return false;
    }
  }

  private toAgentCommandTarget(value: unknown) {
    return value === 'local' || value === 'synology' || value === 'immich' ? value : null;
  }

  private toToolType(value: unknown): AssistantToolType | null {
    return value === 'content_hash_audit' ||
      value === 'sidecar_pair_audit' ||
      value === 'metadata_search' ||
      value === 'mobile_original_compare'
      ? value
      : null;
  }

  private toToolInput(value: unknown) {
    return this.isRecord(value) ? value : null;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isLocalCliProvider(provider: ProviderConfig): provider is LocalCliProviderConfig {
    return provider.provider === 'local-cli' || provider.provider === 'claude-cli' || provider.provider === 'codex-cli';
  }

  private toStringList(values: Array<string | null>): string[] {
    return values.filter((value): value is string => typeof value === 'string').slice(0, 50);
  }

  private toTopYears(timeBuckets: Array<{ timeBucket: string; count: number }>) {
    const years = new Map<string, number>();
    for (const { timeBucket, count } of timeBuckets) {
      const year = timeBucket.slice(0, 4);
      if (!/^\d{4}$/.test(year)) {
        continue;
      }

      years.set(year, (years.get(year) ?? 0) + Number(count));
    }

    return [...years.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }

  private getAssessmentFindings({
    totalAssets,
    unorganizedAssets,
    albums,
    topYears,
    cameraMakes,
    countries,
    cities,
  }: {
    totalAssets: number;
    unorganizedAssets: number;
    albums: number;
    topYears: Array<{ label: string; count: number }>;
    cameraMakes: string[];
    countries: string[];
    cities: string[];
  }): AssistantAssessmentResponseDto['findings'] {
    const findings: AssistantAssessmentResponseDto['findings'] = [];

    if (unorganizedAssets > 0) {
      findings.push({
        type: 'album_plan',
        title: 'Build review queues for assets outside albums',
        detail:
          'Start with non-mutating review sets for assets that are not currently in any album, then approve album creation in batches.',
        assetCount: unorganizedAssets,
        query: JSON.stringify({ isNotInAlbum: true }),
      });
    }

    if (topYears.length > 0) {
      findings.push({
        type: 'folder_plan',
        title: 'Use date buckets as the first large-library pass',
        detail: `The largest year bucket is ${topYears[0].label}. Date buckets are deterministic and scale better than model-by-model asset inspection.`,
        assetCount: topYears[0].count,
        query: null,
      });
    }

    if (cameraMakes.length > 1) {
      findings.push({
        type: 'metadata_audit',
        title: 'Separate phone, camera, and imported-source cohorts',
        detail:
          'Camera make/model metadata can split the library into reliable source cohorts before applying more subjective organization.',
        assetCount: totalAssets,
        query: null,
      });
    }

    if (countries.length > 0 || cities.length > 0) {
      findings.push({
        type: 'review',
        title: 'Create location-based review passes',
        detail:
          'Location metadata is available and should be used for travel/event grouping, with manual review for ambiguous places.',
        assetCount: totalAssets,
        query: null,
      });
    }

    if (albums === 0 && totalAssets > 0) {
      findings.push({
        type: 'album_plan',
        title: 'No owned albums found',
        detail: 'Use review queues before creating permanent albums so the first organization pass remains reversible.',
        assetCount: totalAssets,
        query: null,
      });
    }

    findings.push({
      type: 'original_file_audit',
      title: 'Original-file audit remains separate from organization',
      detail:
        'Before reorganizing iPhone imports, verify original-file handling with the adjusted-asset log markers so rendered copies do not become the trusted source.',
      assetCount: null,
      query: null,
    });

    return findings;
  }
}
