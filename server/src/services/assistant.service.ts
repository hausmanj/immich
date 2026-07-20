import { BadRequestException, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { AlbumResponseDto } from 'src/dtos/album.dto';
import { AssetResponseDto } from 'src/dtos/asset-response.dto';
import { AssetMetadataResponseDto } from 'src/dtos/asset.dto';
import {
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
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
import type { AssistantAuditAsset, AssistantAuditAssetSearch, AssistantEventAuditBucket } from 'src/repositories/asset.repository';
import type { EnvData } from 'src/repositories/config.repository';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { BaseService } from 'src/services/base.service';
import { LibraryService } from 'src/services/library.service';
import { SearchService } from 'src/services/search.service';
import { StackService } from 'src/services/stack.service';

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
    const context = await this.getLibraryContext(auth, dto);
    const providerConfig = this.getLlmProvider(dto.provider);

    if (!providerConfig) {
      return {
        status: 'disabled',
        answer:
          'The assistant is not configured. Set IMMICH_ASSISTANT_CLAUDE_COMMAND, IMMICH_ASSISTANT_CODEX_COMMAND, or set IMMICH_LLM_PROVIDER with the matching provider API key.',
        actions: [],
        context: context.summary,
      };
    }

    try {
      const output = this.isLocalCliProvider(providerConfig)
        ? await this.callLocalAssistant(providerConfig, dto, context)
        : providerConfig.provider === 'openai'
          ? await this.callOpenAi(providerConfig, dto, context)
          : await this.callAnthropic(providerConfig, dto, context);

      return {
        status: 'success',
        provider: providerConfig.provider,
        model: providerConfig.model,
        answer: this.toAnswer(output),
        actions: this.toActions(output),
        context: context.summary,
      };
    } catch (error: unknown) {
      const message = this.getErrorMessage(error);
      this.logger.warn(`Assistant chat failed: ${message}`);
      return {
        status: 'error',
        provider: providerConfig.provider,
        model: providerConfig.model,
        answer: 'The assistant request failed. No library changes were made.',
        actions: [],
        error: message,
        context: context.summary,
      };
    }
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

  private getLlmProvider(requested?: AssistantProvider): ProviderConfig | undefined {
    const { assistant, llm } = this.configRepository.getEnv();
    const requestedLocal = requested === 'claude-cli' || requested === 'codex-cli' ? requested : assistant.provider;
    if (requestedLocal === 'claude-cli' && (assistant.claude.url || assistant.claude.command)) {
      return this.toLocalCliProvider('claude-cli', assistant.claude);
    }

    if (requestedLocal === 'codex-cli' && (assistant.codex.url || assistant.codex.command)) {
      return this.toLocalCliProvider('codex-cli', assistant.codex);
    }

    if (requested === 'openai' || requested === 'anthropic') {
      return this.toRemoteProvider(requested, llm);
    }

    if (assistant.provider === 'openai' || assistant.provider === 'anthropic') {
      return this.toRemoteProvider(assistant.provider, llm);
    }

    if (assistant.claude.url || assistant.claude.command) {
      return this.toLocalCliProvider('claude-cli', assistant.claude);
    }

    if (assistant.codex.url || assistant.codex.command) {
      return this.toLocalCliProvider('codex-cli', assistant.codex);
    }

    if (assistant.local.url || assistant.local.command) {
      return this.toLocalCliProvider('local-cli', assistant.local);
    }

    const provider = llm.provider ?? (llm.openai.apiKey ? 'openai' : llm.anthropic.apiKey ? 'anthropic' : undefined);
    return provider ? this.toRemoteProvider(provider, llm) : undefined;
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
        requestedToolResults,
        actionGuidance:
          'For reversible review albums, prefer eventCohorts for multi-day trips and same-location travel before falling back to single-day dateCohorts. Use cohortType and cohortKey from deterministic cohorts instead of enumerating large asset ID lists. For deeper evidence, propose a read-only tool action with toolType/toolInput so Immich can run content_hash_audit, sidecar_pair_audit, metadata_search, or mobile_original_compare.',
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
        `${cohort.activeDayCount} active days across ${cohort.dateSpanDays} calendar days with ${cohort.locationAssetCount} location-backed assets. Prefer this over daily albums when organizing a multi-day trip or repeated same-location event.`,
    }));
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

  private async getAutomaticToolResults(auth: AuthDto, dto: AssistantChatRequestDto) {
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
      },
      results: scannedAssets.map((asset) => this.toAuditAssetResult(asset)),
      errors: [],
    };
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
        'You are an in-app Immich photo library assistant for organizing very large photo and video libraries. Help assess metadata, source cohorts, time ranges, locations, albums, folders, review queues, duplicates, video metadata, and original-file risks using the provided library context. Prefer deterministicAudits over the sampled assets when discussing whole-library counts, cohorts, duplicate candidates, videos, mobile upload audit coverage, and review-album candidates. Prefer deterministicAudits.eventCohorts for multi-day trips, same-location travel, and event-style organization; do not split a trip into daily albums when a higher-confidence event cohort covers the same date/location span. Daily dateCohorts are fallback review units, not the default trip boundary. When deterministicAudits.requestedToolResults is present, treat it as server-run evidence from the current user request; it contains the full tool summary, result count, error count, and logFilePath when large row-level output was written to disk. Full row-level results remain available through a tool action and, when present, the JSON audit log. When proposing a reversible review album from deterministicAudits, set action.cohortType and action.cohortKey to the exact cohort fields and leave assetIds empty unless the action is based on explicit sampled assets. When more evidence is needed, include action.toolType and action.toolInput for one of the read-only Immich tools: content_hash_audit, sidecar_pair_audit, metadata_search, or mobile_original_compare. Treat impactful organization changes as requiring read-only evidence first plus a persisted assistant change journal and undo path before the change is considered safe. Use mutationCapabilities to distinguish executable journaled mutations from plan-only blocked mutations: metadata_edit, archive_favorite, and stack_change are currently applyable with typed undo; folder_move and duplicate_resolution are registered but apply-blocked until a reliable typed undo exists. Treat checksumAlgorithm=sha1 as file-content evidence and checksumAlgorithm=sha1-path as external-library path identity, not byte-level integrity. When a field is absent from the provided context, say it is not visible in the assistant context; do not claim it is missing from the source file or Immich database. Do not suggest tagging unless the user explicitly asks for tags. Do not claim any change has been applied. Prefer reversible, review-first organization. Never suggest deleting assets unless the user explicitly asks about deletion.',
      userContent: JSON.stringify({
        libraryContext: context,
        conversation: dto.messages,
      }),
    };
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
