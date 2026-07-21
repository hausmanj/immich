<script lang="ts">
  import { browser } from '$app/environment';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import { Button, Icon, Textarea, toastManager } from '@immich/ui';
  import {
    mdiArrowRight,
    mdiConsoleLine,
    mdiMagnify,
    mdiPlay,
    mdiPlusBoxOutline,
    mdiRobotOutline,
    mdiSend,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import type { PageData } from './$types';

  type AssistantProvider = 'auto' | 'claude-cli' | 'codex-cli' | 'openai' | 'anthropic';

  type AssistantAction = {
    type:
      | 'search'
      | 'album_plan'
      | 'folder_plan'
      | 'metadata_audit'
      | 'original_file_audit'
      | 'review'
      | 'agent_command';
    title: string;
    rationale: string;
    query: string | null;
    albumName: string | null;
    assetIds: string[];
    cohortType?: 'source_path' | 'date' | 'camera' | 'location' | 'event' | null;
    cohortKey?: string | null;
    toolType?: 'content_hash_audit' | 'sidecar_pair_audit' | 'metadata_search' | 'mobile_original_compare' | null;
    toolInput?: Record<string, unknown> | null;
    command?: string | null;
    target?: AgentCommandTarget | null;
    cwd?: string | null;
    timeoutSeconds?: number | null;
    confidence: number;
  };

  type ChatMessage = {
    role: 'user' | 'assistant';
    content: string;
    actions?: AssistantAction[];
  };

  type AssistantPersistedState = {
    version: 1;
    updatedAt: string;
    provider: AssistantProvider;
    prompt: string;
    messages: ChatMessage[];
    assessment: Assessment | null;
    terminalCommand?: string;
    terminalTarget?: AgentCommandTarget;
    terminalCwd?: string;
    terminalEntries?: AgentTerminalEntry[];
  };

  type AssistantResponse = {
    status: 'success' | 'disabled' | 'error';
    answer: string;
    actions: AssistantAction[];
    error?: string;
  };

  type AssistantReviewAlbumResponse = {
    albumId: string;
    albumName: string;
    assetCount: number;
    truncated: boolean;
    changeLogFilePath: string;
    undoAvailable: boolean;
    undoAction: 'delete_created_review_album';
  };

  type AssistantExecuteReviewPlanResponse = {
    status: 'applied';
    albumCount: number;
    assetCount: number;
    albums: AssistantReviewAlbumResponse[];
    message: string;
  };

  type AssistantToolResponse = {
    toolType: NonNullable<AssistantAction['toolType']>;
    generatedAt: string;
    summary: Record<string, unknown>;
    results: Array<Record<string, unknown>>;
    errors: Array<Record<string, unknown>>;
    logFilePath?: string | null;
    logFileFormat?: 'json' | null;
    resultCount?: number;
    errorCount?: number;
    inlineResultsOmitted?: boolean;
  };

  type AssistantAgentCommandResponse = {
    status: 'disabled' | 'completed' | 'failed' | 'timed_out' | 'error';
    command: string;
    target: AgentCommandTarget | null;
    targetKind: string | null;
    cwd: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    hostLogFilePath: string | null;
    serverLogFilePath: string | null;
    message?: string;
  };

  type AgentTerminalEntry = AssistantAgentCommandResponse & {
    id: string;
  };

  type AgentCommandTarget = 'local' | 'synology' | 'immich';

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
  let applyingActionKey = $state<string | null>(null);
  let runningToolActionKey = $state<string | null>(null);
  let runningAgentCommand = $state(false);
  let terminalCommand = $state('');
  let terminalTarget = $state<AgentCommandTarget>('local');
  let terminalCwd = $state('/Users/johnhausman/source/immich');
  let terminalTimeoutSeconds = $state(600);
  let terminalEntries = $state<AgentTerminalEntry[]>([]);
  let assessment = $state<Assessment | null>(null);
  let assistantStateLoaded = $state(false);
  let messagesContainer: HTMLDivElement | null = null;
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
    agent_command: 'Command',
  };

  const providerOptions: Array<{ value: AssistantProvider; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'claude-cli', label: 'Claude' },
    { value: 'codex-cli', label: 'Codex' },
  ];

  const agentTargetOptions: Array<{ value: AgentCommandTarget; label: string; defaultCwd: string }> = [
    { value: 'local', label: 'Mac', defaultCwd: '/Users/johnhausman/source/immich' },
    { value: 'synology', label: 'Synology', defaultCwd: '/volume1' },
    { value: 'immich', label: 'Immich container', defaultCwd: '/usr/src/app' },
  ];

  const assistantStateStorageKey = 'immich-assistant-conversation-v1';
  const assistantStateVersion = 1;
  const assistantStateMaxMessages = 80;
  const assistantTerminalMaxEntries = 25;

  const isAgentCommandTarget = (value: unknown): value is AgentCommandTarget => {
    return value === 'local' || value === 'synology' || value === 'immich';
  };

  const getResponseError = async (response: Response) => {
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (contentType.includes('application/json')) {
      try {
        const payload = JSON.parse(text) as { message?: unknown; error?: unknown };
        const message = typeof payload.message === 'string' ? payload.message : undefined;
        const error = typeof payload.error === 'string' ? payload.error : undefined;
        return message ?? error ?? `Request failed with HTTP ${response.status}`;
      } catch {
        return `Request failed with HTTP ${response.status}`;
      }
    }

    if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
      return `Request failed with HTTP ${response.status}. The server returned an HTML page instead of JSON. Check the Immich server logs for the underlying error.`;
    }

    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized
      ? `${normalized.slice(0, 600)}${normalized.length > 600 ? '...' : ''}`
      : `Request failed with HTTP ${response.status}`;
  };

  const setTerminalTarget = (value: AgentCommandTarget) => {
    terminalTarget = value;
    terminalCwd = agentTargetOptions.find((option) => option.value === value)?.defaultCwd ?? terminalCwd;
  };

  onMount(() => {
    loadAssistantState();
    assistantStateLoaded = true;
    void scrollMessagesToBottom();
  });

  $effect(() => {
    if (!assistantStateLoaded) {
      return;
    }

    saveAssistantState();
  });

  $effect(() => {
    const shouldScroll = assistantStateLoaded && (messages.length > 0 || loading);
    if (shouldScroll) {
      void scrollMessagesToBottom();
    }
  });

  const scrollMessagesToBottom = async () => {
    await tick();
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  };

  const loadAssistantState = () => {
    if (!browser) {
      return;
    }

    try {
      const raw = localStorage.getItem(assistantStateStorageKey);
      if (!raw) {
        return;
      }

      const state = JSON.parse(raw) as AssistantPersistedState;
      if (state.version !== assistantStateVersion || !Array.isArray(state.messages)) {
        return;
      }

      provider = providerOptions.some((option) => option.value === state.provider) ? state.provider : 'auto';
      prompt = typeof state.prompt === 'string' ? state.prompt : '';
      messages = state.messages.length > 0 ? state.messages : messages;
      assessment = state.assessment ?? null;
      terminalCommand = typeof state.terminalCommand === 'string' ? state.terminalCommand : '';
      terminalTarget = isAgentCommandTarget(state.terminalTarget) ? state.terminalTarget : terminalTarget;
      terminalCwd = typeof state.terminalCwd === 'string' ? state.terminalCwd : terminalCwd;
      terminalEntries = Array.isArray(state.terminalEntries) ? state.terminalEntries : [];
    } catch {
      localStorage.removeItem(assistantStateStorageKey);
    }
  };

  const saveAssistantState = () => {
    if (!browser) {
      return;
    }

    const state: AssistantPersistedState = {
      version: assistantStateVersion,
      updatedAt: new Date().toISOString(),
      provider,
      prompt,
      messages: messages.slice(-assistantStateMaxMessages),
      assessment,
      terminalCommand,
      terminalTarget,
      terminalCwd,
      terminalEntries: terminalEntries.slice(-assistantTerminalMaxEntries).map((entry) => toPersistedTerminalEntry(entry)),
    };

    try {
      localStorage.setItem(assistantStateStorageKey, JSON.stringify(state));
    } catch {
      toastManager.warning('Assistant conversation could not be saved in this browser.');
    }
  };

  const clearAssistantState = () => {
    messages = [
      {
        role: 'assistant',
        content:
          'Ask me how to organize this library. I can assess metadata and propose review-first organization plans.',
        actions: [],
      },
    ];
    prompt = '';
    assessment = null;
    terminalCommand = '';
    terminalTarget = 'local';
    terminalCwd = '/Users/johnhausman/source/immich';
    terminalEntries = [];
    if (browser) {
      localStorage.removeItem(assistantStateStorageKey);
    }
    void scrollMessagesToBottom();
  };

  const getSearchHref = (action: AssistantAction) => {
    if (!action.query) {
      return Route.search();
    }

    return Route.search({ query: action.query });
  };

  const getActionKey = (messageIndex: number, actionIndex: number) => `${messageIndex}:${actionIndex}`;

  const getReviewAlbumName = (action: AssistantAction) => {
    return action.albumName?.trim() || action.title.trim() || 'Assistant review album';
  };

  const isConcreteReviewAction = (action: AssistantAction) => {
    return action.type === 'review' && (action.assetIds.length > 0 || !!(action.cohortType && action.cohortKey));
  };

  const isStaleActionMessage = (messageIndex: number) => messages.slice(messageIndex + 1).length > 0;

  const hasExecutableAction = (action: AssistantAction) => {
    return !!action.toolType || isConcreteReviewAction(action) || isConcreteAgentCommandAction(action);
  };

  const canCreateReviewAlbum = (action: AssistantAction, messageIndex: number) => {
    return (
      !isStaleActionMessage(messageIndex) &&
      isConcreteReviewAction(action)
    );
  };

  const canRunTool = (action: AssistantAction, messageIndex: number) => !!action.toolType && !isStaleActionMessage(messageIndex);

  const isConcreteAgentCommandAction = (action: AssistantAction) =>
    action.type === 'agent_command' && typeof action.command === 'string' && action.command.trim().length > 0;

  const canRunAgentCommandAction = (action: AssistantAction, messageIndex: number) =>
    isConcreteAgentCommandAction(action) && !isStaleActionMessage(messageIndex);

  const getRunToolLabel = (action: AssistantAction) => {
    switch (action.toolType) {
      case 'content_hash_audit': {
        return 'Run hash audit';
      }
      case 'sidecar_pair_audit': {
        return 'Run sidecar audit';
      }
      case 'metadata_search': {
        return 'Run search';
      }
      case 'mobile_original_compare': {
        return 'Compare originals';
      }
      default: {
        return 'Run audit';
      }
    }
  };

  const getCreateReviewAlbumLabel = (action: AssistantAction) => {
    return action.assetIds.length > 0 ? `Create review album (${formatNumber(action.assetIds.length)})` : 'Create review album';
  };

  const isPlanExecutionFeedback = (content: string) => {
    return /\b(go|execute|apply|create|stage|materialize|start|proceed|do it|approved?|yes)\b/i.test(content);
  };

  const getLatestAssistantActions = () => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && message.actions?.length) {
        return message.actions;
      }
    }

    return [];
  };

  const actionMatchesFeedback = (action: AssistantAction, content: string) => {
    const normalized = content.toLowerCase();
    const haystack = [action.title, action.rationale, action.albumName ?? '', action.cohortKey ?? ''].join(' ').toLowerCase();
    const hasSpecificTarget =
      /\b(trip|french|polynesia|bora|leeward)\b/.test(normalized) ||
      /\b(adjacent|oct(?:ober)?\s*21|10\/21|source|folder|all|everything|entire)\b/.test(normalized);

    if (!hasSpecificTarget || /\b(all|everything|entire|plan|these|them)\b/.test(normalized)) {
      return true;
    }

    if (/\b(trip|french|polynesia|bora|leeward)\b/.test(normalized)) {
      return /\b(french|polynesia|bora|leeward|trip)\b/.test(haystack);
    }

    if (/\b(adjacent|oct(?:ober)?\s*21|10\/21)\b/.test(normalized)) {
      return /\b(oct(?:ober)?\s*21|2012-10-21|adjacent)\b/.test(haystack);
    }

    if (/\b(source|folder)\b/.test(normalized)) {
      return /\b(source|folder)\b/.test(haystack);
    }

    return true;
  };

  const getApprovedReviewActions = (content: string) => {
    if (!isPlanExecutionFeedback(content)) {
      return [];
    }

    return getLatestAssistantActions()
      .filter((action) => isConcreteReviewAction(action))
      .filter((action) => actionMatchesFeedback(action, content));
  };

  const getApprovedAgentCommandActions = (content: string) => {
    if (!isPlanExecutionFeedback(content)) {
      return [];
    }

    return getLatestAssistantActions()
      .filter((action) => isConcreteAgentCommandAction(action))
      .filter((action) => actionMatchesFeedback(action, content));
  };

  const createReviewAlbum = async (action: AssistantAction, actionKey: string) => {
    if (applyingActionKey) {
      return;
    }

    if (action.type !== 'review') {
      toastManager.warning('Only concrete review actions can create albums.');
      return;
    }

    if (action.assetIds.length === 0 && !(action.cohortType && action.cohortKey)) {
      toastManager.warning('This proposal does not include explicit asset IDs or a server cohort.');
      return;
    }

    applyingActionKey = actionKey;
    try {
      const response = await fetch('/api/assistant/review-album', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          albumName: getReviewAlbumName(action),
          assetIds: action.assetIds.length > 0 ? action.assetIds : undefined,
          cohortType: action.cohortType,
          cohortKey: action.cohortKey,
        }),
      });

      if (!response.ok) {
        throw new Error(await getResponseError(response));
      }

      const result = (await response.json()) as AssistantReviewAlbumResponse;
      if (result.truncated) {
        toastManager.warning(`Created review album with first ${formatNumber(result.assetCount)} assets.`);
      }
      if (result.changeLogFilePath) {
        toastManager.info(`Assistant change journal: ${result.changeLogFilePath}`);
      }
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: [
            `Created review album "${result.albumName}" with ${formatNumber(result.assetCount)} assets.`,
            `Album ID: ${result.albumId}`,
            `Change journal: ${result.changeLogFilePath}`,
            result.undoAvailable ? `Undo action: ${result.undoAction}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          actions: [],
        },
      ];
      saveAssistantState();
      await continueFromCurrentState('Continue organizing from this completed review-album action. Propose the next read-only audits or review actions, and do not repeat completed actions.');
    } catch (error) {
      toastManager.danger(error instanceof Error ? error.message : String(error));
    } finally {
      applyingActionKey = null;
    }
  };

  const executeApprovedReviewActions = async (actions: AssistantAction[]) => {
    const response = await fetch('/api/assistant/review-plan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        albums: actions.map((action) => ({
          albumName: getReviewAlbumName(action),
          assetIds: action.assetIds.length > 0 ? action.assetIds : undefined,
          cohortType: action.cohortType,
          cohortKey: action.cohortKey,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(await getResponseError(response));
    }

    return (await response.json()) as AssistantExecuteReviewPlanResponse;
  };

  const continueFromCurrentState = async (instruction: string) => {
    const response = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: provider === 'auto' ? undefined : provider,
        messages: [
          ...messages.map(({ role, content }) => ({ role, content })).slice(-11),
          { role: 'user' as const, content: instruction },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(await getResponseError(response));
    }

    const result = (await response.json()) as AssistantResponse;
    messages = [
      ...messages,
      {
        role: 'assistant',
        content: result.answer,
        actions: result.actions,
      },
    ];

    if (result.status !== 'success') {
      toastManager.warning(result.error ?? result.answer);
    }
  };

  const formatExecutedReviewPlan = (result: AssistantExecuteReviewPlanResponse) => {
    return [
      result.message,
      '',
      ...result.albums.map((album) =>
        [
          `- ${album.albumName}: ${formatNumber(album.assetCount)} assets`,
          `  Album ID: ${album.albumId}`,
          `  Change journal: ${album.changeLogFilePath}`,
          album.undoAvailable ? `  Undo action: ${album.undoAction}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ].join('\n');
  };

  const runTool = async (action: AssistantAction, actionKey: string) => {
    if (runningToolActionKey || !action.toolType) {
      return;
    }

    runningToolActionKey = actionKey;
    try {
      const response = await fetch('/api/assistant/tool', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          toolType: action.toolType,
          input: action.toolInput ?? {
            cohortType: action.cohortType,
            cohortKey: action.cohortKey,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(await getResponseError(response));
      }

      const result = (await response.json()) as AssistantToolResponse;
      const toolMessage: ChatMessage = {
        role: 'assistant',
        content: formatToolResult(result),
        actions: [],
      };
      messages = [
        ...messages,
        toolMessage,
      ];
      await continueFromCurrentState('Continue organizing from this completed read-only audit. Use the audit evidence to propose the next exact action. Do not dump raw audit rows.');
    } catch (error) {
      toastManager.danger(error instanceof Error ? error.message : String(error));
    } finally {
      runningToolActionKey = null;
    }
  };

  const executeAgentCommand = async (
    commandInput: string,
    cwdInput?: string | null,
    timeoutSecondsInput?: number | null,
    targetInput?: AgentCommandTarget | null,
  ) => {
    const command = commandInput.trim();
    if (!command || runningAgentCommand) {
      return null;
    }

    runningAgentCommand = true;
    try {
      const response = await fetch('/api/assistant/agent-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command,
          target: targetInput ?? terminalTarget,
          cwd: cwdInput?.trim() || terminalCwd.trim() || undefined,
          timeoutSeconds: timeoutSecondsInput ?? terminalTimeoutSeconds,
          maxOutputBytes: 1024 * 1024,
        }),
      });

      if (!response.ok) {
        throw new Error(await getResponseError(response));
      }

      const result = (await response.json()) as AssistantAgentCommandResponse;
      terminalEntries = [
        ...terminalEntries,
        {
          ...result,
          id: `${result.startedAt}-${terminalEntries.length}`,
        },
      ].slice(-assistantTerminalMaxEntries);

      if (result.status !== 'completed') {
        toastManager.warning(result.message ?? `Command finished with status ${result.status}.`);
      }
      return result;
    } catch (error) {
      toastManager.danger(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      runningAgentCommand = false;
    }
  };

  const runAgentCommand = async () => {
    await executeAgentCommand(terminalCommand, terminalCwd, terminalTimeoutSeconds);
  };

  const runAgentCommandAction = async (action: AssistantAction) => {
    if (!isConcreteAgentCommandAction(action) || !action.command) {
      toastManager.warning('This command action does not include a runnable command.');
      return;
    }

    const result = await executeAgentCommand(action.command, action.cwd, action.timeoutSeconds, action.target);
    if (!result) {
      return;
    }

    messages = [
      ...messages,
      {
        role: 'assistant',
        content: formatAgentCommandResult(result),
        actions: [],
      },
    ];
    await continueFromCurrentState('Continue from this completed audited command. Use the command output and log paths as evidence, and propose the next exact action.');
  };

  const onTerminalKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void runAgentCommand();
    }
  };

  const toPersistedTerminalEntry = (entry: AgentTerminalEntry): AgentTerminalEntry => ({
    ...entry,
    stdout: truncateTerminalText(entry.stdout),
    stderr: truncateTerminalText(entry.stderr),
  });

  const truncateTerminalText = (value: string, maxLength = 16_000) => {
    return value.length > maxLength ? `${value.slice(0, maxLength)}\n... truncated in browser state ...` : value;
  };

  const formatAgentStatus = (entry: AgentTerminalEntry) => {
    const exit = entry.exitCode === null ? 'n/a' : String(entry.exitCode);
    return `${entry.status} | exit ${exit} | ${(entry.durationMs / 1000).toFixed(1)}s`;
  };

  const formatAgentCommandResult = (result: AssistantAgentCommandResponse) => {
    return [
      `Agent command completed with status ${result.status}.`,
      `Target: ${result.target ?? 'local'}${result.targetKind ? ` (${result.targetKind})` : ''}`,
      `Command: ${result.command}`,
      `cwd: ${result.cwd ?? 'cwd unavailable'}`,
      `exitCode: ${result.exitCode === null ? 'n/a' : result.exitCode}`,
      result.hostLogFilePath ? `Host log: ${result.hostLogFilePath}` : '',
      result.serverLogFilePath ? `Server log: ${result.serverLogFilePath}` : '',
      result.stdout ? `\nstdout:\n${truncateTerminalText(result.stdout, 4000)}` : '',
      result.stderr ? `\nstderr:\n${truncateTerminalText(result.stderr, 4000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const formatToolResult = (result: AssistantToolResponse) => {
    const summary = Object.entries(result.summary)
      .filter(([key]) => key !== 'breakdown')
      .map(([key, value]) => `${key}: ${formatToolValue(value)}`)
      .join('\n');
    const resultCount = result.resultCount ?? result.results.length;
    const errorCount = result.errorCount ?? result.errors.length;
    const logLine = result.logFilePath ? `Full JSON audit log: ${result.logFilePath}` : '';
    const omittedLine =
      result.inlineResultsOmitted && result.logFilePath
        ? `Inline rows omitted from chat. The log contains ${formatNumber(resultCount)} result rows and ${formatNumber(errorCount)} error rows.`
        : '';
    const breakdown = formatMetadataSearchBreakdown(result);
    const results = formatToolResultRows(result);
    const errors = formatToolErrorRows(result.errors);

    return [
      `${getToolTitle(result.toolType)} completed at ${new Date(result.generatedAt).toLocaleString()}.`,
      '',
      summary,
      breakdown,
      logLine,
      omittedLine,
      results ? `\nResults:\n${results}` : '',
      errors ? `\nErrors:\n${errors}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const formatToolResultRows = (result: AssistantToolResponse) => {
    switch (result.toolType) {
      case 'sidecar_pair_audit': {
        return formatSidecarPairRows(result.results);
      }
      case 'content_hash_audit': {
        return formatContentHashRows(result.results);
      }
      case 'metadata_search': {
        return formatAssetRows(result.results);
      }
      case 'mobile_original_compare': {
        return formatMobileCompareRows(result.results);
      }
    }
  };

  const formatMetadataSearchBreakdown = (result: AssistantToolResponse) => {
    if (result.toolType !== 'metadata_search') {
      return '';
    }

    const breakdown = result.summary.breakdown;
    if (!isRecord(breakdown)) {
      return '';
    }

    return [
      'Breakdown:',
      formatBreakdownSection('Dates', getRecordArray(breakdown, 'dates'), 12),
      formatBreakdownSection('Places', getRecordArray(breakdown, 'places'), 10),
      formatBreakdownSection('Cameras', getRecordArray(breakdown, 'cameras'), 8),
      formatBreakdownSection('Media types', getRecordArray(breakdown, 'mediaTypes'), 6),
      formatBreakdownSection('Extensions', getRecordArray(breakdown, 'fileExtensions'), 6),
    ]
      .filter(Boolean)
      .join('\n');
  };

  const formatBreakdownSection = (title: string, rows: Array<Record<string, unknown>>, limit: number) => {
    if (rows.length === 0) {
      return '';
    }

    return [
      `${title}:`,
      ...rows.slice(0, limit).map((row) => `- ${getString(row, 'label') || 'Unknown'}: ${formatNumber(getNumber(row, 'count'))}`),
    ].join('\n');
  };

  const formatSidecarPairRows = (results: Array<Record<string, unknown>>) => {
    return results
      .map((item, index) => {
        const directory = getString(item, 'directory');
        const normalizedBase = getString(item, 'normalizedBase');
        const sidecarName = getString(item, 'sidecarName');
        const sidecarType = getString(item, 'sidecarType');
        const assets = getRecordArray(item, sidecarName ? 'matchedAssets' : 'assets');

        if (assets.length === 0) {
          return JSON.stringify(item);
        }

        const title = sidecarName
          ? `Group ${index + 1}: ${sidecarName} (${sidecarType || 'sidecar'})`
          : `Group ${index + 1}: ${normalizedBase || 'variant group'} (${assets.length} assets)`;

        return [
          title,
          directory ? `Directory: ${directory}` : '',
          ...assets.map((asset) => `- ${formatAssetOneLine(asset)}\n  ${getString(asset, 'originalPath') || 'path unavailable'}`),
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
  };

  const formatContentHashRows = (results: Array<Record<string, unknown>>) => {
    return results
      .map((item, index) => {
        const duplicateAssets = getRecordArray(item, 'assets');
        if (duplicateAssets.length > 0) {
          return [
            `Duplicate group ${index + 1}: ${formatNumber(getNumber(item, 'assetCount') ?? duplicateAssets.length)} assets`,
            `SHA1: ${getString(item, 'actualSha1') || 'unavailable'}`,
            ...duplicateAssets.map((asset) => `- ${formatAssetOneLine(asset)}\n  ${getString(asset, 'originalPath') || 'path unavailable'}`),
          ].join('\n');
        }

        return `- ${formatAssetOneLine(item)} | SHA1 ${getString(item, 'actualSha1') || 'unavailable'}\n  ${getString(item, 'originalPath') || 'path unavailable'}`;
      })
      .join('\n');
  };

  const formatAssetRows = (results: Array<Record<string, unknown>>) => {
    return results.map((item) => `- ${formatAssetOneLine(item)}\n  ${getString(item, 'originalPath') || 'path unavailable'}`).join('\n');
  };

  const formatMobileCompareRows = (results: Array<Record<string, unknown>>) => {
    return results
      .map((item, index) =>
        [
          `Group ${index + 1}: ${getString(item, 'originalFileName') || getString(item, 'fileName') || 'mobile cohort'}`,
          `Mobile assets: ${formatToolValue(item.mobileAssetCount)} | Reference assets: ${formatToolValue(item.referenceAssetCount)}`,
          `Exact trait matches: ${formatToolValue(item.exactTraitMatchCount)} | Size mismatches: ${formatToolValue(item.sizeMismatchCount)} | Dimension mismatches: ${formatToolValue(item.dimensionsMismatchCount)}`,
          `Date mismatches: ${formatToolValue(item.dateMismatchCount)} | Camera mismatches: ${formatToolValue(item.cameraMismatchCount)}`,
        ].join('\n'),
      )
      .join('\n\n');
  };

  const formatToolErrorRows = (errors: Array<Record<string, unknown>>) => {
    return errors
      .map((item) => `- ${getString(item, 'originalPath') || getString(item, 'directory') || getString(item, 'assetId') || 'unknown target'}: ${getString(item, 'reason') || JSON.stringify(item)}`)
      .join('\n');
  };

  const formatAssetOneLine = (asset: Record<string, unknown>) => {
    const fileName = getString(asset, 'originalFileName') || getString(asset, 'fileName') || getString(asset, 'assetId') || 'unknown asset';
    const size = formatBytes(asset.fileSizeInByte);
    const dimensions = formatDimensions(asset.width, asset.height);
    const taken = getString(asset, 'dateTimeOriginal') || getString(asset, 'takenAt');
    const camera = [getString(asset, 'make'), getString(asset, 'model')].filter(Boolean).join(' ');
    const edited = typeof asset.isEdited === 'boolean' ? `edited=${asset.isEdited}` : '';

    return [fileName, size, dimensions, taken ? `taken ${taken}` : '', camera, edited].filter(Boolean).join(' | ');
  };

  const getRecordArray = (item: Record<string, unknown>, key: string) => {
    const value = item[key];
    return Array.isArray(value) ? value.filter(isRecord) : [];
  };

  const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  };

  const getString = (item: Record<string, unknown>, key: string) => {
    const value = item[key];
    return typeof value === 'string' ? value : null;
  };

  const getNumber = (item: Record<string, unknown>, key: string) => {
    const value = item[key];
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  };

  const formatBytes = (value: unknown) => {
    const bytes = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null;
    if (bytes === null || !Number.isFinite(bytes)) {
      return '';
    }

    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    if (bytes >= 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${bytes} B`;
  };

  const formatDimensions = (width: unknown, height: unknown) => {
    const numericWidth = typeof width === 'number' ? width : typeof width === 'string' ? Number(width) : null;
    const numericHeight = typeof height === 'number' ? height : typeof height === 'string' ? Number(height) : null;
    return numericWidth && numericHeight ? `${numericWidth}x${numericHeight}` : '';
  };

  const getToolTitle = (toolType: AssistantToolResponse['toolType']) => {
    switch (toolType) {
      case 'content_hash_audit': {
        return 'Content hash audit';
      }
      case 'sidecar_pair_audit': {
        return 'Sidecar/pair audit';
      }
      case 'metadata_search': {
        return 'Metadata search';
      }
      case 'mobile_original_compare': {
        return 'Mobile original comparison';
      }
    }
  };

  const formatToolValue = (value: unknown) => {
    if (typeof value === 'number') {
      return formatNumber(value);
    }

    if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      return String(value);
    }

    return JSON.stringify(value);
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
        throw new Error(await getResponseError(response));
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
      const approvedAgentCommandActions = getApprovedAgentCommandActions(content);
      if (approvedAgentCommandActions.length > 0) {
        const commandResults: AssistantAgentCommandResponse[] = [];
        for (const action of approvedAgentCommandActions) {
          if (action.command) {
            const result = await executeAgentCommand(action.command, action.cwd, action.timeoutSeconds, action.target);
            if (result) {
              commandResults.push(result);
            }
          }
        }

        messages = [
          ...nextMessages,
          {
            role: 'assistant',
            content: commandResults.map(formatAgentCommandResult).join('\n\n'),
            actions: [],
          },
        ];
        await continueFromCurrentState('Continue from these completed audited commands. Use the command output and log paths as evidence, and propose the next exact action.');
        return;
      }

      const approvedReviewActions = getApprovedReviewActions(content);
      if (approvedReviewActions.length > 0) {
        const result = await executeApprovedReviewActions(approvedReviewActions);
        messages = [
          ...nextMessages,
          {
            role: 'assistant',
            content: formatExecutedReviewPlan(result),
            actions: [],
          },
        ];
        await continueFromCurrentState('Continue organizing from this completed review-plan execution. Propose the next read-only audits or review actions, and do not repeat completed actions.');
        return;
      }

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
        throw new Error(await getResponseError(response));
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
      bind:this={messagesContainer}
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
                  {#each message.actions as action, actionIndex (action.type + action.title)}
                    {@const actionKey = getActionKey(messageIndex, actionIndex)}
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
                      {#if action.type === 'agent_command' && action.command}
                        <pre
                          class="mt-2 overflow-x-auto rounded-md bg-gray-950 p-2 font-mono text-xs whitespace-pre-wrap text-gray-100"
                        >{action.command}</pre>
                      {/if}
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        {#if action.query}
                          <a class="inline-flex items-center gap-2 text-sm font-medium text-primary" href={getSearchHref(action)}>
                            <Icon icon={mdiMagnify} size="16" />
                            Open search
                            <Icon icon={mdiArrowRight} size="16" />
                          </a>
                        {/if}
                        {#if canCreateReviewAlbum(action, messageIndex)}
                          <Button
                            type="button"
                            size="small"
                            onclick={() => void createReviewAlbum(action, actionKey)}
                            disabled={applyingActionKey !== null}
                          >
                            <div class="flex items-center gap-2">
                              <Icon icon={mdiPlusBoxOutline} size="16" />
                              {getCreateReviewAlbumLabel(action)}
                            </div>
                          </Button>
                        {/if}
                        {#if canRunTool(action, messageIndex)}
                          <Button
                            type="button"
                            size="small"
                            onclick={() => void runTool(action, actionKey)}
                            disabled={runningToolActionKey !== null}
                          >
                            <div class="flex items-center gap-2">
                              <Icon icon={mdiRobotOutline} size="16" />
                              {runningToolActionKey === actionKey ? 'Running...' : getRunToolLabel(action)}
                            </div>
                          </Button>
                        {/if}
                        {#if canRunAgentCommandAction(action, messageIndex)}
                          <Button
                            type="button"
                            size="small"
                            onclick={() => void runAgentCommandAction(action)}
                            disabled={runningAgentCommand}
                          >
                            <div class="flex items-center gap-2">
                              <Icon icon={mdiConsoleLine} size="16" />
                              {runningAgentCommand ? 'Running...' : 'Run command'}
                            </div>
                          </Button>
                        {/if}
                        {#if isStaleActionMessage(messageIndex) && hasExecutableAction(action)}
                          <span class="text-xs text-gray-500">Outdated action</span>
                        {/if}
                      </div>
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
        <div class="flex items-center gap-2">
          <Button type="button" color="secondary" variant="outline" onclick={clearAssistantState} disabled={loading}>
            <div class="flex items-center gap-2">
              <Icon icon={mdiTrashCanOutline} size="16" />
              Clear
            </div>
          </Button>
          <Button type="button" onclick={() => void send()} disabled={loading || !prompt.trim()}>
            <div class="flex items-center gap-2">
              <Icon icon={mdiSend} size="16" />
              Send
            </div>
          </Button>
        </div>
      </div>
    </div>

    <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Icon icon={mdiConsoleLine} size="18" />
          Shell terminal
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <label class="flex items-center gap-2">
            target
            <select
              value={terminalTarget}
              class="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              disabled={runningAgentCommand}
              onchange={(event) => setTerminalTarget((event.currentTarget as HTMLSelectElement).value as AgentCommandTarget)}
            >
              {#each agentTargetOptions as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="flex items-center gap-2">
            cwd
            <input
              bind:value={terminalCwd}
              class="w-72 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              disabled={runningAgentCommand}
            />
          </label>
          <label class="flex items-center gap-2">
            timeout
            <input
              bind:value={terminalTimeoutSeconds}
              type="number"
              min="1"
              max="3600"
              class="w-20 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              disabled={runningAgentCommand}
            />
          </label>
        </div>
      </div>

      <Textarea
        bind:value={terminalCommand}
        rows={3}
        placeholder="Shell command, for example: exiftool -ver"
        disabled={runningAgentCommand}
        onkeydown={onTerminalKeydown}
      />
      <div class="mt-3 flex justify-end">
        <Button type="button" onclick={() => void runAgentCommand()} disabled={runningAgentCommand || !terminalCommand.trim()}>
          <div class="flex items-center gap-2">
            <Icon icon={mdiPlay} size="16" />
            {runningAgentCommand ? 'Running...' : 'Run command'}
          </div>
        </Button>
      </div>

      {#if terminalEntries.length > 0}
        <div class="mt-3 max-h-72 overflow-y-auto rounded-md bg-gray-950 p-3 font-mono text-xs text-gray-100">
          {#each terminalEntries as entry (entry.id)}
            <div class="border-b border-gray-800 py-3 first:pt-0 last:border-b-0 last:pb-0">
              <div class="text-gray-400">
                $ {entry.command}
              </div>
              <div class="mt-1 text-gray-500">
                {entry.target ?? 'local'}{entry.targetKind ? ` (${entry.targetKind})` : ''} | {entry.cwd ?? 'cwd unavailable'} | {formatAgentStatus(entry)}
              </div>
              {#if entry.stdout}
                <pre class="mt-2 overflow-x-auto whitespace-pre-wrap text-gray-100">{entry.stdout}{entry.stdoutTruncated ? '\n... stdout truncated inline; see log ...' : ''}</pre>
              {/if}
              {#if entry.stderr}
                <pre class="mt-2 overflow-x-auto whitespace-pre-wrap text-red-300">{entry.stderr}{entry.stderrTruncated ? '\n... stderr truncated inline; see log ...' : ''}</pre>
              {/if}
              {#if entry.hostLogFilePath || entry.serverLogFilePath}
                <div class="mt-2 whitespace-pre-wrap text-gray-500">
                  {entry.hostLogFilePath ? `Host log: ${entry.hostLogFilePath}` : ''}
                  {entry.hostLogFilePath && entry.serverLogFilePath ? '\n' : ''}
                  {entry.serverLogFilePath ? `Server log: ${entry.serverLogFilePath}` : ''}
                </div>
              {/if}
              {#if entry.message}
                <div class="mt-2 text-yellow-300">{entry.message}</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

  </div>
</UserPageLayout>
