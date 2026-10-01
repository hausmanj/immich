<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import DuplicateAsset from './DuplicateAsset.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { getNextAsset, getPreviousAsset } from '$lib/utils/asset-utils';
  import {
    computeDifferingMetadataFields,
    countDifferingMetadataItems,
    getFolderOrganizationScore,
    type DifferingMetadataFields,
  } from '$lib/utils/duplicate-utils';
  import { navigate } from '$lib/utils/navigation';
  import { DuplicateClassification, getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { Button, Icon } from '@immich/ui';
  import {
    mdiAlert,
    mdiCalendarAlert,
    mdiCheck,
    mdiChevronDown,
    mdiChevronUp,
    mdiEyeCheckOutline,
    mdiImageMultipleOutline,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

  interface Props {
    assets: AssetResponseDto[];
    classification?: DuplicateClassification;
    suggestedKeepAssetIds: string[];
    betterQualityOutsideOriginals?: boolean;
    betterQualityAssetIds?: string[];
    hasSuspectDate?: boolean;
    suspectAssetIds?: string[];
    showMore: boolean;
    onResolve: (duplicateAssetIds: string[], trashIds: string[]) => void;
    onStack: (assets: AssetResponseDto[]) => void;
  }

  let {
    assets,
    classification = DuplicateClassification.PossibleDuplicate,
    suggestedKeepAssetIds,
    betterQualityOutsideOriginals = false,
    betterQualityAssetIds = [],
    hasSuspectDate = false,
    suspectAssetIds = [],
    onResolve,
    onStack,
    showMore = $bindable(),
  }: Props = $props();

  const EVIDENCE = {
    [DuplicateClassification.Exact]: { key: 'duplicate_checksum_match', reviewOnly: false },
    [DuplicateClassification.ContentIdentical]: { key: 'duplicate_content_identical', reviewOnly: false },
    [DuplicateClassification.HighConfidenceDuplicate]: { key: 'duplicate_high_confidence', reviewOnly: true },
    [DuplicateClassification.PossibleDuplicate]: { key: 'duplicate_similarity_only', reviewOnly: true },
    [DuplicateClassification.Unanalyzed]: { key: 'duplicate_unanalyzed', reviewOnly: true },
  } as const;

  const evidence = $derived(EVIDENCE[classification] ?? EVIDENCE[DuplicateClassification.PossibleDuplicate]);
  // eslint-disable-next-line svelte/no-unnecessary-state-wrap
  let selectedAssetIds = $state(new SvelteSet<string>());
  let trashCount = $derived(assets.length - selectedAssetIds.size);

  const InitialVisibleCount = 5;

  const differingMetadataFields: DifferingMetadataFields = $derived(computeDifferingMetadataFields(assets));
  const differingCount = $derived(countDifferingMetadataItems(differingMetadataFields));
  const hasMore = $derived(differingCount > InitialVisibleCount);

  const comparisonSummary = $derived((() => {
    if (assets.length < 2) return null;
    const a = assets[0];
    const b = assets[1];
    const dimA = a.width && a.height ? `${a.width}×${a.height}` : null;
    const dimB = b.width && b.height ? `${b.width}×${b.height}` : null;
    const mpA = a.width && a.height ? `${((a.width * a.height) / 1e6).toFixed(1)} MP` : '';
    const mpB = b.width && b.height ? `${((b.width * b.height) / 1e6).toFixed(1)} MP` : '';

    let isThumb = false;
    let scalePercent = '';
    if (a.width && a.height && b.width && b.height) {
      const wRatio = Math.min(a.width, b.width) / Math.max(a.width, b.width);
      if (wRatio < 0.6) {
        isThumb = true;
        scalePercent = `${(wRatio * 100).toFixed(0)}% scale`;
      }
    }

    return { dimA, dimB, mpA, mpB, isThumb, scalePercent };
  })());

  const locationOrganizedAssetIds = $derived((() => {
    if (assets.length < 2) return new Set<string>();
    const scored = assets.map((a) => ({
      id: a.id,
      score: getFolderOrganizationScore(a.originalPath),
    }));
    const maxDescriptive = Math.max(...scored.map((s) => s.score.descriptiveSegmentsCount));
    const minDescriptive = Math.min(...scored.map((s) => s.score.descriptiveSegmentsCount));
    const maxDepth = Math.max(...scored.map((s) => s.score.depth));
    const minDepth = Math.min(...scored.map((s) => s.score.depth));

    if (maxDescriptive > minDescriptive || (maxDescriptive > 0 && maxDepth > minDepth)) {
      return new Set(
        scored
          .filter(
            (s) =>
              s.score.descriptiveSegmentsCount === maxDescriptive &&
              (maxDescriptive > minDescriptive || s.score.depth === maxDepth),
          )
          .map((s) => s.id),
      );
    }
    return new Set<string>();
  })());

  onMount(() => {
    if (suggestedKeepAssetIds.length > 0) {
      for (const id of suggestedKeepAssetIds) {
        selectedAssetIds.add(id);
      }
      return;
    }

    if (assets.length > 0) {
      selectedAssetIds.add(assets[0].id);
    }
  });

  onDestroy(() => {
    assetViewerManager.showAssetViewer(false);
  });

  const onRandom = async () => {
    if (assets.length === 0) {
      return;
    }
    const index = Math.floor(Math.random() * assets.length);
    const asset = assets[index];
    await onViewAsset(asset);
    return { id: asset.id };
  };

  const onSelectAsset = (asset: AssetResponseDto) => {
    if (selectedAssetIds.has(asset.id)) {
      selectedAssetIds.delete(asset.id);
    } else {
      selectedAssetIds.add(asset.id);
    }
  };

  const onSelectNone = () => {
    selectedAssetIds.clear();
  };

  const onSelectAll = () => {
    selectedAssetIds = new SvelteSet(assets.map((asset) => asset.id));
  };

  const onViewAsset = async ({ id }: AssetResponseDto) => {
    const asset = await getAssetInfo({ ...authManager.params, id });
    assetViewerManager.setAsset(asset);
    await navigate({ targetRoute: 'current', assetId: asset.id });
  };

  const handleResolve = () => {
    const trashIds = assets.map((asset) => asset.id).filter((id) => !selectedAssetIds.has(id));
    const duplicateAssetIds = assets.map((asset) => asset.id);
    onResolve(duplicateAssetIds, trashIds);
  };

  const handleStack = () => {
    onStack(assets);
  };

  const assetCursor = $derived({
    current: assetViewerManager.asset!,
    nextAsset: getNextAsset(assets, assetViewerManager.asset),
    previousAsset: getPreviousAsset(assets, assetViewerManager.asset),
  });
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'a' }, onShortcut: onSelectAll },
    {
      shortcut: { key: 's' },
      onShortcut: () => onViewAsset(assets[0]),
    },
    { shortcut: { key: 'd' }, onShortcut: onSelectNone },
    { shortcut: { key: 'c', shift: true }, onShortcut: handleResolve },
    { shortcut: { key: 's', shift: true }, onShortcut: handleStack },
  ]}
/>

<div class="px-0.2 mx-auto mb-4 max-w-5xl rounded-3xl border border-gray-300 py-6 dark:border-2 dark:border-gray-700">
  <!-- WHY THIS GROUP EXISTS & COMPARISON DETAILS -->
  <div class="mb-4 flex flex-col gap-1.5 px-6 text-xs">
    <div class="flex items-center gap-2">
      <Icon icon={evidence.reviewOnly ? mdiEyeCheckOutline : mdiCheck} size="18" class="shrink-0" />
      <span class="font-medium text-gray-700 dark:text-gray-200">{$t(evidence.key)}</span>
    </div>
    {#if comparisonSummary}
      <div class="flex flex-wrap items-center gap-2 pt-1 text-gray-500 dark:text-gray-400">
        {#if comparisonSummary.isThumb}
          <span class="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Preview / Thumbnail Match ({comparisonSummary.scalePercent})
          </span>
        {/if}
        {#if comparisonSummary.dimA && comparisonSummary.dimB}
          <span class="rounded bg-gray-100 px-2 py-0.5 font-mono dark:bg-gray-800">
            {comparisonSummary.dimA} ({comparisonSummary.mpA}) vs {comparisonSummary.dimB} ({comparisonSummary.mpB})
          </span>
        {/if}
      </div>
    {/if}
    {#if betterQualityOutsideOriginals}
      <div class="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        <div class="flex items-center gap-2 font-semibold">
          <Icon icon={mdiAlert} size="18" class="text-amber-600 dark:text-amber-400" />
          <span>Higher Quality Copy Outside Originals!</span>
        </div>
        <p class="mt-1 text-amber-800 dark:text-amber-300">
          A duplicate outside the originals folder has higher resolution or quality than the copy in originals. Both copies are preserved to prevent deletion so you can migrate the higher-quality file to originals manually.
        </p>
      </div>
    {/if}

    {#if hasSuspectDate}
      <div class="mt-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
        <div class="flex items-center gap-2 font-semibold">
          <Icon icon={mdiCalendarAlert} size="18" class="text-rose-600 dark:text-rose-400" />
          <span>Suspect EXIF Date (May–August 2015 or 2021)</span>
        </div>
        <p class="mt-1 text-rose-800 dark:text-rose-300">
          Photo(s) in this group have capture dates affected by a previous Claude EXIF batch date error. Verify timestamps before archiving.
        </p>
      </div>
    {/if}
  </div>

  <div class="mb-4 flex w-full flex-wrap place-content-end justify-between gap-y-6 px-6">
    <!-- MARK ALL BUTTONS -->
    <div class="flex text-xs text-black">
      <Button class="rounded-s-full" size="small" color="primary" leadingIcon={mdiCheck} onclick={onSelectAll}
        >{$t('select_keep_all')}</Button
      >
      <Button
        class="rounded-e-full"
        size="small"
        color="secondary"
        leadingIcon={mdiTrashCanOutline}
        onclick={onSelectNone}>{$t('select_trash_all')}</Button
      >
    </div>

    <!-- CONFIRM BUTTONS -->
    <div class="flex text-xs text-black">
      {#if trashCount === 0}
        <Button
          size="small"
          leadingIcon={mdiCheck}
          color="success"
          class="flex place-items-center gap-2 rounded-s-full"
          onclick={handleResolve}
        >
          {$t('keep_all')}
        </Button>
      {:else}
        <Button
          size="small"
          color="danger"
          leadingIcon={mdiTrashCanOutline}
          class="rounded-s-full"
          onclick={handleResolve}
        >
          {trashCount === assets.length ? $t('trash_all') : $t('trash_count', { values: { count: trashCount } })}
        </Button>
      {/if}
      <Button
        size="small"
        color="primary"
        leadingIcon={mdiImageMultipleOutline}
        class="rounded-e-full"
        onclick={handleStack}
        disabled={selectedAssetIds.size !== 1}
      >
        {$t('stack')}
      </Button>
    </div>
  </div>

  <div class="overflow-x-auto p-2">
    <div class="mx-auto flex w-fit min-w-full flex-nowrap place-items-start justify-center gap-1">
      {#each assets as asset (asset.id)}
        <DuplicateAsset
          {asset}
          {onSelectAsset}
          isSelected={selectedAssetIds.has(asset.id)}
          {onViewAsset}
          {differingMetadataFields}
          {showMore}
          initialVisibleCount={InitialVisibleCount}
          isBetterQuality={betterQualityAssetIds.includes(asset.id)}
          isSuspectDate={suspectAssetIds.includes(asset.id)}
          groupHasBetterQuality={betterQualityOutsideOriginals}
          isOriginals={/\/(originals|originals_clean)\b/i.test(asset.originalPath)}
          isUploadsMacbookPro={/\/uploads_macbookpro\b/i.test(asset.originalPath)}
          hasLocationDescription={locationOrganizedAssetIds.has(asset.id)}
        />
      {/each}
    </div>
  </div>

  {#if hasMore}
    <div class="flex justify-center pb-2">
      <Button size="small" variant="ghost" color="secondary" onclick={() => (showMore = !showMore)}>
        <Icon icon={showMore ? mdiChevronUp : mdiChevronDown} size="18" class="me-1" />
        {showMore
          ? $t('show_less')
          : $t('show_more_fields', { values: { count: differingCount - InitialVisibleCount } })}
      </Button>
    </div>
  {/if}
</div>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        cursor={assetCursor}
        showNavigation={assets.length > 1}
        {onRandom}
        onClose={() => {
          assetViewerManager.showAssetViewer(false);
          handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
        }}
      />
    </Portal>
  {/await}
{/if}
