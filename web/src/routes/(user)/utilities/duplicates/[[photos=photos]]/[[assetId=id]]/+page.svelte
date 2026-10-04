<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { shortcuts } from '$lib/actions/shortcut';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import LinkToDocs from './LinkToDocs.svelte';
  import DuplicatesCompareControl from './DuplicatesCompareControl.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import ShortcutsModal from '$lib/modals/ShortcutsModal.svelte';
  import DeduplicateModal from '$lib/modals/DeduplicateModal.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import type { AssetResponseDto } from '@immich/sdk';
  import { createStack, deleteDuplicates, DuplicateClassification, resolveDuplicates, updateAssets } from '@immich/sdk';
  import { Button, HStack, IconButton, LoadingSpinner, modalManager, Text, toastManager } from '@immich/ui';
  import {
    mdiCheckOutline,
    mdiChevronLeft,
    mdiChevronRight,
    mdiFolderDownloadOutline,
    mdiKeyboard,
    mdiPageFirst,
    mdiPageLast,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { copyBetterToHolding } from '$lib/utils/duplicate-utils';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data = $bindable() }: Props = $props();

  interface Shortcuts {
    general: ExplainedShortcut[];
    actions: ExplainedShortcut[];
  }
  interface ExplainedShortcut {
    key: string[];
    action: string;
    info?: string;
  }

  const duplicateShortcuts: Shortcuts = {
    general: [],
    actions: [
      { key: ['a'], action: $t('select_all_duplicates') },
      { key: ['s'], action: $t('view') },
      { key: ['d'], action: $t('unselect_all_duplicates') },
      { key: ['⇧', 'c'], action: $t('resolve_duplicates') },
      { key: ['⇧', 's'], action: $t('stack_duplicates') },
    ],
  };

  // Must match AUTO_RESOLVABLE_CLASSIFICATIONS on the server: proven identical bytes, or proven
  // identical decoded pixels. Everything weaker is review evidence and the server will refuse it.
  const AUTO_RESOLVABLE = new Set<DuplicateClassification>([
    DuplicateClassification.Exact,
    DuplicateClassification.ContentIdentical,
    DuplicateClassification.HighConfidenceDuplicate,
  ]);

  let duplicates = $state(data.duplicates);
  let showMore = $state(false);

  $effect(() => {
    duplicates = data.duplicates;
  });

  let isDeduplicating = $state(false);
  let progressCurrent = $state(0);
  let progressTotal = $state(0);
  let progressTrashed = $state(0);
  let currentBatch = $state(0);
  let totalBatches = $state(0);
  const progressPercent = $derived(
    progressTotal > 0 ? Math.min(100, Math.round((progressCurrent / progressTotal) * 100)) : 0,
  );

  let mediaFilter = $state<'all' | 'photo' | 'video'>('all');

  $effect(() => {
    const mediaParam = page.url.searchParams.get('media');
    if (mediaParam === 'video' || mediaParam === 'videos') {
      mediaFilter = 'video';
    } else if (mediaParam === 'photo' || mediaParam === 'photos') {
      mediaFilter = 'photo';
    }
  });

  const photoDuplicates = $derived(duplicates.filter((g) => g.assets.some((a) => a.type === 'IMAGE')));
  const videoDuplicates = $derived(duplicates.filter((g) => g.assets.some((a) => a.type === 'VIDEO')));

  const activeDuplicates = $derived(
    mediaFilter === 'video'
      ? videoDuplicates
      : mediaFilter === 'photo'
        ? photoDuplicates
        : duplicates,
  );

  const correctDuplicatesIndex = (index: number) => {
    return Math.max(0, Math.min(index, activeDuplicates.length - 1));
  };

  let duplicatesIndex = $derived(
    (() => {
      const indexParam = page.url.searchParams.get('index') ?? '0';
      const parsedIndex = Math.trunc(Number(indexParam));
      return correctDuplicatesIndex(Number.isNaN(parsedIndex) ? 0 : parsedIndex);
    })(),
  );

  let hasDuplicates = $derived(activeDuplicates.length > 0);
  const withConfirmation = async (callback: () => Promise<void>, prompt?: string, confirmText?: string) => {
    if (prompt && confirmText) {
      const isConfirmed = await modalManager.showDialog({ prompt, confirmText });
      if (!isConfirmed) {
        return;
      }
    }

    try {
      return await callback();
    } catch (error) {
      handleError(error, $t('errors.unable_to_resolve_duplicate'));
    }
  };

  const deletedNotification = (trashedCount: number) => {
    if (!trashedCount) {
      return;
    }

    const message = featureFlagsManager.value.trash
      ? $t('assets_moved_to_trash_count', { values: { count: trashedCount } })
      : $t('permanently_deleted_assets_count', { values: { count: trashedCount } });
    toastManager.primary(message);
  };

  const handleResolve = async (duplicateId: string, duplicateAssetIds: string[], trashIds: string[]) => {
    const forceDelete = !featureFlagsManager.value.trash;
    const shouldConfirmDelete = trashIds.length > 0 && forceDelete;

    return withConfirmation(
      async () => {
        const keepAssetIds = duplicateAssetIds.filter((id) => !trashIds.includes(id));

        const response = await resolveDuplicates({
          duplicateResolveDto: {
            // The user is looking at this specific group right now, which is what authorises
            // trashing from a visual-similarity match.
            groups: [{ duplicateId, keepAssetIds, trashAssetIds: trashIds, reviewed: true }],
          },
        });

        const { success, error, errorMessage } = response[0];
        if (!success) {
          throw new Error(errorMessage || error);
        }

        duplicates = duplicates.filter((duplicate) => duplicate.duplicateId !== duplicateId);

        deletedNotification(trashIds.length);
        await navigateToIndex(duplicatesIndex);
      },
      shouldConfirmDelete ? $t('delete_duplicates_confirmation') : undefined,
      shouldConfirmDelete ? $t('permanently_delete') : undefined,
    );
  };

  const handleStack = async (duplicateId: string, assets: AssetResponseDto[]) => {
    const [primaryAsset, ...duplicateAssets] = assets;
    const assetIds = duplicateAssets.map((asset) => asset.id);

    await createStack({ stackCreateDto: { assetIds: [primaryAsset.id, ...assetIds] } });
    await updateAssets({ assetBulkUpdateDto: { ids: assetIds, duplicateId: null } });
    duplicates = duplicates.filter((duplicate) => duplicate.duplicateId !== duplicateId);
    await navigateToIndex(duplicatesIndex);
  };

  const handleDeduplicateAll = async () => {
    const selectedGroups = await modalManager.show(DeduplicateModal, { duplicates });
    if (!selectedGroups || selectedGroups.length === 0) {
      return;
    }

    const idsToDelete = selectedGroups.flatMap((group) => {
      const keepIds = new Set(
        group.suggestedKeepAssetIds?.length > 0 ? group.suggestedKeepAssetIds : [group.assets[0]?.id],
      );
      return group.assets.map((asset) => asset.id).filter((id) => !keepIds.has(id));
    });

    if (idsToDelete.length === 0) {
      return;
    }

    toastManager.primary('Processing deduplication…');

    // Resolve selected groups in batches of 250
    const batchSize = 250;
    isDeduplicating = true;
    progressCurrent = 0;
    progressTotal = selectedGroups.length;
    progressTrashed = 0;
    currentBatch = 0;
    totalBatches = Math.ceil(selectedGroups.length / batchSize);

    let failedCount = 0;
    let totalResolvedGroups = 0;
    let totalTrashedAssets = 0;

    try {
      for (let i = 0; i < selectedGroups.length; i += batchSize) {
        currentBatch++;
        const batch = selectedGroups.slice(i, i + batchSize);
        try {
          const response = await resolveDuplicates({
            duplicateResolveDto: {
              groups: batch.map((group) => {
                const keepAssetIds =
                  group.suggestedKeepAssetIds?.length > 0 ? group.suggestedKeepAssetIds : [group.assets[0]?.id];
                const keepIds = new Set(keepAssetIds);
                return {
                  duplicateId: group.duplicateId,
                  keepAssetIds,
                  trashAssetIds: group.assets.map((asset) => asset.id).filter((id) => !keepIds.has(id)),
                  reviewed: true,
                };
              }),
            },
          });

          const successfulIds = new Set(response.filter(({ success }) => success).map(({ id }) => id));
          if (successfulIds.size > 0) {
            totalResolvedGroups += successfulIds.size;
            progressCurrent += successfulIds.size;
            for (const g of batch) {
              if (successfulIds.has(g.duplicateId)) {
                const keepIds = new Set(
                  g.suggestedKeepAssetIds?.length > 0 ? g.suggestedKeepAssetIds : [g.assets[0]?.id],
                );
                const trashedInGroup = g.assets.filter((a) => !keepIds.has(a.id)).length;
                totalTrashedAssets += trashedInGroup;
                progressTrashed += trashedInGroup;
              }
            }
            duplicates = duplicates.filter(({ duplicateId }) => !successfulIds.has(duplicateId));
          } else {
            progressCurrent += batch.length;
          }

          const batchFailed = response.filter(({ success }) => !success).length;
          failedCount += batchFailed;
        } catch (error) {
          console.error('Error resolving duplicate batch:', error);
          failedCount += batch.length;
          progressCurrent += batch.length;
        }
      }
    } finally {
      isDeduplicating = false;
    }

    if (failedCount > 0 && totalResolvedGroups === 0) {
      toastManager.danger($t('errors.unable_to_resolve_duplicate'));
    } else if (totalTrashedAssets > 0) {
      deletedNotification(totalTrashedAssets);
    }

    page.url.searchParams.delete('index');
    await goto(Route.duplicatesUtility());
  };

  const handleKeepAll = async () => {
    const ids = duplicates.map(({ duplicateId }) => duplicateId);
    return withConfirmation(
      async () => {
        await deleteDuplicates({ bulkIdsDto: { ids } });

        duplicates = [];

        toastManager.primary($t('resolved_all_duplicates'));
        page.url.searchParams.delete('index');
        await goto(Route.duplicatesUtility());
      },
      $t('bulk_keep_duplicates_confirmation', { values: { count: ids.length } }),
      $t('confirm'),
    );
  };

  let isCopyingHolding = $state(false);
  const betterQualityCount = $derived(duplicates.filter((d) => d.betterQualityOutsideOriginals).length);
  const betterQualityAssetsCount = $derived(
    duplicates.reduce((acc, d) => acc + (d.betterQualityAssetIds?.length || (d.betterQualityOutsideOriginals ? 1 : 0)), 0),
  );

  const handleCopyBetterToHolding = async () => {
    isCopyingHolding = true;
    try {
      const res = await copyBetterToHolding();
      if (res.failed > 0 && res.copied === 0 && res.alreadyExisted === 0) {
        toastManager.danger(res.errors[0] || 'Failed to copy better copies to holding');
      } else {
        const msg = `Copied ${res.copied} better quality files to holding folder (${res.alreadyExisted} already in holding)`;
        toastManager.primary(msg);
      }
    } catch (err: any) {
      toastManager.danger(err.message || 'Error copying better copies to holding');
    } finally {
      isCopyingHolding = false;
    }
  };

  const handleFirst = () => navigateToIndex(0);
  const handlePrevious = () => navigateToIndex(Math.max(duplicatesIndex - 1, 0));
  const handleNext = async () => navigateToIndex(Math.min(duplicatesIndex + 1, activeDuplicates.length - 1));
  const handleLast = () => navigateToIndex(activeDuplicates.length - 1);

  const navigateToIndex = async (index: number) =>
    goto(
      Route.duplicatesUtility({
        index: correctDuplicatesIndex(index),
        media: mediaFilter !== 'all' ? mediaFilter : undefined,
      }),
    );

  const switchMediaFilter = async (newFilter: 'all' | 'photo' | 'video') => {
    mediaFilter = newFilter;
    await goto(
      Route.duplicatesUtility({
        index: 0,
        media: newFilter !== 'all' ? newFilter : undefined,
      }),
    );
  };
</script>

<svelte:document
  use:shortcuts={assetViewerManager.isViewing
    ? []
    : [
        { shortcut: { key: 'ArrowLeft' }, onShortcut: handlePrevious },
        { shortcut: { key: 'ArrowRight' }, onShortcut: handleNext },
      ]}
/>

<UserPageLayout title={data.meta.title + ` (${activeDuplicates.length.toLocaleString($locale)})`} scrollbar={true}>
  {#snippet buttons()}
    <HStack gap={2}>
      {#if isDeduplicating}
        <div class="flex items-center gap-2 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary dark:bg-primary/20">
          <LoadingSpinner size="small" />
          <span>
            {progressCurrent.toLocaleString($locale)} / {progressTotal.toLocaleString($locale)} ({progressPercent}%)
          </span>
          <span class="hidden xl:inline text-muted-foreground font-normal">
            • {progressTrashed.toLocaleString($locale)} trashed
          </span>
        </div>
      {/if}
      <Button
        leadingIcon={mdiFolderDownloadOutline}
        onclick={() => handleCopyBetterToHolding()}
        disabled={isCopyingHolding || isDeduplicating}
        loading={isCopyingHolding}
        size="small"
        variant={betterQualityCount > 0 ? 'filled' : 'ghost'}
        color={betterQualityCount > 0 ? 'warning' : 'secondary'}
        title="Copy higher-quality duplicates outside originals to holding folder mirroring originals folder structure"
      >
        <Text class="hidden md:block">
          {#if isCopyingHolding}
            Copying…
          {:else if betterQualityAssetsCount > 0}
            Copy Better to Holding ({betterQualityAssetsCount})
          {:else}
            Copy Better to Holding
          {/if}
        </Text>
      </Button>
      <Button
        leadingIcon={isDeduplicating ? undefined : mdiTrashCanOutline}
        onclick={() => handleDeduplicateAll()}
        disabled={!hasDuplicates || isDeduplicating}
        loading={isDeduplicating}
        size="small"
        variant={isDeduplicating ? 'filled' : 'ghost'}
        color={isDeduplicating ? 'primary' : 'secondary'}
      >
        <Text class="hidden md:block">
          {#if isDeduplicating}
            {progressPercent}%
          {:else}
            {$t('deduplicate_all')}
          {/if}
        </Text>
      </Button>
      <Button
        leadingIcon={mdiCheckOutline}
        onclick={() => handleKeepAll()}
        disabled={!hasDuplicates || isDeduplicating}
        size="small"
        variant="ghost"
        color="secondary"
      >
        <Text class="hidden md:block">{$t('keep_all')}</Text>
      </Button>
      <IconButton
        shape="round"
        variant="ghost"
        color="secondary"
        icon={mdiKeyboard}
        title={$t('show_keyboard_shortcuts')}
        onclick={() => modalManager.show(ShortcutsModal, { shortcuts: duplicateShortcuts })}
        aria-label={$t('show_keyboard_shortcuts')}
      />
    </HStack>
  {/snippet}

  <div>
    <!-- MEDIA FILTER TOGGLE TABS -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="inline-flex rounded-xl bg-gray-100 p-1 dark:bg-gray-800 shadow-inner">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors {mediaFilter === 'all'
            ? 'bg-white shadow text-primary dark:bg-gray-700 dark:text-white'
            : 'text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white'}"
          onclick={() => switchMediaFilter('all')}
        >
          All Duplicates {mediaFilter === 'all' ? `(${duplicates.length.toLocaleString($locale)})` : ''}
        </button>
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors {mediaFilter === 'photo'
            ? 'bg-white shadow text-primary dark:bg-gray-700 dark:text-white'
            : 'text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white'}"
          onclick={() => switchMediaFilter('photo')}
        >
          📷 Photos {mediaFilter === 'photo' ? `(${duplicates.length.toLocaleString($locale)})` : (mediaFilter === 'all' ? `(${photoDuplicates.length.toLocaleString($locale)})` : '')}
        </button>
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors {mediaFilter === 'video'
            ? 'bg-white shadow text-primary dark:bg-gray-700 dark:text-white'
            : 'text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white'}"
          onclick={() => switchMediaFilter('video')}
        >
          🎬 Videos {mediaFilter === 'video' ? `(${duplicates.length.toLocaleString($locale)})` : (mediaFilter === 'all' ? `(${videoDuplicates.length.toLocaleString($locale)})` : '')}
        </button>
      </div>
    </div>

    {#if isDeduplicating}
      <div class="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-sm dark:bg-primary/10">
        <div class="flex items-center justify-between text-sm mb-2 font-medium">
          <span class="flex items-center gap-2 text-primary font-semibold">
            <LoadingSpinner size="small" />
            Deduplicating in progress…
          </span>
          <span class="font-mono text-xs font-semibold text-primary">
            {progressCurrent.toLocaleString($locale)} / {progressTotal.toLocaleString($locale)} groups ({progressPercent}%)
          </span>
        </div>
        <div class="h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            class="h-full rounded-full bg-primary transition-all duration-300 ease-out"
            style="width: {progressPercent}%"
          ></div>
        </div>
        <div class="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{progressTrashed.toLocaleString($locale)} duplicate assets moved to trash</span>
          <span>Batch {currentBatch} of {totalBatches}</span>
        </div>
      </div>
    {/if}

    {#if activeDuplicates && activeDuplicates.length > 0}
      <Text size="small" color="muted" class="mb-4">
        <p>{$t('duplicates_description')} <LinkToDocs href="https://docs.immich.app/features/duplicates-utility" /></p>
      </Text>

      {#key activeDuplicates[duplicatesIndex].duplicateId}
        <DuplicatesCompareControl
          duplicateId={activeDuplicates[duplicatesIndex].duplicateId}
          assets={activeDuplicates[duplicatesIndex].assets}
          classification={activeDuplicates[duplicatesIndex].classification}
          suggestedKeepAssetIds={activeDuplicates[duplicatesIndex].suggestedKeepAssetIds}
          betterQualityOutsideOriginals={activeDuplicates[duplicatesIndex].betterQualityOutsideOriginals}
          betterQualityAssetIds={activeDuplicates[duplicatesIndex].betterQualityAssetIds}
          hasSuspectDate={activeDuplicates[duplicatesIndex].hasSuspectDate}
          suspectAssetIds={activeDuplicates[duplicatesIndex].suspectAssetIds}
          bind:showMore
          onResolve={(duplicateAssetIds, trashIds) =>
            handleResolve(activeDuplicates[duplicatesIndex].duplicateId, duplicateAssetIds, trashIds)}
          onStack={(assets) => handleStack(activeDuplicates[duplicatesIndex].duplicateId, assets)}
        />
        <div class="mx-auto mb-16 max-w-5xl">
          <div class="mb-4 flex w-full place-content-center place-items-center items-center justify-between sm:px-6">
            <div class="flex text-xs text-black">
              <Button
                size="small"
                leadingIcon={mdiPageFirst}
                color="primary"
                class="flex place-items-center gap-2 rounded-s-full px-2 sm:px-4"
                onclick={handleFirst}
                disabled={duplicatesIndex === 0}
              >
                {$t('first')}
              </Button>
              <Button
                size="small"
                leadingIcon={mdiChevronLeft}
                color="primary"
                class="flex place-items-center gap-2 rounded-e-full px-2 sm:px-4"
                onclick={handlePrevious}
                disabled={duplicatesIndex === 0}
              >
                {$t('previous')}
              </Button>
            </div>
            <p class="rounded-lg border px-3 py-1 text-xs md:px-6 md:text-sm dark:bg-subtle">
              {duplicatesIndex + 1} / {activeDuplicates.length.toLocaleString($locale)}
            </p>
            <div class="flex text-xs text-black">
              <Button
                size="small"
                trailingIcon={mdiChevronRight}
                color="primary"
                class="flex place-items-center gap-2 rounded-s-full px-2 sm:px-4"
                onclick={handleNext}
                disabled={duplicatesIndex === activeDuplicates.length - 1}
              >
                {$t('next')}
              </Button>
              <Button
                size="small"
                trailingIcon={mdiPageLast}
                color="primary"
                class="flex place-items-center gap-2 rounded-e-full px-2 sm:px-4"
                onclick={handleLast}
                disabled={duplicatesIndex === activeDuplicates.length - 1}
              >
                {$t('last')}
              </Button>
            </div>
          </div>
        </div>
      {/key}
    {:else}
      <p class="flex place-content-center place-items-center text-center text-lg dark:text-white py-12">
        {#if mediaFilter === 'video'}
          No video duplicates found.
        {:else if mediaFilter === 'photo'}
          No photo duplicates found.
        {:else}
          {$t('no_duplicates_found')}
        {/if}
      </p>
    {/if}
  </div>
</UserPageLayout>
