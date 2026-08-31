<script lang="ts">
  import StarRating, { type Rating } from '$lib/elements/StarRating.svelte';
  import { Field, FormModal } from '@immich/ui';
  import { mdiStar } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: (rating?: Rating) => void;
  };

  let { onClose }: Props = $props();
  let rating: Rating = $state(null);
</script>

<FormModal title={$t('rating')} icon={mdiStar} {onClose} onSubmit={() => onClose(rating)}>
  <Field label={$t('rating')}>
    <StarRating {rating} onRating={(value) => { rating = value; }} />
  </Field>
</FormModal>
