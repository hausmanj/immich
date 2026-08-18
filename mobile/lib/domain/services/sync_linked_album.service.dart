import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/infrastructure/repositories/local_album.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_album.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/store.provider.dart';
import 'package:immich_mobile/repositories/drift_album_api_repository.dart';
import 'package:immich_mobile/utils/debug_print.dart';
import 'package:logging/logging.dart';

final syncLinkedAlbumServiceProvider = Provider(
  (ref) => SyncLinkedAlbumService(
    ref.watch(localAlbumRepository),
    ref.watch(remoteAlbumRepository),
    ref.watch(driftAlbumApiRepositoryProvider),
    ref.watch(storeServiceProvider),
  ),
);

class SyncLinkedAlbumService {
  final DriftLocalAlbumRepository _localAlbumRepository;
  final DriftRemoteAlbumRepository _remoteAlbumRepository;
  final DriftAlbumApiRepository _albumApiRepository;
  final StoreService _storeService;

  SyncLinkedAlbumService(
    this._localAlbumRepository,
    this._remoteAlbumRepository,
    this._albumApiRepository,
    this._storeService,
  );

  final _log = Logger("SyncLinkedAlbumService");

  Future<void> syncLinkedAlbums(String userId, {Completer<void>? cancellation}) async {
    final selectedAlbums = await _localAlbumRepository.getBackupAlbums();

    await Future.wait(
      selectedAlbums.map((localAlbum) async {
        final linkedRemoteAlbumId = localAlbum.linkedRemoteAlbumId;
        if (linkedRemoteAlbumId == null) {
          _log.warning("No linked remote album ID found for local album: ${localAlbum.name}");
          return;
        }

        final remoteAlbum = await _remoteAlbumRepository.get(linkedRemoteAlbumId);
        if (remoteAlbum == null) {
          _log.warning("Linked remote album not found for ID: $linkedRemoteAlbumId");
          return;
        }

        // get assets that are uploaded but not in the remote album
        final assetIds = await _remoteAlbumRepository.getLinkedAssetIds(userId, localAlbum.id, linkedRemoteAlbumId);
        _log.fine("Syncing ${assetIds.length} assets to remote album: ${remoteAlbum.name}");
        if (assetIds.isNotEmpty) {
          final album = await _albumApiRepository.addAssets(
            remoteAlbum.id,
            assetIds,
            abortTrigger: cancellation?.future,
          );
          await _remoteAlbumRepository.addAssets(remoteAlbum.id, album.added);
        }
      }),
    );
  }

  Future<void> manageLinkedAlbums(List<LocalAlbum> localAlbums, String ownerId) async {
    try {
      for (final album in localAlbums) {
        await _processLocalAlbum(album, ownerId);
      }
    } catch (error, stackTrace) {
      _log.severe("Error managing linked albums", error, stackTrace);
    }
  }

  /// Processes a single local album to ensure proper linking with remote albums
  Future<void> _processLocalAlbum(LocalAlbum localAlbum, String ownerId) {
    final hasLinkedRemoteAlbum = localAlbum.linkedRemoteAlbumId != null;

    if (hasLinkedRemoteAlbum) {
      return _handleLinkedAlbum(localAlbum);
    } else {
      return _handleUnlinkedAlbum(localAlbum, ownerId);
    }
  }

  /// Handles albums that are already linked to a remote album
  Future<void> _handleLinkedAlbum(LocalAlbum localAlbum) async {
    final remoteAlbumId = localAlbum.linkedRemoteAlbumId!;
    final remoteAlbum = await _remoteAlbumRepository.get(remoteAlbumId);

    final remoteAlbumExists = remoteAlbum != null;
    if (!remoteAlbumExists) {
      return _localAlbumRepository.unlinkRemoteAlbum(localAlbum.id);
    }
  }

  /// Handles albums that are not linked to any remote album
  Future<void> _handleUnlinkedAlbum(LocalAlbum localAlbum, String ownerId) async {
    final existingRemoteAlbum = await _remoteAlbumRepository.getByName(localAlbum.name, ownerId);

    if (existingRemoteAlbum != null) {
      return _linkToExistingRemoteAlbum(localAlbum, existingRemoteAlbum);
    }

    // The by-name lookup above only sees albums this device has already
    // synced down locally. If the server just materialized this album from
    // upload metadata (AssetMediaService.materializeSourceAlbums) moments
    // ago, the local cache may not have caught up yet, and creating by name
    // here would produce a second, duplicate album with the same name. Ask
    // the server directly by the stable mobile source album id -- which
    // can't collide with an unrelated album that happens to share the same
    // name -- before falling back to creation.
    if (SettingsRepository.instance.appConfig.backup.syncAlbums) {
      final sourceMatchedAlbum = await _albumApiRepository.getBySourceAlbumId(
        localAlbum.id,
        _storeService.get(StoreKey.currentUser),
      );
      if (sourceMatchedAlbum != null) {
        return _linkToSourceMatchedAlbum(localAlbum, sourceMatchedAlbum);
      }
    }

    return _createAndLinkNewRemoteAlbum(localAlbum);
  }

  /// Links a local album to an existing remote album
  Future<void> _linkToExistingRemoteAlbum(LocalAlbum localAlbum, dynamic existingRemoteAlbum) {
    return _localAlbumRepository.linkRemoteAlbum(localAlbum.id, existingRemoteAlbum.id);
  }

  /// Caches a server-materialized remote album locally, then links to it
  Future<void> _linkToSourceMatchedAlbum(LocalAlbum localAlbum, RemoteAlbum sourceMatchedAlbum) async {
    await _remoteAlbumRepository.create(sourceMatchedAlbum, []);
    return _localAlbumRepository.linkRemoteAlbum(localAlbum.id, sourceMatchedAlbum.id);
  }

  /// Creates a new remote album and links it to the local album
  Future<void> _createAndLinkNewRemoteAlbum(LocalAlbum localAlbum) async {
    dPrint(() => "Creating new remote album for local album: ${localAlbum.name}");
    final newRemoteAlbum = await _albumApiRepository.createDriftAlbum(
      localAlbum.name,
      _storeService.get(StoreKey.currentUser),
      assetIds: [],
    );
    await _remoteAlbumRepository.create(newRemoteAlbum, []);
    return _localAlbumRepository.linkRemoteAlbum(localAlbum.id, newRemoteAlbum.id);
  }
}
