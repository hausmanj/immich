<script lang="ts">
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import ArchiveAction from '$lib/components/timeline/actions/ArchiveAction.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '$lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import LinkLivePhotoAction from '$lib/components/timeline/actions/LinkLivePhotoAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { AssetAction } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { memoryManager } from '$lib/managers/memory-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { getStackBulkActions } from '$lib/services/stack.service';
  import { getAssetMediaUrl, memoryLaneTitle } from '$lib/utils';
  import { type OnLink, type OnUnlink } from '$lib/utils/actions';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { AssetVisibility } from '@immich/sdk';
  import MemoryCard from '$lib/components/memories/MemoryCard.svelte';
  import { page } from '$app/state';
  import { ActionButton, CommandPaletteDefaultProvider, Icon, ImageCarousel } from '@immich/ui';
  import { mdiCheckAll, mdiClose, mdiDotsVertical, mdiFilterVariant } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let timelineManager = $state<TimelineManager>() as TimelineManager;

  const SIZE_PRESETS = [
    { label: 'All', value: null },
    { label: '< 50 KB', value: 50 * 1024 },
    { label: '< 100 KB', value: 100 * 1024 },
    { label: '< 250 KB', value: 250 * 1024 },
    { label: '< 500 KB', value: 500 * 1024 },
    { label: '< 1 MB', value: 1024 * 1024 },
  ];

  const FORMAT_PRESETS = [
    { label: 'All Formats', value: null },
    { label: 'PNG', value: 'png' },
    { label: 'JPG / JPEG', value: 'jpg' },
    { label: 'GIF', value: 'gif' },
    { label: 'HEIC', value: 'heic' },
  ];

  let selectedSizeLimit = $state<number | null>(() => {
    const param = page.url.searchParams.get('maxSize');
    if (param && !isNaN(Number(param))) {
      return Number(param);
    }
    return null;
  });
  let selectedFormat = $state<string | null>(() => page.url.searchParams.get('format') ?? null);
  let customKbInput = $state<string>('');

  const selectPreset = (value: number | null) => {
    selectedSizeLimit = value;
    customKbInput = '';
  };

  const selectFormatPreset = (value: string | null) => {
    selectedFormat = value;
  };

  const applyCustomKb = () => {
    const kb = parseFloat(customKbInput.trim());
    if (!isNaN(kb) && kb > 0) {
      selectedSizeLimit = Math.round(kb * 1024);
    }
  };

  const clearFilter = () => {
    selectedSizeLimit = null;
    customKbInput = '';
  };

  const clearFormatFilter = () => {
    selectedFormat = null;
  };

  const clearAllFilters = () => {
    selectedSizeLimit = null;
    selectedFormat = null;
    customKbInput = '';
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const options = $derived({
    visibility: AssetVisibility.Timeline,
    withStacked: true,
    withPartners: true,
    ...(selectedSizeLimit !== null ? { sizeLessThan: selectedSizeLimit } : {}),
    ...(selectedFormat ? { format: selectedFormat } : {}),
  });

  let loadedAssetsCount = $derived.by(() => {
    if (!timelineManager?.months) return 0;
    let count = 0;
    for (const month of timelineManager.months) {
      for (const day of month.timelineDays) {
        count += day.viewerAssets.length;
      }
    }
    return count;
  });

  const selectLoadedAssets = () => {
    if (!timelineManager?.months) return;
    const loaded: TimelineAsset[] = [];
    for (const month of timelineManager.months) {
      for (const day of month.timelineDays) {
        for (const va of day.viewerAssets) {
          if (va.asset) {
            loaded.push(va.asset);
          }
        }
      }
    }
    if (loaded.length > 0) {
      assetMultiSelectManager.selectAssets(loaded);
    }
  };

  let selectedAssets = $derived(assetMultiSelectManager.assets);
  let isLinkActionAvailable = $derived.by(() => {
    const isLivePhoto = selectedAssets.length === 1 && !!selectedAssets[0].livePhotoVideoId;
    const isLivePhotoCandidate =
      selectedAssets.length === 2 &&
      selectedAssets.some((asset) => asset.isImage) &&
      selectedAssets.some((asset) => asset.isVideo);

    return assetMultiSelectManager.isAllUserOwned && (isLivePhoto || isLivePhotoCandidate);
  });

  const handleEscape = () => {
    if (assetViewerManager.isViewing) {
      return;
    }
    if (assetMultiSelectManager.selectionActive) {
      assetMultiSelectManager.clear();
      return;
    }
  };

  const handleLink: OnLink = ({ still, motion }) => {
    timelineManager.removeAssets([motion.id]);
    timelineManager.upsertAssets([still]);
  };

  const handleUnlink: OnUnlink = ({ still, motion }) => {
    timelineManager.upsertAssets([motion]);
    timelineManager.upsertAssets([still]);
  };

  const handleSetVisibility = (assetIds: string[]) => {
    timelineManager.removeAssets(assetIds);
    assetMultiSelectManager.clear();
  };

  const items = $derived(
    memoryManager.memories.map((memory) => ({
      id: memory.id,
      title: $memoryLaneTitle(memory),
      href: Route.viewMemory({ id: memory.id, assetId: memory.assets[0].id }),
      alt: $t('memory_lane_title', { values: { title: $getAltText(toTimelineAsset(memory.assets[0])) } }),
      src: getAssetMediaUrl({ id: memory.assets[0].id }),
      type: memory.type,
    })),
  );

  memoryManager.setFilters({ $for: DateTime.now().toISODate() });
</script>

<UserPageLayout hideNavbar={assetMultiSelectManager.selectionActive} scrollbar={false}>
  <div class="flex flex-col h-full w-full">
    <!-- File Size Filter Toolbar -->
    <div
      class="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-immich-bg dark:bg-immich-dark-bg border-b border-gray-200/80 dark:border-gray-800 text-xs shrink-0 select-none z-10"
    >
      <div class="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-gray-300 me-1">
        <Icon icon={mdiFilterVariant} size="16" />
        <span>File Size:</span>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        {#each SIZE_PRESETS as preset}
          {@const isSelected = selectedSizeLimit === preset.value}
          <button
            type="button"
            class="px-2.5 py-1 rounded-full font-medium transition-colors {isSelected
              ? 'bg-primary text-light dark:bg-immich-dark-primary dark:text-immich-dark-gray shadow-xs'
              : 'bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-300'}"
            onclick={() => selectPreset(preset.value)}
          >
            {preset.label}
          </button>
        {/each}
      </div>

      <form
        class="flex items-center gap-1 ms-1"
        onsubmit={(e) => {
          e.preventDefault();
          applyCustomKb();
        }}
      >
        <span class="text-gray-500 dark:text-gray-400">&lt;</span>
        <input
          type="number"
          min="1"
          placeholder="Custom KB"
          bind:value={customKbInput}
          class="w-20 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs focus:outline-hidden focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          class="px-2 py-0.5 rounded bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-medium"
        >
          Apply
        </button>
      </form>

      <!-- Divider -->
      <div class="h-4 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>

      <!-- Format Filter -->
      <div class="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-gray-300 me-1">
        <span>Format:</span>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        {#each FORMAT_PRESETS as preset}
          {@const isSelected = selectedFormat === preset.value}
          <button
            type="button"
            class="px-2.5 py-1 rounded-full font-medium transition-colors {isSelected
              ? 'bg-primary text-light dark:bg-immich-dark-primary dark:text-immich-dark-gray shadow-xs'
              : 'bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-300'}"
            onclick={() => selectFormatPreset(preset.value)}
          >
            {preset.label}
          </button>
        {/each}
      </div>

      <div class="flex items-center gap-2 ms-auto text-xs">
        {#if selectedSizeLimit !== null}
          <span
            class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary dark:bg-immich-dark-primary/20 dark:text-immich-dark-primary font-medium"
          >
            &lt; {formatBytes(selectedSizeLimit)}
            <button
              type="button"
              class="p-0.5 rounded-full text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Clear size filter"
              onclick={clearFilter}
            >
              <Icon icon={mdiClose} size="12" />
            </button>
          </span>
        {/if}

        {#if selectedFormat !== null}
          <span
            class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary dark:bg-immich-dark-primary/20 dark:text-immich-dark-primary font-medium"
          >
            {selectedFormat.toUpperCase()}
            <button
              type="button"
              class="p-0.5 rounded-full text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Clear format filter"
              onclick={clearFormatFilter}
            >
              <Icon icon={mdiClose} size="12" />
            </button>
          </span>
        {/if}

        {#if timelineManager?.assetCount !== undefined}
          <span class="font-medium text-gray-600 dark:text-gray-300">
            {timelineManager.assetCount.toLocaleString()} {timelineManager.assetCount === 1 ? 'item' : 'items'}
          </span>
        {/if}

        {#if loadedAssetsCount > 0}
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary dark:bg-immich-dark-primary/20 dark:hover:bg-immich-dark-primary/30 dark:text-immich-dark-primary font-medium transition-colors"
            title="Select all currently loaded assets on screen for bulk trashing or management"
            onclick={selectLoadedAssets}
          >
            <Icon icon={mdiCheckAll} size="14" />
            <span>Select Loaded ({loadedAssetsCount})</span>
          </button>
        {/if}
      </div>
    </div>

    <!-- Timeline Grid -->
    <div class="flex-1 min-h-0 relative">
      <Timeline
        enableRouting={true}
        bind:timelineManager
        {options}
        assetInteraction={assetMultiSelectManager}
        removeAction={AssetAction.ARCHIVE}
        onEscape={handleEscape}
        withStacked
      >
        {#if authManager.preferences.memories.enabled}
          <ImageCarousel {items}>
            {#snippet child(item)}
              <MemoryCard {item} />
            {/snippet}
          </ImageCarousel>
        {/if}
        {#snippet empty()}
          <EmptyPlaceholder
            text={selectedSizeLimit !== null || selectedFormat !== null
              ? 'No assets found matching current filters'
              : $t('no_assets_message')}
            onClick={() => (selectedSizeLimit !== null || selectedFormat !== null ? clearAllFilters() : openFileUploadDialog())}
            class="mx-auto mt-10"
          />
        {/snippet}
      </Timeline>
    </div>
  </div>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {@const Actions = getAssetBulkActions($t)}
    {@const StackActions = getStackBulkActions($t)}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />

    <ActionButton action={Actions.CreateSharedLink} />
    <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
    <ActionButton action={Actions.AddToAlbum} />

    {#if assetMultiSelectManager.isAllUserOwned}
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />

      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem />
        <ActionMenuItem action={StackActions.Stack} />
        <ActionMenuItem action={StackActions.Unstack} />
        {#if isLinkActionAvailable}
          <LinkLivePhotoAction
            menuItem
            unlink={assetMultiSelectManager.assets.length === 1}
            onLink={handleLink}
            onUnlink={handleUnlink}
          />
        {/if}
        <ChangeDate menuItem />
        <ChangeDescription menuItem />
        <ChangeLocation menuItem />
        <ArchiveAction
          menuItem
          onArchive={(ids, visibility) => timelineManager.update(ids, (asset) => (asset.visibility = visibility))}
        />
        <ActionMenuItem action={Actions.Tag} />
        <DeleteAssets
          menuItem
          onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)}
          onUndoDelete={(assets) => timelineManager.upsertAssets(assets)}
        />
        <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
        <hr />
        <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
        <ActionMenuItem action={Actions.RefreshMetadataJob} />
        <ActionMenuItem action={Actions.TranscodeVideoJob} />
      </ButtonContextMenu>
    {:else}
      <DownloadAction />
    {/if}
  </AssetSelectControlBar>
{/if}
