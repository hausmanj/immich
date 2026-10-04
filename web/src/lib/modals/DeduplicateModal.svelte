<script lang="ts">
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { DuplicateClassification, type DuplicateResponseDto } from '@immich/sdk';
  import { Button, Checkbox, HStack, Modal, ModalBody, ModalFooter, Text, toastManager } from '@immich/ui';
  import { mdiTrashCanOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { copyBetterToHolding } from '$lib/utils/duplicate-utils';

  type Props = {
    duplicates: DuplicateResponseDto[];
    onClose: (selectedGroups?: DuplicateResponseDto[]) => void;
  };

  let { duplicates, onClose }: Props = $props();

  const isThumbnailGroup = (group: DuplicateResponseDto): boolean => {
    if (group.assets.length < 2) return false;
    for (let i = 0; i < group.assets.length; i++) {
      for (let j = i + 1; j < group.assets.length; j++) {
        const a = group.assets[i];
        const b = group.assets[j];
        const aWidth = a.width ?? a.exifInfo?.exifImageWidth ?? 0;
        const aHeight = a.height ?? a.exifInfo?.exifImageHeight ?? 0;
        const bWidth = b.width ?? b.exifInfo?.exifImageWidth ?? 0;
        const bHeight = b.height ?? b.exifInfo?.exifImageHeight ?? 0;
        if (aWidth > 0 && aHeight > 0 && bWidth > 0 && bHeight > 0) {
          const wRatio = Math.min(aWidth, bWidth) / Math.max(aWidth, bWidth);
          const hRatio = Math.min(aHeight, bHeight) / Math.max(aHeight, bHeight);
          if (wRatio < 0.8 || hRatio < 0.8) return true;
        }
      }
      const name = group.assets[i]?.originalFileName;
      if (name && (/thumb/i.test(name) || /UNADJUSTEDNONRAW/i.test(name) || /preview/i.test(name))) {
        return true;
      }
    }
    return false;
  };

  const normalizeClass = (c?: string): DuplicateClassification => {
    const s = (c ?? '').toLowerCase().replace(/_/g, '');
    if (s === 'exact') return DuplicateClassification.Exact;
    if (s === 'contentidentical') return DuplicateClassification.ContentIdentical;
    if (s.includes('highconfidence')) return DuplicateClassification.HighConfidenceDuplicate;
    if (s.includes('possible')) return DuplicateClassification.PossibleDuplicate;
    return DuplicateClassification.Unanalyzed;
  };

  const getTrashCount = (group: DuplicateResponseDto) => {
    const keepIds = new Set(group.suggestedKeepAssetIds);
    return group.assets.filter((a) => !keepIds.has(a.id)).length;
  };

  let excludeSuspectDates = $state(true);

  const betterQualityOutsideGroups = $derived(
    duplicates.filter((g) => g.betterQualityOutsideOriginals),
  );

  const suspectDateGroups = $derived(
    duplicates.filter((g) => g.hasSuspectDate),
  );

  // Groups with higher quality outside originals are held for manual migration
  // If excludeSuspectDates is true, photos with suspect Claude 2015/2021 dates are also held for review
  const eligibleDuplicates = $derived(
    duplicates.filter((g) => !g.betterQualityOutsideOriginals && (!excludeSuspectDates || !g.hasSuspectDate)),
  );

  const exactGroups = $derived(
    eligibleDuplicates.filter((g) => {
      const c = normalizeClass(g.classification);
      return c === DuplicateClassification.Exact || c === DuplicateClassification.ContentIdentical;
    }),
  );
  const exactTrash = $derived(exactGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const thumbnailGroups = $derived(
    eligibleDuplicates.filter((g) => {
      const c = normalizeClass(g.classification);
      return (
        c !== DuplicateClassification.Exact &&
        c !== DuplicateClassification.ContentIdentical &&
        isThumbnailGroup(g)
      );
    }),
  );
  const thumbnailTrash = $derived(thumbnailGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const highConfidenceGroups = $derived(
    eligibleDuplicates.filter((g) => {
      const c = normalizeClass(g.classification);
      return c === DuplicateClassification.HighConfidenceDuplicate && !isThumbnailGroup(g);
    }),
  );
  const highConfidenceTrash = $derived(highConfidenceGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const possibleGroups = $derived(
    eligibleDuplicates.filter((g) => {
      const c = normalizeClass(g.classification);
      return (
        (c === DuplicateClassification.PossibleDuplicate || c === DuplicateClassification.Unanalyzed) &&
        !isThumbnailGroup(g)
      );
    }),
  );
  const possibleTrash = $derived(possibleGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const unanalyzedCount = $derived(
    eligibleDuplicates.filter((g) => normalizeClass(g.classification) === DuplicateClassification.Unanalyzed).length,
  );

  let includeExact = $state(true);
  let includeThumbnails = $state(true);
  let includeHighConfidence = $state(false);
  let includePossible = $state(false);

  const selectedGroups = $derived([
    ...(includeExact ? exactGroups : []),
    ...(includeThumbnails ? thumbnailGroups : []),
    ...(includeHighConfidence ? highConfidenceGroups : []),
    ...(includePossible ? possibleGroups : []),
  ]);

  const totalTrashCount = $derived(
    (includeExact ? exactTrash : 0) +
      (includeThumbnails ? thumbnailTrash : 0) +
      (includeHighConfidence ? highConfidenceTrash : 0) +
      (includePossible ? possibleTrash : 0),
  );

  const submitText = $derived(
    totalTrashCount > 0
      ? featureFlagsManager.value.trash
        ? $t('trash_count', { values: { count: totalTrashCount } })
        : $t('permanently_deleted_assets_count', { values: { count: totalTrashCount } })
      : $t('confirm'),
  );

  let isCopyingHolding = $state(false);

  const handleCopyBetter = async () => {
    isCopyingHolding = true;
    try {
      const ids = betterQualityOutsideGroups.map((g) => g.duplicateId);
      const res = await copyBetterToHolding(ids);
      if (res.failed > 0 && res.copied === 0 && res.alreadyExisted === 0) {
        toastManager.danger(res.errors[0] || 'Failed to copy better copies');
      } else {
        toastManager.primary(
          `Copied ${res.copied} better quality files to holding folder (${res.alreadyExisted} already in holding)`,
        );
      }
    } catch (err: any) {
      toastManager.danger(err.message || 'Error copying better copies');
    } finally {
      isCopyingHolding = false;
    }
  };

  const handleSubmit = () => {
    if (selectedGroups.length === 0) return;
    onClose(selectedGroups);
  };
</script>

<Modal
  title={$t('deduplicate_all')}
  icon={mdiTrashCanOutline}
  size="medium"
  onClose={() => onClose()}
>
  <ModalBody>
  <div class="flex flex-col gap-3 py-2 text-sm">
    <Text color="muted" size="small">
      Select the duplicate certainty categories you want to deduplicate. Keeper logic always preserves the best copy (highest resolution, original file, and album memberships).
    </Text>

    {#if betterQualityOutsideGroups.length > 0}
      <div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
        <div class="flex-1 min-w-[200px]">
          <span class="font-semibold">{betterQualityOutsideGroups.length.toLocaleString($locale)} groups</span>
          have a higher-quality copy outside originals and are held back from auto-deduplication.
        </div>
        <Button
          size="small"
          variant="filled"
          color="warning"
          loading={isCopyingHolding}
          disabled={isCopyingHolding}
          onclick={handleCopyBetter}
        >
          Copy to Holding Folder
        </Button>
      </div>
    {/if}

    {#if suspectDateGroups.length > 0}
      <div class="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200 flex items-center justify-between gap-3">
        <div>
          <span class="font-semibold">{suspectDateGroups.length.toLocaleString($locale)} groups</span>
          contain photos with suspect dates (August 2021 error or June 2015 export fallbacks).
        </div>
        <label class="flex items-center gap-1.5 cursor-pointer font-medium shrink-0">
          <Checkbox bind:checked={excludeSuspectDates} />
          <span>Hold back from deduplicating</span>
        </label>
      </div>
    {/if}

    <!-- Exact / Byte & Content Identical -->
    <label
      class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/60 {includeExact
        ? 'border-primary/50 bg-primary/5 dark:border-primary/50 dark:bg-primary/10'
        : 'opacity-70'}"
    >
      <Checkbox bind:checked={includeExact} class="mt-0.5" />
      <div class="flex flex-1 flex-col">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <span class="inline-block h-2 w-2 rounded-full bg-emerald-500"></span>
            Exact & Pixel Identical
          </span>
          <span class="font-mono text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {exactGroups.length.toLocaleString($locale)} groups ({exactTrash.toLocaleString($locale)} to delete)
          </span>
        </div>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          100% verified identical file checksums or decoded pixel hashes. Safe for immediate unattended deletion.
        </p>
      </div>
    </label>

    <!-- Downscaled Thumbnails -->
    <label
      class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/60 {includeThumbnails
        ? 'border-primary/50 bg-primary/5 dark:border-primary/50 dark:bg-primary/10'
        : 'opacity-70'}"
    >
      <Checkbox bind:checked={includeThumbnails} class="mt-0.5" />
      <div class="flex flex-1 flex-col">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <span class="inline-block h-2 w-2 rounded-full bg-cyan-500"></span>
            Thumbnails & Downscaled Copies
          </span>
          <span class="font-mono text-xs font-medium text-cyan-600 dark:text-cyan-400">
            {thumbnailGroups.length.toLocaleString($locale)} groups ({thumbnailTrash.toLocaleString($locale)} to delete)
          </span>
        </div>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Apple Photos/Takeout downscaled previews (e.g. 1024px) paired with the original camera photo. Full-resolution originals are retained.
        </p>
      </div>
    </label>

    <!-- High-Confidence Visual Duplicates -->
    <label
      class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/60 {includeHighConfidence
        ? 'border-primary/50 bg-primary/5 dark:border-primary/50 dark:bg-primary/10'
        : 'opacity-70'}"
    >
      <Checkbox bind:checked={includeHighConfidence} class="mt-0.5" />
      <div class="flex flex-1 flex-col">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <span class="inline-block h-2 w-2 rounded-full bg-blue-500"></span>
            High-Confidence Visual Duplicates
          </span>
          <span class="font-mono text-xs font-medium text-blue-600 dark:text-blue-400">
            {highConfidenceGroups.length.toLocaleString($locale)} groups ({highConfidenceTrash.toLocaleString($locale)} to delete)
          </span>
        </div>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Matching dimensions, identical aspect ratio, and near-zero perceptual hash distance.
        </p>
      </div>
    </label>

    <!-- Possible Duplicates (Review needed) -->
    <label
      class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/60 {includePossible
        ? 'border-amber-500/50 bg-amber-50/50 dark:border-amber-500/50 dark:bg-amber-950/20'
        : 'opacity-70'}"
    >
      <Checkbox bind:checked={includePossible} class="mt-0.5" />
      <div class="flex flex-1 flex-col">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <span class="inline-block h-2 w-2 rounded-full bg-amber-500"></span>
            Possible Duplicates (Review Recommended)
          </span>
          <span class="font-mono text-xs font-medium text-amber-600 dark:text-amber-400">
            {possibleGroups.length.toLocaleString($locale)} groups ({possibleTrash.toLocaleString($locale)} to delete)
          </span>
        </div>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          CLIP similarity matches where content evidence is inconclusive. Trashing without individual visual inspection is not recommended.
        </p>
      </div>
    </label>

    {#if unanalyzedCount > 0}
      <div class="mt-1 rounded-xl bg-gray-100 p-3 text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
        <span class="font-semibold text-gray-900 dark:text-gray-100">{unanalyzedCount.toLocaleString($locale)} groups</span>
        are currently queued in the background for content fingerprinting. They will automatically classify into the categories above once processed.
      </div>
    {/if}
  </div>
</ModalBody>
  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose()}>
        {$t('cancel')}
      </Button>
      <Button
        shape="round"
        color="danger"
        fullWidth
        disabled={selectedGroups.length === 0}
        onclick={handleSubmit}
      >
        {submitText}
      </Button>
    </HStack>
  </ModalFooter>
</Modal>
