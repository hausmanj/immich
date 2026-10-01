<script lang="ts">
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { DuplicateClassification, type DuplicateResponseDto } from '@immich/sdk';
  import { Button, Checkbox, HStack, Modal, ModalBody, ModalFooter, Text } from '@immich/ui';
  import { mdiTrashCanOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    duplicates: DuplicateResponseDto[];
    onClose: (selectedGroups?: DuplicateResponseDto[]) => void;
  };

  let { duplicates, onClose }: Props = $props();

  const isThumbnailGroup = (group: DuplicateResponseDto): boolean => {
    if (group.assets.length < 2) return false;
    const a = group.assets[0];
    const b = group.assets[1];
    if (a.width && a.height && b.width && b.height) {
      const wRatio = Math.min(a.width, b.width) / Math.max(a.width, b.width);
      const hRatio = Math.min(a.height, b.height) / Math.max(a.height, b.height);
      if (wRatio < 0.6 || hRatio < 0.6) return true;
    }
    const isThumbName = (name?: string) => name && (/thumb/i.test(name) || /UNADJUSTEDNONRAW/i.test(name));
    return group.assets.some((a) => isThumbName(a.originalFileName));
  };

  const getTrashCount = (group: DuplicateResponseDto) => {
    const keepIds = new Set(group.suggestedKeepAssetIds);
    return group.assets.filter((a) => !keepIds.has(a.id)).length;
  };

  const betterQualityOutsideGroups = $derived(
    duplicates.filter((g) => g.betterQualityOutsideOriginals),
  );

  const suspectDateGroups = $derived(
    duplicates.filter((g) => g.hasSuspectDate),
  );

  // Groups with higher quality outside originals are held for manual migration
  const eligibleDuplicates = $derived(
    duplicates.filter((g) => !g.betterQualityOutsideOriginals),
  );

  const exactGroups = $derived(
    eligibleDuplicates.filter(
      (g) =>
        g.classification === DuplicateClassification.Exact ||
        g.classification === DuplicateClassification.ContentIdentical,
    ),
  );
  const exactTrash = $derived(exactGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const thumbnailGroups = $derived(
    eligibleDuplicates.filter((g) => g.classification === DuplicateClassification.HighConfidenceDuplicate && isThumbnailGroup(g)),
  );
  const thumbnailTrash = $derived(thumbnailGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const highConfidenceGroups = $derived(
    eligibleDuplicates.filter(
      (g) => g.classification === DuplicateClassification.HighConfidenceDuplicate && !isThumbnailGroup(g),
    ),
  );
  const highConfidenceTrash = $derived(highConfidenceGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const possibleGroups = $derived(
    eligibleDuplicates.filter((g) => g.classification === DuplicateClassification.PossibleDuplicate),
  );
  const possibleTrash = $derived(possibleGroups.reduce((acc, g) => acc + getTrashCount(g), 0));

  const unanalyzedCount = $derived(
    eligibleDuplicates.filter((g) => g.classification === DuplicateClassification.Unanalyzed).length,
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
      <div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        <span class="font-semibold">{betterQualityOutsideGroups.length.toLocaleString($locale)} groups</span>
        have a higher-quality copy outside originals and are held back from auto-deduplication for manual migration to originals.
      </div>
    {/if}

    {#if suspectDateGroups.length > 0}
      <div class="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
        <span class="font-semibold">{suspectDateGroups.length.toLocaleString($locale)} groups</span>
        contain photos with suspect EXIF dates (May–Aug 2015/2021 Claude date error).
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
