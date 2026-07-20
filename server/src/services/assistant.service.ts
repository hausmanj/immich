import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { AlbumResponseDto } from 'src/dtos/album.dto';
import { AssetResponseDto } from 'src/dtos/asset-response.dto';
import {
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
} from 'src/dtos/assistant.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { SearchSuggestionType } from 'src/dtos/search.dto';
import { AssetOrder, AssetOrderBy, AssetType, AssetVisibility } from 'src/enum';
import type { EnvData } from 'src/repositories/config.repository';
import { AlbumService } from 'src/services/album.service';
import { BaseService } from 'src/services/base.service';
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
  command: string;
  args: string[];
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
        ? await this.callLocalCli(providerConfig, dto, context)
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
    if (requestedLocal === 'claude-cli' && assistant.claude.command) {
      return this.toLocalCliProvider('claude-cli', assistant.claude);
    }

    if (requestedLocal === 'codex-cli' && assistant.codex.command) {
      return this.toLocalCliProvider('codex-cli', assistant.codex);
    }

    if (requested === 'openai' || requested === 'anthropic') {
      return this.toRemoteProvider(requested, llm);
    }

    if (assistant.provider === 'openai' || assistant.provider === 'anthropic') {
      return this.toRemoteProvider(assistant.provider, llm);
    }

    if (assistant.claude.command) {
      return this.toLocalCliProvider('claude-cli', assistant.claude);
    }

    if (assistant.codex.command) {
      return this.toLocalCliProvider('codex-cli', assistant.codex);
    }

    if (assistant.local.command) {
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
    local: { command?: string; args: string[]; timeoutSeconds: number },
  ): ProviderConfig | undefined {
    if (!local.command) {
      return;
    }

    return {
      provider,
      command: local.command,
      args: local.args,
      timeoutSeconds: local.timeoutSeconds,
      model: local.command,
    };
  }

  private async getLibraryContext(auth: AuthDto) {
    const albumService = BaseService.create(AlbumService, this);
    const searchService = BaseService.create(SearchService, this);

    const [albums, recent, unorganized, statistics, unorganizedStatistics] = await Promise.all([
      albumService.getAll(auth, { isOwned: true }),
      searchService.searchMetadata(auth, { size: 24, withExif: true }),
      searchService.searchMetadata(auth, { size: 24, withExif: true, isNotInAlbum: true }),
      searchService.searchStatistics(auth, {}),
      searchService.searchStatistics(auth, { isNotInAlbum: true }),
    ]);

    return {
      albums: albums.slice(0, 50).map((album) => this.toAlbumContext(album)),
      recentAssets: recent.assets.items.map((asset) => this.toAssetContext(asset)),
      unorganizedAssets: unorganized.assets.items.map((asset) => this.toAssetContext(asset)),
      summary: {
        albums: albums.length,
        sampledAssets: recent.assets.items.length,
        unorganizedAssets: unorganizedStatistics.total,
      },
      statistics: {
        totalAssets: statistics.total,
        unorganizedAssets: unorganizedStatistics.total,
      },
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

  private toAssetContext(asset: AssetResponseDto) {
    return {
      id: asset.id,
      type: asset.type,
      originalFileName: asset.originalFileName,
      localDateTime: asset.localDateTime,
      isFavorite: asset.isFavorite,
      isArchived: asset.visibility === AssetVisibility.Archive,
      city: asset.exifInfo?.city ?? null,
      state: asset.exifInfo?.state ?? null,
      country: asset.exifInfo?.country ?? null,
      make: asset.exifInfo?.make ?? null,
      model: asset.exifInfo?.model ?? null,
      description: asset.exifInfo?.description ?? null,
      tags: asset.tags?.map((tag) => tag.value) ?? [],
    };
  }

  private buildPrompt(
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ) {
    return {
      instruction:
        'You are an in-app Immich photo library assistant for organizing very large photo and video libraries. Help assess metadata, source cohorts, time ranges, locations, albums, folders, review queues, and original-file risks using the provided library context. Do not suggest tagging unless the user explicitly asks for tags. Do not claim any change has been applied. Prefer reversible, review-first organization. Never suggest deleting assets unless the user explicitly asks about deletion.',
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
    return this.parseJsonOrText(text) as AssistantModelOutput;
  }

  private async callLocalCli(
    { command, args, timeoutSeconds }: LocalCliProviderConfig,
    dto: AssistantChatRequestDto,
    context: Awaited<ReturnType<AssistantService['getLibraryContext']>>,
  ): Promise<AssistantModelOutput> {
    const prompt = this.buildPrompt(dto, context);
    const stdin = [
      prompt.instruction,
      '',
      'Return only JSON matching this schema:',
      JSON.stringify(assistantOutputSchema),
      '',
      'Library context and conversation:',
      prompt.userContent,
    ].join('\n');

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

        resolve(this.parseJsonOrText(output) as AssistantModelOutput);
      });

      child.stdin.end(stdin);
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

  private parseJsonOrText(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { answer: text, actions: [] };
    }
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
