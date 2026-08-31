<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AssetUpdateRatingConfirmModal from '$lib/modals/AssetUpdateRatingConfirmModal.svelte';
  import { getOwnedAssetsWithWarning } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAssets } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { mdiStar } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    menuItem?: boolean;
  }

  let { menuItem = false }: Props = $props();

  const handleUpdateRating = async () => {
    const rating = await modalManager.show(AssetUpdateRatingConfirmModal, {});
    if (rating === undefined) {
      // modal was cancelled -- null is a real, meaningful value (clear the rating), so only
      // an explicit undefined (no submit happened) means "don't apply anything"
      return;
    }

    const ids = getOwnedAssetsWithWarning(assetMultiSelectManager.assets, authManager.user);

    try {
      await updateAssets({ assetBulkUpdateDto: { ids, rating: rating ?? null } });
      assetMultiSelectManager.clear();
    } catch (error) {
      handleError(error, $t('errors.unable_to_set_rating'));
    }
  };
</script>

{#if menuItem}
  <MenuOption text={$t('rating')} icon={mdiStar} onClick={() => handleUpdateRating()} />
{/if}
