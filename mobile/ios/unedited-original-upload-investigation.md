# iOS Unedited Original Upload Investigation

Date: 2026-07-19

## Goal

Make iOS backup prefer unedited Photos originals without randomly skipping user content.

## Findings

- Immich native sync enumerates `PHAsset` values and records `adjustmentTime` from the private `adjustmentTimestamp` key in `Runner/Sync/PHAssetExtensions.swift`.
- Local assets store `adjustmentTime`, but `LocalAssetEntityData.toDto()` currently sets `isEdited: false`, so local backup eligibility does not treat Photos-adjusted assets as edited.
- Hashing uses `PHAssetResourceManager.requestData` through `hashAsset()` in `Runner/Sync/MessagesImpl.swift`.
- Before this patch, `PHAsset.getResource()` preferred a resource with private `isCurrent == true` before `.fullSizePhoto` / `.fullSizeVideo`. For adjusted assets, this can hash the current rendered representation instead of the base original.
- Upload bytes are fetched through `photo_manager`, not Immich's native hash resource selector:
  - local path: `StorageRepository.getFileForAsset()` -> `AssetEntity.originFile`
  - iCloud path: `StorageRepository.loadFileFromCloud()` -> `AssetEntity.loadFile()`
- `photo_manager` 3.10.0 added Darwin-only APIs for exactly this distinction:
  - `AssetEntity.darwin.hasAdjustments`
  - `AssetEntity.darwin.getBaseFile()`
- `photo_manager` 3.10.0 also fixes Darwin `originFile` returning a locally-downsampled proxy for iCloud + Optimize iPhone Storage affected photos.

## Current Patch Behavior

- `photo_manager` is upgraded from 3.9.0 to 3.10.0 in `mobile/pubspec.yaml` and `mobile/pubspec.lock`.
- iOS upload file extraction checks `entity.darwin.hasAdjustments`.
- If Photos adjustments exist, Immich logs a detailed warning and attempts `entity.darwin.getBaseFile()`.
- If base export succeeds, Immich uploads that unedited base file.
- If base export fails, Immich logs another warning and falls back to the previous `originFile` / `loadFile(isOrigin: true)` path so backup does not silently skip content.
- Hashing now prefers original resource types (`.photo`, `.video`) first, then full-size rendered types, and only then the private `isCurrent` resource as a fallback.

## Upstream PRs Adopted Locally

- Full adoption: PR #29351, `fix(mobile): treat wired ethernet as unmetered on ios`.
  - URL: https://github.com/immich-app/immich/pull/29351
  - Local effect: iOS now determines unmetered networking from `NWPath` metered flags instead of requiring Wi-Fi, so wired Ethernet can upload while cellular uploads remain disabled.
- Partial adoption: PR #28543, `feat(mobile): stack edited photos and bursts on ios`.
  - URL: https://github.com/immich-app/immich/pull/28543
  - Local effect: only the safer original-resource ordering was incorporated into hashing/resource selection. The full draft behavior that uploads original + edited assets and stacks them was not merged.
- Direct dependency update: `photo_manager` 3.10.0.
  - Source: https://pub.dev/packages/photo_manager/changelog
  - Local effect: enables Darwin `AssetEntity.darwin.hasAdjustments` and `AssetEntity.darwin.getBaseFile()` for the upload experiment, and includes upstream fixes around Darwin/iCloud original-file export behavior.

## Runtime Log Markers

Search mobile logs for:

- `iOS asset has Photos adjustments; attempting unedited base export`
- `Using unedited base file for adjusted iOS asset`
- `Unable to export unedited base file for adjusted iOS asset; falling back to existing original-file export to avoid skipping content`
- `Adjusted iOS asset fallback export result`

Each log includes at least:

- asset id
- title
- media type
- width
- height
- duration
- exported base file path when base export succeeds
- fallback file path, or `<null>`, when base export fails

## Risk

The fallback avoids content loss, but it means a base-export failure may still upload the representation returned by `photo_manager`'s existing original-file path. That is safer for backup completeness, but it may still produce a rendered/current copy for some adjusted assets.

## Path Forward

1. Run this patch on a device with known edited Photos assets and iCloud Optimize Storage enabled.
2. Collect the runtime log markers above.
3. Compare uploaded files against originals from `osxphotos` / iCloud export for:
   - filename
   - byte size
   - pixel dimensions
   - EXIF
   - checksum
4. Decide whether fallback should remain upload-permissive, become a user-visible warning, or create a pending/problem state instead of uploading.
5. If hashes still diverge from uploaded bytes, move hashing to the same Darwin base-file export path used by upload.
