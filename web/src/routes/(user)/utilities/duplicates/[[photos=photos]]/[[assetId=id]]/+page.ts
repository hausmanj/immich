import { AssetTypeEnum, getAssetDuplicates } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const mediaParam = url.searchParams.get('media');
  let type: AssetTypeEnum | undefined;
  if (mediaParam === 'video' || mediaParam === 'videos') {
    type = AssetTypeEnum.Video;
  } else if (mediaParam === 'photo' || mediaParam === 'photos') {
    type = AssetTypeEnum.Image;
  }
  const duplicates = await getAssetDuplicates(type ? { type } : undefined);
  const $t = await getFormatter();

  return {
    duplicates,
    meta: {
      title: $t('duplicates'),
    },
  };
}) satisfies PageLoad;
