// ignore_for_file: avoid_slow_async_io

import 'dart:io';

import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:logging/logging.dart';
import 'package:photo_manager/photo_manager.dart';

class StorageRepository {
  final log = Logger('StorageRepository');

  StorageRepository();

  Future<File?> getFileForAsset(String assetId) async {
    File? file;
    final log = Logger('StorageRepository');

    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return null;
      }

      file = await _getOriginalFile(assetId, entity);
      if (file == null) {
        log.warning("Cannot get file for asset $assetId");
        return null;
      }

      final exists = await file.exists();
      if (!exists) {
        log.warning("File for asset $assetId does not exist");
        return null;
      }
    } catch (error, stackTrace) {
      log.warning("Error getting file for asset $assetId", error, stackTrace);
    }
    return file;
  }

  Future<File?> _getOriginalFile(
    String assetId,
    AssetEntity entity, {
    PMProgressHandler? progressHandler,
  }) async {
    var attemptedBaseExport = false;
    var title = entity.title;

    if (CurrentPlatform.isIOS) {
      final hasAdjustments = await entity.darwin.hasAdjustments;
      if (hasAdjustments) {
        attemptedBaseExport = true;
        title = await _getAssetTitle(entity);
        log.warning(
          "iOS asset has Photos adjustments; attempting unedited base export: "
          "assetId=$assetId, title=$title, type=${entity.type}, "
          "width=${entity.width}, height=${entity.height}, "
          "duration=${entity.duration}",
        );

        final baseFile = await entity.darwin.getBaseFile(progressHandler: progressHandler);
        if (baseFile != null) {
          log.info(
            "Using unedited base file for adjusted iOS asset: "
            "assetId=$assetId, title=$title, path=${baseFile.path}",
          );
          return baseFile;
        }

        log.warning(
          "Unable to export unedited base file for adjusted iOS asset; "
          "falling back to existing original-file export to avoid skipping content: "
          "assetId=$assetId, title=$title",
        );
      }
    }

    final file = await (progressHandler == null
        ? entity.originFile
        : entity.loadFile(isOrigin: true, progressHandler: progressHandler));
    if (attemptedBaseExport) {
      log.warning(
        "Adjusted iOS asset fallback export result: "
        "assetId=$assetId, title=$title, fallbackPath=${file?.path ?? "<null>"}",
      );
    }

    return file;
  }

  Future<String> _getAssetTitle(AssetEntity entity) async {
    try {
      final title = await entity.titleAsync;
      if (title.isNotEmpty) {
        return title;
      }
    } catch (_) {
      // Best-effort context only; file export should continue.
    }
    return entity.title;
  }

  // TODO(agg23): Unify these methods
  Future<File?> getMotionFileForAsset(LocalAsset asset) async {
    File? file;
    final log = Logger('StorageRepository');

    try {
      final entity = await AssetEntity.fromId(asset.id);
      file = await entity?.originFileWithSubtype;
      if (file == null) {
        log.warning(
          "Cannot get motion file for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        );
        return null;
      }

      final exists = await file.exists();
      if (!exists) {
        log.warning("Motion file for asset ${asset.id} does not exist");
        return null;
      }
    } catch (error, stackTrace) {
      log.warning(
        "Error getting motion file for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        error,
        stackTrace,
      );
    }
    return file;
  }

  Future<AssetEntity?> getAssetEntityForAsset(LocalAsset asset) async {
    final log = Logger('StorageRepository');

    AssetEntity? entity;

    try {
      entity = await AssetEntity.fromId(asset.id);
      if (entity == null) {
        log.warning(
          "Cannot get AssetEntity for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        );
      }
    } catch (error, stackTrace) {
      log.warning(
        "Error getting AssetEntity for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        error,
        stackTrace,
      );
    }
    return entity;
  }

  Future<bool> isAssetAvailableLocally(String assetId) async {
    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return false;
      }

      return await entity.isLocallyAvailable(isOrigin: true);
    } catch (error, stackTrace) {
      log.warning("Error checking if asset is locally available $assetId", error, stackTrace);
      return false;
    }
  }

  Future<File?> loadFileFromCloud(String assetId, {PMProgressHandler? progressHandler}) async {
    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return null;
      }

      return await _getOriginalFile(assetId, entity, progressHandler: progressHandler);
    } catch (error, stackTrace) {
      log.warning("Error loading file from cloud for asset $assetId", error, stackTrace);
      return null;
    }
  }

  Future<File?> loadMotionFileFromCloud(String assetId, {PMProgressHandler? progressHandler}) async {
    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return null;
      }

      return await entity.loadFile(withSubtype: true, progressHandler: progressHandler);
    } catch (error, stackTrace) {
      log.warning("Error loading motion file from cloud for asset $assetId", error, stackTrace);
      return null;
    }
  }

  Future<void> clearCache() async {
    final log = Logger('StorageRepository');

    try {
      await PhotoManager.clearFileCache();
    } catch (error, stackTrace) {
      log.warning("Error clearing cache", error, stackTrace);
    }

    if (!CurrentPlatform.isIOS) {
      return;
    }

    try {
      if (await Directory.systemTemp.exists()) {
        await Directory.systemTemp.delete(recursive: true);
      }
    } catch (error, stackTrace) {
      log.warning("Error deleting temporary directory", error, stackTrace);
    }
  }
}
