<script lang="ts">
  import { lang, locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { getAllMetadataItems, getFilenameDateString, type DifferingMetadataFields } from '$lib/utils/duplicate-utils';
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
    mdiPlay,
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
    hasLocationDescription?: boolean;
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
    hasLocationDescription = false,
  }: Props = $props();

  const listFormat = $derived(new Intl.ListFormat($lang));
  const isFromExternalLibrary = $derived(!!asset.libraryId);
  const isVideo = $derived(asset.type === 'VIDEO');

  let isPlayingVideo = $state(false);

  const formatDuration = (ms?: number | null): string => {
    if (!ms) return '';
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const visibleMetadataItems = $derived(
    getAllMetadataItems(asset, $t, $locale)
      .filter(({ keys }) => !(keys as readonly string[]).includes('fileSize') && !(keys as readonly string[]).includes('resolution'))
      .filter(({ keys }) => keys.some((k) => differingMetadataFields[k]))
      .slice(0, showMore ? undefined : initialVisibleCount),
  );
</script>

<div class="min-w-[260px] flex-1 rounded-xl border transition-colors overflow-hidden">
  <div class="relative w-full">
    {#if isPlayingVideo}
      <div class="relative h-[32vh] sm:h-[35vh] max-h-[380px] min-h-[160px] w-full bg-black rounded-t-md overflow-hidden">
        <video
          src={getAssetPlaybackUrl({ id: asset.id })}
          controls
          autoplay
          playsinline
          class="h-full w-full object-contain"
        >
          <track kind="captions" />
        </video>
        <button
          type="button"
          onclick={() => { isPlayingVideo = false; }}
          class="absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white hover:bg-black"
        >
          ✕ Close Video
        </button>
      </div>
    {:else}
      <button
        type="button"
        onclick={() => onSelectAsset(asset)}
        class="relative block w-full bg-black/5 dark:bg-black/30"
        aria-pressed={isSelected}
        aria-label={$t('keep')}
      >
        <!-- THUMBNAIL-->
        <img
          src={getAssetMediaUrl({ id: asset.id })}
          alt={$getAltText(toTimelineAsset(asset))}
          class="h-[32vh] sm:h-[35vh] max-h-[380px] min-h-[160px] w-full rounded-t-md object-contain"
          draggable="false"
        />

        <!-- VIDEO DURATION BADGE -->
        {#if isVideo && asset.duration}
          <div class="absolute inset-s-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-mono font-medium text-white backdrop-blur-xs shadow">
            ▶ {formatDuration(asset.duration)}
          </div>
        {/if}

        <!-- FAVORITE ICON -->
        {#if asset.isFavorite}
          <div class="absolute {isVideo ? 'inset-s-2 bottom-8' : 'inset-s-2 bottom-2'}">
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
        {#if hasLocationDescription}
          <div
            class="rounded-xl bg-teal-600 px-2 py-1 text-xs font-semibold text-white shadow-md"
            title="Folder path contains specific location or album organization"
          >
            📍 Location Subfolder
          </div>
        {/if}
        {#if isSuspectDate}
          {@const fnDate = getFilenameDateString(asset.originalFileName)}
          <div
            class="rounded-xl bg-rose-600 px-2 py-1 text-xs font-semibold text-white shadow-md"
            title={fnDate ? `Filename indicates date ${fnDate}, which differs from recorded date` : "Capture date in May-Aug 2015 or 2021 affected by Claude EXIF error"}
          >
            ⚠️ Suspect Date{#if fnDate} ({fnDate}){/if}
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
    {/if}

    <!-- VIDEO PLAY OVERLAY BUTTON -->
    {#if isVideo && !isPlayingVideo}
      <div class="pointer-events-none absolute inset-x-0 top-0 h-[32vh] sm:h-[35vh] max-h-[380px] min-h-[160px] flex items-center justify-center">
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            isPlayingVideo = true;
          }}
          class="pointer-events-auto flex items-center justify-center rounded-full bg-black/60 p-3 text-white backdrop-blur-sm transition-transform hover:scale-110 active:scale-95 shadow-lg"
          title="Play Video"
        >
          <Icon icon={mdiPlay} size="28" />
        </button>
      </div>
    {/if}

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
    class="grid place-items-start gap-y-1 rounded-b-lg py-1.5 px-2 text-xs sm:text-sm transition-colors {isSelected
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
