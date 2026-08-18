import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/sync_linked_album.service.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/store.provider.dart';
import 'package:immich_mobile/repositories/drift_album_api_repository.dart';
import 'package:mocktail/mocktail.dart';

import '../../fixtures/album.stub.dart';
import '../../fixtures/user.stub.dart';
import '../../infrastructure/repository.mock.dart';
import '../../service.mocks.dart';
import '../../unit/factories/remote_album_factory.dart';

void main() {
  // A container with the service's deps overridden but cancellationProvider left
  // alone, i.e. the root (main) isolate, where cancellationProvider has no
  // override and throws if read. The UI reads this provider here.
  ProviderContainer rootContainer() {
    final container = ProviderContainer(
      overrides: [
        localAlbumRepository.overrideWithValue(MockLocalAlbumRepository()),
        remoteAlbumRepository.overrideWithValue(MockRemoteAlbumRepository()),
        driftAlbumApiRepositoryProvider.overrideWithValue(MockDriftAlbumApiRepository()),
        storeServiceProvider.overrideWithValue(MockStoreService()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  // Regression for #29125 (Sync Albums toggle) and #29119 (can't leave the album
  // selection screen): #28694 made the provider watch cancellationProvider, so
  // reading it off the isolate threw. The cancellation now lives on the isolate
  // call path, not the provider, so the UI can build it.
  test('builds on the root isolate without a cancellationProvider override', () {
    final container = rootContainer();

    expect(() => container.read(syncLinkedAlbumServiceProvider), returnsNormally);
    expect(container.read(syncLinkedAlbumServiceProvider), isA<SyncLinkedAlbumService>());
  });

  test('manageLinkedAlbums runs from the UI without a cancellation signal', () {
    final service = rootContainer().read(syncLinkedAlbumServiceProvider);

    expect(service.manageLinkedAlbums(const [], 'user-1'), completes);
  });

  // Regression: the by-name lookup in _handleUnlinkedAlbum only sees albums
  // this device has already synced down locally, so it can't see an album the
  // server just materialized from upload metadata moments ago. Without the
  // by-source fallback below, that race produced a second, duplicate album
  // with the same name every time.
  group('_handleUnlinkedAlbum via manageLinkedAlbums (Sync Albums race)', () {
    late SyncLinkedAlbumService sut;
    late MockLocalAlbumRepository mockLocalAlbumRepository;
    late MockRemoteAlbumRepository mockRemoteAlbumRepository;
    late MockDriftAlbumApiRepository mockAlbumApiRepository;
    late MockStoreService mockStoreService;

    final localAlbum = LocalAlbumStub.recent.copyWith(linkedRemoteAlbumId: null);
    final sourceMatchedAlbum = RemoteAlbumFactory.create(name: localAlbum.name);

    setUpAll(() async {
      final db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
      await SettingsRepository.ensureInitialized(db);
    });

    setUp(() async {
      mockLocalAlbumRepository = MockLocalAlbumRepository();
      mockRemoteAlbumRepository = MockRemoteAlbumRepository();
      mockAlbumApiRepository = MockDriftAlbumApiRepository();
      mockStoreService = MockStoreService();
      sut = SyncLinkedAlbumService(
        mockLocalAlbumRepository,
        mockRemoteAlbumRepository,
        mockAlbumApiRepository,
        mockStoreService,
      );

      // The by-name cache lookup misses -- the local cache hasn't synced down
      // the album the server just materialized.
      when(
        () => mockRemoteAlbumRepository.getByName(localAlbum.name, 'owner-1'),
      ).thenAnswer((_) async => null);
      when(
        () => mockRemoteAlbumRepository.create(sourceMatchedAlbum, []),
      ).thenAnswer((_) async {});
      when(
        () => mockLocalAlbumRepository.linkRemoteAlbum(localAlbum.id, sourceMatchedAlbum.id),
      ).thenAnswer((_) async {});
      when(() => mockStoreService.get(StoreKey.currentUser)).thenReturn(UserStub.admin);

      await SettingsRepository.instance.write(SettingsKey.backupSyncAlbums, true);
    });

    test('links to the server-materialized album instead of creating a duplicate', () async {
      when(
        () => mockAlbumApiRepository.getBySourceAlbumId(localAlbum.id, UserStub.admin),
      ).thenAnswer((_) async => sourceMatchedAlbum);

      await sut.manageLinkedAlbums([localAlbum], 'owner-1');

      verify(() => mockRemoteAlbumRepository.create(sourceMatchedAlbum, [])).called(1);
      verify(() => mockLocalAlbumRepository.linkRemoteAlbum(localAlbum.id, sourceMatchedAlbum.id)).called(1);
      verifyNever(
        () => mockAlbumApiRepository.createDriftAlbum(
          localAlbum.name,
          UserStub.admin,
          assetIds: const <String>[],
        ),
      );
    });

    test('falls back to creating a new album when the server has no match either', () async {
      when(
        () => mockAlbumApiRepository.getBySourceAlbumId(localAlbum.id, UserStub.admin),
      ).thenAnswer((_) async => null);
      when(
        () => mockAlbumApiRepository.createDriftAlbum(
          localAlbum.name,
          UserStub.admin,
          assetIds: const <String>[],
        ),
      ).thenAnswer((_) async => sourceMatchedAlbum);

      await sut.manageLinkedAlbums([localAlbum], 'owner-1');

      verify(
        () => mockAlbumApiRepository.createDriftAlbum(
          localAlbum.name,
          UserStub.admin,
          assetIds: const <String>[],
        ),
      ).called(1);
    });

    test('skips the by-source lookup when Sync Albums is off', () async {
      await SettingsRepository.instance.write(SettingsKey.backupSyncAlbums, false);
      when(
        () => mockAlbumApiRepository.createDriftAlbum(
          localAlbum.name,
          UserStub.admin,
          assetIds: const <String>[],
        ),
      ).thenAnswer((_) async => sourceMatchedAlbum);

      await sut.manageLinkedAlbums([localAlbum], 'owner-1');

      verifyNever(() => mockAlbumApiRepository.getBySourceAlbumId(localAlbum.id, UserStub.admin));
    });
  });
}
