<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import { Button, Icon, Textarea, toastManager } from '@immich/ui';
  import { mdiArrowRight, mdiMagnify, mdiRobotOutline, mdiSend } from '@mdi/js';
  import type { PageData } from './$types';

  type AssistantProvider = 'auto' | 'claude-cli' | 'codex-cli' | 'openai' | 'anthropic';

  type AssistantAction = {
    type: 'search' | 'album_plan' | 'folder_plan' | 'metadata_audit' | 'original_file_audit' | 'review';
    title: string;
    rationale: string;
    query: string | null;
    albumName: string | null;
    assetIds: string[];
    confidence: number;
  };

  type ChatMessage = {
    role: 'user' | 'assistant';
    content: string;
    actions?: AssistantAction[];
  };

  type AssistantResponse = {
    status: 'success' | 'disabled' | 'error';
    answer: string;
    actions: AssistantAction[];
    error?: string;
  };

  type AssessmentBucket = {
    label: string;
    count: number;
  };

  type AssessmentFinding = {
    type: 'album_plan' | 'folder_plan' | 'metadata_audit' | 'original_file_audit' | 'review';
    title: string;
    detail: string;
    assetCount: number | null;
    query: string | null;
  };

  type Assessment = {
    generatedAt: string;
    summary: {
      totalAssets: number;
      imageAssets: number;
      videoAssets: number;
      audioAssets: number;
      otherAssets: number;
      albums: number;
      unorganizedAssets: number;
      favoriteAssets: number;
      archivedAssets: number;
    };
    topYears: AssessmentBucket[];
    cameraMakes: string[];
    cameraModels: string[];
    countries: string[];
    cities: string[];
    findings: AssessmentFinding[];
  };

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let prompt = $state('');
  let provider = $state<AssistantProvider>('auto');
  let loading = $state(false);
  let loadingAssessment = $state(false);
  let assessment = $state<Assessment | null>(null);
  let messages = $state<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        'Ask me how to organize this library. I can assess metadata and propose review-first organization plans.',
      actions: [],
    },
  ]);

  const actionTypeLabel: Record<AssistantAction['type'], string> = {
    search: 'Search',
    album_plan: 'Album plan',
    folder_plan: 'Folder plan',
    metadata_audit: 'Metadata audit',
    original_file_audit: 'Original audit',
    review: 'Review',
  };

  const providerOptions: Array<{ value: AssistantProvider; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'claude-cli', label: 'Claude' },
    { value: 'codex-cli', label: 'Codex' },
  ];

  const getSearchHref = (action: AssistantAction) => {
    if (!action.query) {
      return Route.search();
    }

    return Route.search({ query: action.query });
  };

  const getFindingHref = (finding: AssessmentFinding) => {
    if (!finding.query) {
      return null;
    }

    try {
      return Route.search(JSON.parse(finding.query));
    } catch {
      return null;
    }
  };

  const formatNumber = (value: number | null) => (value === null ? 'n/a' : new Intl.NumberFormat().format(value));

  const assessLibrary = async () => {
    if (loadingAssessment) {
      return;
    }

    loadingAssessment = true;
    try {
      const response = await fetch('/api/assistant/assessment');
      if (!response.ok) {
        throw new Error(await response.text());
      }

      assessment = (await response.json()) as Assessment;
    } catch (error) {
      toastManager.danger(error instanceof Error ? error.message : String(error));
    } finally {
      loadingAssessment = false;
    }
  };

  const send = async () => {
    const content = prompt.trim();
    if (!content || loading) {
      return;
    }

    const nextMessages = [...messages, { role: 'user' as const, content }];
    messages = nextMessages;
    prompt = '';
    loading = true;

    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: provider === 'auto' ? undefined : provider,
          messages: nextMessages.map(({ role, content }) => ({ role, content })).slice(-12),
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const result = (await response.json()) as AssistantResponse;
      messages = [
        ...nextMessages,
        {
          role: 'assistant',
          content: result.answer,
          actions: result.actions,
        },
      ];

      if (result.status !== 'success') {
        toastManager.warning(result.error ?? result.answer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      messages = [
        ...nextMessages,
        {
          role: 'assistant',
          content: 'The assistant request failed. No library changes were made.',
          actions: [],
        },
      ];
      toastManager.danger(message);
    } finally {
      loading = false;
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
</script>

<UserPageLayout title={data.meta.title}>
  <div class="mx-auto flex h-[calc(100vh-9rem)] w-full max-w-5xl flex-col gap-4 p-4">
    <div class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Library assessment</h2>
          {#if assessment}
            <p class="text-sm text-gray-500">Generated {new Date(assessment.generatedAt).toLocaleString()}</p>
          {/if}
        </div>
        <Button type="button" onclick={() => void assessLibrary()} disabled={loadingAssessment}>
          {loadingAssessment ? 'Assessing...' : 'Assess library'}
        </Button>
      </div>

      {#if assessment}
        <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500">Assets</div>
            <div class="text-xl font-semibold">{formatNumber(assessment.summary.totalAssets)}</div>
          </div>
          <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500">Unorganized</div>
            <div class="text-xl font-semibold">{formatNumber(assessment.summary.unorganizedAssets)}</div>
          </div>
          <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500">Albums</div>
            <div class="text-xl font-semibold">{formatNumber(assessment.summary.albums)}</div>
          </div>
          <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500">Archived</div>
            <div class="text-xl font-semibold">{formatNumber(assessment.summary.archivedAssets)}</div>
          </div>
        </div>

        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">Largest year buckets</h3>
            <div class="mt-2 flex flex-wrap gap-2">
              {#each assessment.topYears as bucket (bucket.label)}
                <span
                  class="rounded-md bg-gray-100 px-2 py-1 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200"
                >
                  {bucket.label}: {formatNumber(bucket.count)}
                </span>
              {/each}
            </div>
          </div>

          <div>
            <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">Metadata slices</h3>
            <div class="mt-2 text-sm text-gray-600 dark:text-gray-300">
              {assessment.cameraMakes.length} camera makes, {assessment.cameraModels.length} camera models,
              {assessment.countries.length} countries, {assessment.cities.length} cities.
            </div>
          </div>
        </div>

        <div class="mt-4 flex flex-col gap-2">
          {#each assessment.findings as finding (finding.type + finding.title)}
            {@const href = getFindingHref(finding)}
            <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="text-xs font-semibold text-gray-500 uppercase">{actionTypeLabel[finding.type]}</div>
                  <div class="font-medium text-gray-900 dark:text-gray-100">{finding.title}</div>
                </div>
                <div class="text-xs text-gray-500">{formatNumber(finding.assetCount)}</div>
              </div>
              <div class="mt-1 text-sm text-gray-600 dark:text-gray-300">{finding.detail}</div>
              {#if href}
                <a class="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary" {href}>
                  <Icon icon={mdiMagnify} size="16" />
                  Open review search
                  <Icon icon={mdiArrowRight} size="16" />
                </a>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div
      class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
    >
      <div class="flex flex-col gap-4">
        {#each messages as message, messageIndex (messageIndex)}
          <div class="flex gap-3" class:justify-end={message.role === 'user'}>
            {#if message.role === 'assistant'}
              <div
                class="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200"
              >
                <Icon icon={mdiRobotOutline} size="18" />
              </div>
            {/if}

            <div
              class="max-w-[78%] rounded-lg px-4 py-3 text-sm/6 whitespace-pre-wrap"
              class:bg-primary={message.role === 'user'}
              class:text-white={message.role === 'user'}
              class:bg-gray-100={message.role === 'assistant'}
              class:text-gray-900={message.role === 'assistant'}
              class:dark:bg-gray-800={message.role === 'assistant'}
              class:dark:text-gray-100={message.role === 'assistant'}
            >
              {message.content}

              {#if message.actions?.length}
                <div class="mt-4 flex flex-col gap-2">
                  {#each message.actions as action (action.type + action.title)}
                    <div
                      class="rounded-md border border-gray-200 bg-white p-3 text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div>
                          <div class="text-xs font-semibold text-gray-500 uppercase">
                            {actionTypeLabel[action.type]}
                          </div>
                          <div class="font-medium">{action.title}</div>
                        </div>
                        <div class="text-xs text-gray-500">{Math.round(action.confidence * 100)}%</div>
                      </div>
                      <div class="mt-1 text-sm text-gray-600 dark:text-gray-300">{action.rationale}</div>
                      {#if action.query}
                        <a
                          class="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary"
                          href={getSearchHref(action)}
                        >
                          <Icon icon={mdiMagnify} size="16" />
                          Open search
                          <Icon icon={mdiArrowRight} size="16" />
                        </a>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}

        {#if loading}
          <div class="flex gap-3">
            <div
              class="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200"
            >
              <Icon icon={mdiRobotOutline} size="18" />
            </div>
            <div class="rounded-lg bg-gray-100 px-4 py-3 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100">
              Thinking...
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <Textarea
        bind:value={prompt}
        rows={3}
        placeholder="Ask about organizing your photos"
        disabled={loading}
        onkeydown={onKeydown}
      />
      <div class="mt-3 flex items-center justify-between gap-3">
        <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          Provider
          <select
            bind:value={provider}
            class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            disabled={loading}
          >
            {#each providerOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <Button type="button" onclick={() => void send()} disabled={loading || !prompt.trim()}>
          <div class="flex items-center gap-2">
            <Icon icon={mdiSend} size="16" />
            Send
          </div>
        </Button>
      </div>
    </div>
  </div>
</UserPageLayout>
