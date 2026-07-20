import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { AlbumResponseDto } from 'src/dtos/album.dto';
import { AssetResponseDto } from 'src/dtos/asset-response.dto';
import { AssetMetadataResponseDto } from 'src/dtos/asset.dto';
import {
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
} from 'src/dtos/assistant.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { LibraryResponseDto } from 'src/dtos/library.dto';
import { SearchSuggestionType } from 'src/dtos/search.dto';
import { AssetOrder, AssetOrderBy, AssetType, AssetVisibility } from 'src/enum';
import type { EnvData } from 'src/repositories/config.repository';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { BaseService } from 'src/services/base.service';
import { LibraryService } from 'src/services/library.service';
import { SearchService } from 'src/services/search.service';

type AssistantProvider = 'openai' | 'anthropic' | 'claude-cli' | 'codex-cli';
type LlmProvider = AssistantProvider | 'local-cli';

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

const assistantActionTypes = [
  'search',
  'album_plan',
  'folder_plan',
  'metadata_audit',
  'original_file_audit',
  'review',
] as const;

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
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
        },
        required: ['type', 'title', 'rationale', 'query', 'albumName', 'assetIds', 'confidence'],
      },
    },
  },
  required: ['answer', 'actions'],
};

@Injectable()
export class AssistantService extends BaseService {
  private readonly assetSampleSize = 75;
  private readonly assetMetadataSampleSize = 60;

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
    const context = await this.getLibraryContext(auth);
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

  private async getLibraryContext(auth: AuthDto) {
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
    ]);
    const sampledAssets = this.toUniqueAssets([...recent.assets.items, ...unorganized.assets.items]);
    const assetMetadata = await this.getAssetMetadataContext(assetService, auth, sampledAssets);
    const externalLibraries = await this.toLibraryContexts(libraryService, libraries);
    const topYears = this.toTopYears(timeBuckets);

    return {
      albums: albums.slice(0, 50).map((album) => this.toAlbumContext(album)),
      externalLibraries,
      recentAssets: recent.assets.items.map((asset) => this.toAssetContext(asset, assetMetadata.get(asset.id))),
      unorganizedAssets: unorganized.assets.items.map((asset) => this.toAssetContext(asset, assetMetadata.get(asset.id))),
      sourcePathCohorts: this.toSourcePathCohorts(sampledAssets),
      metadataCoverage: this.toMetadataCoverage(sampledAssets),
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

  private buildPrompt(
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ) {
    return {
      instruction:
        'You are an in-app Immich photo library assistant for organizing very large photo and video libraries. Help assess metadata, source cohorts, time ranges, locations, albums, folders, review queues, and original-file risks using the provided library context. When a field is absent from the provided context, say it is not visible in the assistant sample; do not claim it is missing from the source file or Immich database. Do not suggest tagging unless the user explicitly asks for tags. Do not claim any change has been applied. Prefer reversible, review-first organization. Use action assetIds only for concrete sampled assets that should be placed in a review album; leave assetIds empty for broad searches, audits, and cohorts that need more review. Never suggest deleting assets unless the user explicitly asks about deletion.',
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

      actions.push({
        type: action.type as (typeof assistantActionTypes)[number],
        title: action.title,
        rationale: action.rationale,
        query: typeof action.query === 'string' ? action.query : null,
        albumName: typeof action.albumName === 'string' ? action.albumName : null,
        assetIds: Array.isArray(action.assetIds)
          ? action.assetIds.filter((assetId): assetId is string => typeof assetId === 'string')
          : [],
        confidence: typeof action.confidence === 'number' ? action.confidence : 0.5,
      });

      if (actions.length >= 8) {
        break;
      }
    }

    return actions;
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
