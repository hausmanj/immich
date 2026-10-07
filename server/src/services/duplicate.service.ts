import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { MapAsset, mapAsset } from 'src/dtos/asset-response.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  CopyBetterToHoldingDto,
  CopyBetterToHoldingResultDto,
  DuplicateResolveDto,
  DuplicateResolveGroupDto,
  DuplicateResponseDto,
} from 'src/dtos/duplicate.dto.js';
import { AssetStatus, AssetType, AssetVisibility, JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { AssetDuplicateResult } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import {
  assessDuplicateQuality,
  classifyDuplicateGroup,
  DuplicateClassification,
  getKeeperScore,
  getPathTier,
  isAssetDateSuspect,
  isOriginalsPath,
  PathTier,
  suggestDuplicateKeepAssetIds,
} from 'src/utils/duplicate.js';
import { batched, isDuplicateDetectionEnabled } from 'src/utils/misc.js';

type ResolveRequest = {
  assetUpdate: {
    isFavorite?: boolean;
    visibility?: AssetVisibility;
  };

  exifUpdate: {
    rating?: number;
    latitude?: number;
    longitude?: number;
    description?: string;
  };

  mergedAlbumIds: string[];

  mergedTagIds: string[];

  mergedTagValues: string[];
};

const uniqueNonEmptyLines = (values: Array<string | null | undefined>): string[] => {
  const unique = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || unique.has(trimmed)) {
        continue;
      }
      unique.add(trimmed);
      lines.push(trimmed);
    }
  }
  return lines;
};

const getUniqueCoordinate = (assets: MapAsset[], key: 'latitude' | 'longitude'): number | null => {
  const values = assets
    .map((asset) => asset.exifInfo?.[key])
    .filter((value): value is number => Number.isFinite(value));

  if (values.length === 0) {
    return null;
  }

  const unique = new Set(values);
  return unique.size === 1 ? [...unique][0] : null;
};

@Injectable()
export class DuplicateService extends BaseService {
  async getDuplicates(auth: AuthDto, type?: AssetType): Promise<DuplicateResponseDto[]> {
    const duplicates = await this.duplicateRepository.getAll(auth.user.id, type);
    if (duplicates.length === 0) {
      return [];
    }

    const { machineLearning } = await this.getConfig({ withCache: true });
    const keepPreference = machineLearning.duplicateDetection.keepPreference;

    const allAssetIds = duplicates.flatMap(({ assets }) => assets.map(({ id }) => id));
    const albumCounts = new Map<string, number>();

    // Chunk album lookups to avoid exceeding postgres query parameter limits
    const BATCH_SIZE = 1000;
    for (let i = 0; i < allAssetIds.length; i += BATCH_SIZE) {
      const batchIds = allAssetIds.slice(i, i + BATCH_SIZE);
      const albumMap = await this.albumRepository.getByAssetIds(auth.user.id, batchIds);
      if (albumMap) {
        for (const [assetId, albumIds] of albumMap) {
          albumCounts.set(assetId, albumIds.length);
        }
      }
    }

    const results: DuplicateResponseDto[] = [];
    for (let i = 0; i < duplicates.length; i++) {
      if (i > 0 && i % 250 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const { duplicateId, assets } = duplicates[i];
      const mappedAssets = assets.map((asset) => mapAsset(asset, { auth }));
      const quality = assessDuplicateQuality(mappedAssets, keepPreference, albumCounts);
      const suspectAssetIds = mappedAssets.filter(isAssetDateSuspect).map((a) => a.id);

      results.push({
        duplicateId,
        assets: mappedAssets,
        suggestedKeepAssetIds: suggestDuplicateKeepAssetIds(mappedAssets, keepPreference, albumCounts),
        classification: classifyDuplicateGroup(mappedAssets, undefined, { fallbackToMetadata: true }),
        betterQualityOutsideOriginals: quality.betterQualityOutsideOriginals,
        betterQualityAssetIds: quality.betterQualityAssetIds,
        hasSuspectDate: suspectAssetIds.length > 0,
        suspectAssetIds,
      });
    }

    return results;
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.DuplicateDelete, ids: [id] });
    await this.duplicateRepository.delete(auth.user.id, id);
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto) {
    await this.requireAccess({ auth, permission: Permission.DuplicateDelete, ids: dto.ids });
    await this.duplicateRepository.deleteAll(auth.user.id, dto.ids);
  }

  async resolve(auth: AuthDto, dto: DuplicateResolveDto) {
    const duplicateIds = dto.groups.map(({ duplicateId }) => duplicateId);

    const allowedIds = await this.checkAccess({ auth, permission: Permission.DuplicateDelete, ids: duplicateIds });

    const results: BulkIdResponseDto[] = [];

    for (const group of dto.groups) {
      if (!allowedIds.has(group.duplicateId)) {
        results.push({ id: group.duplicateId, success: false, error: BulkIdErrorReason.NOT_FOUND });
        continue;
      }

      try {
        results.push(await this.resolveGroup(auth, group));
      } catch (error: Error | any) {
        this.logger.error(`Error resolving duplicate group ${group.duplicateId}: ${error}`, error?.stack);
        results.push({ id: group.duplicateId, success: false, error: BulkIdErrorReason.UNKNOWN });
      }
    }

    return results;
  }

  private async resolveGroup(auth: AuthDto, group: DuplicateResolveGroupDto): Promise<BulkIdResponseDto> {
    const { duplicateId, keepAssetIds, trashAssetIds } = group;

    const duplicateGroup = await this.duplicateRepository.get(duplicateId);
    if (!duplicateGroup) {
      return { id: duplicateId, success: false, error: BulkIdErrorReason.NOT_FOUND };
    }

    const groupAssetIds = new Set(duplicateGroup.assets.map((a) => a.id));

    // ignore/skip asset IDs not in the group
    let idsToKeep = keepAssetIds.filter((id) => groupAssetIds.has(id));
    let idsToTrash = trashAssetIds.filter((id) => groupAssetIds.has(id));

    // GUARD: If the group contains assets in originals, ensure at least one original is preserved in idsToKeep
    const groupOriginals = duplicateGroup.assets.filter((a) => isOriginalsPath(a.originalPath));
    if (groupOriginals.length > 0) {
      const keepingOriginal = idsToKeep.some((id) => groupOriginals.some((o) => o.id === id));
      if (!keepingOriginal) {
        const bestOriginal = groupOriginals[0];
        this.logger.warn(
          `PROTECTED: No originals kept in group ${duplicateId}. Rescuing original ${bestOriginal.id} into keepAssetIds`,
        );
        idsToTrash = idsToTrash.filter((id) => id !== bestOriginal.id);
        if (!idsToKeep.includes(bestOriginal.id)) {
          idsToKeep.push(bestOriginal.id);
        }
      }
    }

    for (const assetId of groupAssetIds) {
      if (idsToKeep.includes(assetId) && idsToTrash.includes(assetId)) {
        return {
          id: duplicateId,
          success: false,
          error: BulkIdErrorReason.VALIDATION,
          errorMessage: 'An asset cannot be in both keepAssetIds and trashAssetIds',
        };
      }

      if (!idsToKeep.includes(assetId) && !idsToTrash.includes(assetId)) {
        return {
          id: duplicateId,
          success: false,
          error: BulkIdErrorReason.VALIDATION,
          errorMessage: 'Every asset must be in either keepAssetIds or trashAssetIds',
        };
      }
    }

    if (idsToTrash.length > 0) {
      const ids = await this.checkAccess({ auth, permission: Permission.AssetDelete, ids: idsToTrash });
      if (ids.size !== idsToTrash.length) {
        return {
          id: duplicateId,
          success: false,
          error: BulkIdErrorReason.NO_PERMISSION,
          errorMessage: 'No permission to delete assets',
        };
      }
    }

    // Only merge metadata into the keeper when exactly one asset can absorb trashed duplicates.
    if (idsToKeep.length === 1 && idsToTrash.length > 0) {
      const assetAlbumMap = await this.albumRepository.getByAssetIds(auth.user.id, [...groupAssetIds]);

      const { assetUpdate, exifUpdate, mergedAlbumIds, mergedTagIds, mergedTagValues } = this.getSyncMergeResult(
        duplicateGroup.assets,
        assetAlbumMap,
      );

      if (mergedAlbumIds.length > 0) {
        const allowedAlbumIds = await this.checkAccess({
          auth,
          permission: Permission.AlbumAssetCreate,
          ids: mergedAlbumIds,
        });

        const allowedShareIds = await this.checkAccess({
          auth,
          permission: Permission.AssetShare,
          ids: idsToKeep,
        });

        if (allowedAlbumIds.size > 0 && allowedShareIds.size > 0) {
          await this.albumRepository.addAssetIdsToAlbums(
            [...allowedAlbumIds].flatMap((albumId) => [...allowedShareIds].map((assetId) => ({ albumId, assetId }))),
          );
        }
      }

      if (mergedTagIds.length > 0) {
        const allowedTagIds = await this.checkAccess({
          auth,
          permission: Permission.TagAsset,
          ids: mergedTagIds,
        });

        if (allowedTagIds.size > 0) {
          await Promise.all(
            idsToKeep.map((assetId) => this.tagRepository.replaceAssetTags(assetId, [...allowedTagIds])),
          );

          await this.assetRepository.updateAllExif(idsToKeep, { tags: mergedTagValues });
        }
      }

      const hasExifUpdate = Object.keys(exifUpdate).length > 0;
      const hasTagUpdate = mergedTagIds.length > 0;

      if (hasExifUpdate) {
        await this.assetRepository.updateAllExif(idsToKeep, exifUpdate);
      }

      if (hasExifUpdate || hasTagUpdate) {
        // Do not write sidecars to read-only originals archive
        const writableKeepIds = idsToKeep.filter((id) => {
          const asset = duplicateGroup.assets.find((a) => a.id === id);
          return !asset || !isOriginalsPath(asset.originalPath);
        });
        if (writableKeepIds.length > 0) {
          await this.jobRepository.queueAll(writableKeepIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
        }
      }

      await this.assetRepository.updateAll(idsToKeep, { duplicateId: null, ...assetUpdate });
    } else if (idsToKeep.length > 0) {
      await this.assetRepository.updateAll(idsToKeep, { duplicateId: null });
    }

    if (idsToTrash.length > 0) {
      // TODO: this is duplicated with AssetService.deleteAssets
      const { trash } = await this.getConfig({ withCache: true });
      const isForce = !trash.enabled;

      await this.assetRepository.updateAll(idsToTrash, {
        deletedAt: new Date(),
        status: isForce ? AssetStatus.Deleted : AssetStatus.Trashed,
        duplicateId: null,
      });

      await this.eventRepository.emit(isForce ? 'AssetDeleteAll' : 'AssetTrashAll', {
        assetIds: idsToTrash,
        userId: auth.user.id,
      });
    }

    return { id: duplicateId, success: true };
  }

  async copyBetterToHolding(auth: AuthDto, dto?: CopyBetterToHoldingDto): Promise<CopyBetterToHoldingResultDto> {
    const holdingRoot =
      process.env.HOLDING_ROOT ||
      (fs.existsSync('/mnt/holding')
        ? '/mnt/holding'
        : fs.existsSync('/volume1/photosync/better_copies_holding')
          ? '/volume1/photosync/better_copies_holding'
          : '/mnt/holding');

    if (!fs.existsSync(holdingRoot)) {
      try {
        fs.mkdirSync(holdingRoot, { recursive: true });
        try {
          fs.chmodSync(holdingRoot, 0o777);
        } catch {}
      } catch (err: any) {
        this.logger.error(`Failed to create holding root at ${holdingRoot}: ${err.message}`);
        return {
          totalFound: 0,
          copied: 0,
          alreadyExisted: 0,
          failed: 1,
          errors: [`Holding root folder inaccessible: ${err.message}`],
        };
      }
    }

    const duplicates = await this.duplicateRepository.getAll(auth.user.id);
    if (duplicates.length === 0) {
      return { totalFound: 0, copied: 0, alreadyExisted: 0, failed: 0, errors: [] };
    }

    const { machineLearning } = await this.getConfig({ withCache: true });
    const keepPreference = machineLearning.duplicateDetection.keepPreference;

    const targetDuplicateIds = dto?.duplicateIds && dto.duplicateIds.length > 0 ? new Set(dto.duplicateIds) : null;
    const targetDuplicates = targetDuplicateIds
      ? duplicates.filter((d) => targetDuplicateIds.has(d.duplicateId))
      : duplicates;

    const albumMap =
      (await this.albumRepository.getByAssetIds(
        auth.user.id,
        targetDuplicates.flatMap(({ assets }) => assets.map(({ id }) => id)),
      )) ?? new Map();
    const albumCounts = new Map([...albumMap].map(([assetId, albumIds]) => [assetId, albumIds.length]));

    let totalFound = 0;
    let copied = 0;
    let alreadyExisted = 0;
    let failed = 0;
    const errors: string[] = [];

    const manifestPath = path.join(holdingRoot, 'manifest.json');
    let manifestEntries: any[] = [];
    if (fs.existsSync(manifestPath)) {
      try {
        manifestEntries = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err: any) {
        this.logger.warn(`Could not parse existing manifest.json: ${err.message}`);
        manifestEntries = [];
      }
    }
    const manifestMap = new Map<string, any>(manifestEntries.map((e) => [e.destination, e]));
    const seenDests = new Map<string, number>();

    for (const { assets } of targetDuplicates) {
      await new Promise((resolve) => setImmediate(resolve));

      const mappedAssets = assets.map((asset) => mapAsset(asset, { auth }));
      const quality = assessDuplicateQuality(mappedAssets, keepPreference, albumCounts);

      if (!quality.betterQualityOutsideOriginals || quality.betterQualityAssetIds.length === 0) {
        continue;
      }

      const originals = mappedAssets.filter((a) => quality.originalsAssetIds.includes(a.id));
      if (originals.length === 0) {
        continue;
      }
      const primaryOriginal = originals[0];

      // Extract relative directory from originals path
      let relDir = '';
      const origPath = primaryOriginal.originalPath;
      if (origPath.startsWith('/mnt/originals/')) {
        relDir = path.relative('/mnt/originals', path.dirname(origPath));
      } else if (origPath.startsWith('/volume1/photosync/originals_clean/')) {
        relDir = path.relative('/volume1/photosync/originals_clean', path.dirname(origPath));
      } else {
        const cleanIdx = origPath.indexOf('originals_clean/');
        if (cleanIdx !== -1) {
          relDir = path.dirname(origPath.slice(cleanIdx + 'originals_clean/'.length));
        } else {
          relDir = path.dirname(origPath).replace(/^\/+/, '');
        }
      }

      for (const betterId of quality.betterQualityAssetIds) {
        const betterAsset = mappedAssets.find((a) => a.id === betterId);
        if (!betterAsset) continue;

        totalFound++;
        const srcPath = betterAsset.originalPath;

        if (!fs.existsSync(srcPath)) {
          failed++;
          const msg = `Source file not found: ${srcPath}`;
          this.logger.warn(msg);
          errors.push(msg);
          continue;
        }

        try {
          const srcStat = await fs.promises.stat(srcPath);
          const srcName = path.basename(srcPath);
          const ext = path.extname(srcName);
          const stem = path.basename(srcName, ext);

          // Intelligent name cleaning: remove trailing duplicate markers like " (1)"
          const cleanedStem = stem.replace(/\s*\(\d+\)$/, '');
          let targetName = `${cleanedStem}${ext}`;

          const destDir = path.join(holdingRoot, relDir);
          await fs.promises.mkdir(destDir, { recursive: true });
          try {
            await fs.promises.chmod(destDir, 0o777);
          } catch {}

          let destFile = path.join(destDir, targetName);

          if (seenDests.has(destFile)) {
            const count = seenDests.get(destFile)! + 1;
            seenDests.set(destFile, count);
            targetName = `${cleanedStem}_dup${count}${ext}`;
            destFile = path.join(destDir, targetName);
          } else {
            seenDests.set(destFile, 1);
          }

          if (fs.existsSync(destFile)) {
            const destStat = await fs.promises.stat(destFile);
            if (destStat.size === srcStat.size) {
              alreadyExisted++;
              manifestMap.set(destFile, {
                source: srcPath,
                destination: destFile,
                worseInOriginals: primaryOriginal.originalPath,
                sidecars: [],
                fileSize: srcStat.size,
                sourceResolution: `${betterAsset.width ?? betterAsset.exifInfo?.exifImageWidth ?? 0}x${betterAsset.height ?? betterAsset.exifInfo?.exifImageHeight ?? 0}`,
                worseResolution: `${primaryOriginal.width ?? primaryOriginal.exifInfo?.exifImageWidth ?? 0}x${primaryOriginal.height ?? primaryOriginal.exifInfo?.exifImageHeight ?? 0}`,
                alreadyExisted: true,
                updatedAt: new Date().toISOString(),
              });
              continue;
            }
          }

          await fs.promises.copyFile(srcPath, destFile);
          try {
            await fs.promises.utimes(destFile, srcStat.atime, srcStat.mtime);
            await fs.promises.chmod(destFile, 0o666);
          } catch {}

          // Copy companion sidecars
          const sidecarsCopied: string[] = [];
          const srcStemPath = path.join(path.dirname(srcPath), stem);
          const potentialSidecars = [
            `${srcPath}.xmp`,
            `${srcStemPath}.xmp`,
            `${srcStemPath}.aae`,
          ];
          for (const sc of potentialSidecars) {
            if (fs.existsSync(sc) && sc !== srcPath) {
              const scName = path.basename(sc);
              const scDest = path.join(destDir, scName);
              await fs.promises.copyFile(sc, scDest);
              try {
                const scStat = await fs.promises.stat(sc);
                await fs.promises.utimes(scDest, scStat.atime, scStat.mtime);
                await fs.promises.chmod(scDest, 0o666);
              } catch {}
              sidecarsCopied.push(scDest);
            }
          }

          copied++;
          manifestMap.set(destFile, {
            source: srcPath,
            destination: destFile,
            worseInOriginals: primaryOriginal.originalPath,
            sidecars: sidecarsCopied,
            fileSize: srcStat.size,
            sourceResolution: `${betterAsset.width ?? betterAsset.exifInfo?.exifImageWidth ?? 0}x${betterAsset.height ?? betterAsset.exifInfo?.exifImageHeight ?? 0}`,
            worseResolution: `${primaryOriginal.width ?? primaryOriginal.exifInfo?.exifImageWidth ?? 0}x${primaryOriginal.height ?? primaryOriginal.exifInfo?.exifImageHeight ?? 0}`,
            copiedAt: new Date().toISOString(),
          });
        } catch (err: any) {
          failed++;
          const msg = `Error copying ${srcPath}: ${err.message}`;
          this.logger.error(msg);
          errors.push(msg);
        }
      }
    }

    try {
      await fs.promises.writeFile(manifestPath, JSON.stringify([...manifestMap.values()], null, 2), 'utf8');
      try {
        await fs.promises.chmod(manifestPath, 0o666);
      } catch {}
    } catch (err: any) {
      this.logger.error(`Failed to update manifest.json: ${err.message}`);
    }

    this.logger.log(
      `copyBetterToHolding completed: ${copied} copied, ${alreadyExisted} already existed, ${failed} failed (total found: ${totalFound})`,
    );

    return {
      totalFound,
      copied,
      alreadyExisted,
      failed,
      errors: errors.slice(0, 50),
    };
  }

  private getSyncMergeResult(assets: MapAsset[], assetAlbumMap: Map<string, string[]> = new Map()): ResolveRequest {
    const response: ResolveRequest = {
      mergedAlbumIds: [],
      mergedTagIds: [],
      mergedTagValues: [],
      assetUpdate: {},
      exifUpdate: {},
    };

    response.assetUpdate.isFavorite = assets.some((asset) => asset.isFavorite);

    const visibilityOrder = [AssetVisibility.Locked, AssetVisibility.Archive, AssetVisibility.Timeline];
    let visibility = visibilityOrder.find((level) => assets.some((asset) => asset.visibility === level));
    if (!visibility && assets.some((asset) => asset.visibility === AssetVisibility.Hidden)) {
      visibility = AssetVisibility.Hidden;
    }
    if (visibility) {
      response.assetUpdate.visibility = visibility;
    }

    let rating = 0;
    for (const asset of assets) {
      const assetRating = asset.exifInfo?.rating ?? 0;
      if (assetRating > rating) {
        rating = assetRating;
      }
    }
    if (rating > 0) {
      response.exifUpdate.rating = rating;
    }

    const descriptionLines = uniqueNonEmptyLines(assets.map((asset) => asset.exifInfo?.description));
    const description = descriptionLines.length > 0 ? descriptionLines.join('\n') : null;
    if (description !== null) {
      response.exifUpdate.description = description;
    }

    const latitude = getUniqueCoordinate(assets, 'latitude');
    const longitude = getUniqueCoordinate(assets, 'longitude');
    if (latitude !== null && longitude !== null) {
      response.exifUpdate.latitude = latitude;
      response.exifUpdate.longitude = longitude;
    }

    const albumIdSet = new Set<string>();
    for (const [, albumIds] of assetAlbumMap) {
      for (const albumId of albumIds) {
        albumIdSet.add(albumId);
      }
    }
    response.mergedAlbumIds = [...albumIdSet];

    const allTags = assets.flatMap((asset) => asset.tags ?? []);
    const tagIds = [...new Set(allTags.map((tag) => tag.id).filter((id): id is string => !!id))];
    const tagValues = [...new Set(allTags.map((tag) => tag.value).filter((v): v is string => !!v))];
    if (tagIds.length > 0) {
      response.mergedTagIds = tagIds;
      response.mergedTagValues = tagValues;
    }

    return response;
  }

  @OnJob({ name: JobName.AssetDetectDuplicatesQueueAll, queue: QueueName.DuplicateDetection })
  async handleQueueSearchDuplicates({ force }: JobOf<JobName.AssetDetectDuplicatesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isDuplicateDetectionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    for await (const assets of batched(this.assetJobRepository.streamForSearchDuplicates(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDetectDuplicates, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectDuplicates, queue: QueueName.DuplicateDetection })
  async handleSearchDuplicates({ id }: JobOf<JobName.AssetDetectDuplicates>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isDuplicateDetectionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForSearchDuplicatesJob(id);
    if (!asset) {
      this.logger.error(`Asset ${id} not found`);
      return JobStatus.Failed;
    }

    if (asset.stackId) {
      this.logger.debug(`Asset ${id} is part of a stack, skipping`);
      return JobStatus.Skipped;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.debug(`Asset ${id} is not visible, skipping`);
      return JobStatus.Skipped;
    }

    if (asset.visibility === AssetVisibility.Locked) {
      this.logger.debug(`Asset ${id} is locked, skipping`);
      return JobStatus.Skipped;
    }

    if (!asset.embedding) {
      this.logger.debug(`Asset ${id} is missing embedding`);
      return JobStatus.Failed;
    }

    const duplicateAssets = await this.duplicateRepository.search({
      assetId: asset.id,
      embedding: asset.embedding,
      maxDistance: machineLearning.duplicateDetection.maxDistance,
      type: asset.type,
      userIds: [asset.ownerId],
    });

    let assetIds = [asset.id];
    if (duplicateAssets.length > 0) {
      this.logger.debug(
        `Found ${duplicateAssets.length} duplicate${duplicateAssets.length === 1 ? '' : 's'} for asset ${asset.id}`,
      );
      assetIds = await this.updateDuplicates(asset, duplicateAssets);
    } else if (asset.duplicateId) {
      this.logger.debug(`No duplicates found for asset ${asset.id}, removing duplicateId`);
      await this.assetRepository.update({ id: asset.id, duplicateId: null });
    }

    const duplicatesDetectedAt = new Date();
    await this.assetRepository.upsertJobStatus(...assetIds.map((assetId) => ({ assetId, duplicatesDetectedAt })));

    return JobStatus.Success;
  }

  private async updateDuplicates(
    asset: { id: string; duplicateId: string | null },
    duplicateAssets: AssetDuplicateResult[],
  ): Promise<string[]> {
    const duplicateIds = [
      ...new Set(
        duplicateAssets
          .filter((asset): asset is AssetDuplicateResult & { duplicateId: string } => !!asset.duplicateId)
          .map((duplicate) => duplicate.duplicateId),
      ),
    ];

    const targetDuplicateId = asset.duplicateId ?? duplicateIds.shift() ?? this.cryptoRepository.randomUUID();
    const assetIdsToUpdate = duplicateAssets
      .filter((asset) => asset.duplicateId !== targetDuplicateId)
      .map((duplicate) => duplicate.assetId);
    assetIdsToUpdate.push(asset.id);

    await this.duplicateRepository.merge({
      targetId: targetDuplicateId,
      assetIds: assetIdsToUpdate,
      sourceIds: duplicateIds,
    });
    return assetIdsToUpdate;
  }
}
