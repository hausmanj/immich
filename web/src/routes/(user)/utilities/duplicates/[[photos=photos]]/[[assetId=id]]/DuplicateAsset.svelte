<script lang="ts">
  import { lang, locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAllMetadataItems, type DifferingMetadataFields } from '$lib/utils/duplicate-utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetResolution, getFileSize } from '$lib/utils/asset-utils';
  import { getAllAlbums, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiBookmarkOutline,
    mdiFitToScreen,
    mdiHeart,
    mdiImageMultipleOutline,
    mdiMagnifyPlus,
    mdiWeightKilogram,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import InfoRow from './InfoRow.svelte';

  interface Props {
    asset: AssetResponseDto;
    isSelected: boolean;
    onSelectAsset: (asset: AssetResponseDto) => void;
    onViewAsset: (asset: AssetResponseDto) => void;
    differingMetadataFields: DifferingMetadataFields;
    showMore?: boolean;
    initialVisibleCount?: number;
    isBetterQuality?: boolean;
    isSuspectDate?: boolean;
    groupHasBetterQuality?: boolean;
    isOriginals?: boolean;
    isUploadsMacbookPro?: boolean;
  }

  let {
    asset,
    isSelected,
    onSelectAsset,
    onViewAsset,
    differingMetadataFields,
    showMore = false,
    initialVisibleCount = 5,
    isBetterQuality = false,
    isSuspectDate = false,
    groupHasBetterQuality = false,
    isOriginals = false,
    isUploadsMacbookPro = false,
  }: Props = $props();

  const listFormat = $derived(new Intl.ListFormat($lang));
  const isFromExternalLibrary = $derived(!!asset.libraryId);

  const visibleMetadataItems = $derived(
    getAllMetadataItems(asset, $t, $locale)
      .filter(({ keys }) => !(keys as readonly string[]).includes('fileSize') && !(keys as readonly string[]).includes('resolution'))
      .filter(({ keys }) => keys.some((k) => differingMetadataFields[k]))
      .slice(0, showMore ? undefined : initialVisibleCount),
  );
</script>

<div class="min-w-60 flex-1 rounded-lg border transition-colors">
  <div class="relative w-full">
    <button
      type="button"
      onclick={() => onSelectAsset(asset)}
      class="relative block w-full"
      aria-pressed={isSelected}
      aria-label={$t('keep')}
    >
      <!-- THUMBNAIL-->
      <img
        src={getAssetMediaUrl({ id: asset.id })}
        alt={$getAltText(toTimelineAsset(asset))}
        class="h-60 w-full rounded-t-md object-cover"
        draggable="false"
      />

      <!-- FAVORITE ICON -->
      {#if asset.isFavorite}
        <div class="absolute inset-s-2 bottom-2">
          <Icon icon={mdiHeart} size="24" class="text-white" />
        </div>
      {/if}

      <!-- OVERLAY CHIP -->
      <div
        class="absolute inset-e-3 bottom-1 rounded-xl px-4 py-1 text-xs transition-colors {isSelected
          ? 'bg-green-400/90'
          : 'bg-red-300/90'} text-black"
      >
        {isSelected ? $t('keep') : $t('to_trash')}
      </div>

      <!-- STATUS & LIBRARY CHIPS -->
      <div class="absolute inset-e-3 top-2 flex flex-col items-end gap-1">
        {#if isBetterQuality}
          <div class="rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-2 py-1 text-xs font-semibold text-white shadow-md">
            🌟 Better Quality (Migrate)
          </div>
        {:else if isOriginals && groupHasBetterQuality}
          <div class="rounded-xl bg-amber-600 px-2 py-1 text-xs font-semibold text-white shadow-md">
            📁 Originals (Lower Quality)
          </div>
        {:else if isOriginals}
          <div class="rounded-xl bg-emerald-600 px-2 py-1 text-xs font-semibold text-white shadow-md">
            📁 Originals (Preferred)
          </div>
        {:else if isUploadsMacbookPro}
          <div class="rounded-xl bg-indigo-600 px-2 py-1 text-xs font-semibold text-white shadow-md">
            💻 MacBook Pro Upload
          </div>
        {/if}
        {#if isSuspectDate}
          <div
            class="rounded-xl bg-rose-600 px-2 py-1 text-xs font-semibold text-white shadow-md"
            title="Capture date in May-Aug 2015 or 2021 affected by Claude EXIF error"
          >
            ⚠️ Suspect Date
          </div>
        {/if}
        {#if isFromExternalLibrary}
          <div class="rounded-xl bg-immich-primary/90 px-2 py-1 text-xs text-white">
            {$t('external')}
          </div>
        {/if}
        {#if asset.stack?.assetCount}
          <div class="my-0.5 rounded-xl bg-immich-primary/90 px-2 py-1 text-xs text-white">
            <div class="flex items-center justify-center">
              <div class="me-1">{asset.stack.assetCount}</div>
              <Icon icon={mdiImageMultipleOutline} size="18" />
            </div>
          </div>
        {/if}
      </div>
    </button>

    <button
      type="button"
      onclick={() => onViewAsset(asset)}
      class="absolute inset-s-1 top-1 rounded-full bg-black/35 p-2 text-gray-200 hover:bg-black/50 hover:text-white"
      title={$t('view')}
    >
      <Icon aria-label={$t('view')} icon={mdiMagnifyPlus} flipped size="18" />
    </button>
  </div>

  <div
    class="grid place-items-start gap-y-2 rounded-b-lg py-2 text-sm transition-colors {isSelected
      ? 'bg-success/15 dark:bg-[#001a06]'
      : 'bg-transparent'}"
  >
    <!-- Always visible essential comparison metrics -->
    <InfoRow icon={mdiWeightKilogram} title={$t('file_size')}>
      <span class="font-semibold text-gray-900 dark:text-gray-100">{getFileSize(asset)}</span>
    </InfoRow>
    <InfoRow icon={mdiFitToScreen} title={$t('resolution')}>
      <span class="font-semibold text-gray-900 dark:text-gray-100">{getAssetResolution(asset)}</span>
    </InfoRow>

    {#each visibleMetadataItems as { icon, title, render, tooltip, keys } (keys[0])}
      <InfoRow {icon} {title} {tooltip}>
        {render}
      </InfoRow>
    {/each}

    <!-- Albums always shown -->
    <InfoRow icon={mdiBookmarkOutline} borderBottom={false} title={$t('albums')}>
      {#await getAllAlbums({ assetId: asset.id })}
        {$t('scanning_for_album')}
      {:then albums}
        {#if albums.length === 1}
          {albums[0].albumName}
        {:else}
          <span title={listFormat.format(albums.map(({ albumName }) => albumName))}>
            {$t('in_albums', { values: { count: albums.length } })}
          </span>
        {/if}
      {/await}
    </InfoRow>
  </div>
</div>
