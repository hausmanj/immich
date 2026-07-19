# Open PR Triage: iOS Originals and Large Libraries

Date: 2026-07-19

GitHub reported 268 open Immich PRs at triage time. I filtered the open PR list by title, labels, and body for terms related to iOS/iPhone Photos, originals, upload/backup/sync reliability, and large-library organization/performance.

## Apply Now

### Direct package update: photo_manager 3.10.0

Source: https://pub.dev/packages/photo_manager/changelog

Decision: applied locally in `mobile/pubspec.yaml` and `mobile/pubspec.lock`.

Reason: 3.10.0 adds Darwin `AssetEntity.darwin.hasAdjustments` and `AssetEntity.darwin.getBaseFile()`, which are needed for the iOS unedited-original experiment. It also includes Darwin/iCloud original-file export fixes relevant to Optimize Storage cases.

### PR #28543: feat(mobile): stack edited photos and bursts on ios

Status: open draft

URL: https://github.com/immich-app/immich/pull/28543

Decision: Do not apply the full PR. It is large and draft, with schema migrations, generated Pigeon APIs, upload services, backup repository changes, stack logic, and extensive tests.

Applied locally: partial adoption only, specifically the safer resource-ordering idea for native hashing:

- Prefer non-current `.photo` / `.video` resources.
- Prefer adjustment-base resources before falling back to a bare current resource.
- Only fall back to current/full-size resources when no better original candidate is available.

Reason: this improves the existing local iOS original-upload patch without adopting the full "upload original + edited and stack them" behavior.

## Strong Candidates To Watch Or Cherry-Pick Later

### PR #29985: chore: flutter pub upgrade

URL: https://github.com/immich-app/immich/pull/29985

Decision: Do not apply. The PR explicitly excludes the `photo_manager` bump because `originFile` changed and needs more testing around hash mismatches. Our local patch intentionally takes `photo_manager` 3.10.0 and adds detailed logging/fallbacks, so this PR is useful context but not something to merge wholesale.

### PR #29870: fix(mobile): don't let a frozen sync block syncing on resume

URL: https://github.com/immich-app/immich/pull/29870

Reason to consider: directly improves backup/sync reliability after app suspension, especially relevant on iOS where background execution can freeze tasks.

Risk: moderate. Touches sync task lifecycle. Should be tested with actual background/resume backup flows.

### PR #29351: fix(mobile): treat wired ethernet as unmetered on ios

URL: https://github.com/immich-app/immich/pull/29351

Reason to consider: useful if backing up over USB-C Ethernet or iOS-on-Mac networking with cellular uploads disabled.

Decision: applied locally in full. Risk is low; this is a narrow iOS connectivity change.

### PR #29553: feat(mobile): Add parallel upload count settings option

URL: https://github.com/immich-app/immich/pull/29553

Reason to consider: useful for tuning large uploads on slow/unreliable connections.

Risk: moderate. Changes settings and upload concurrency behavior.

### PR #29558: feat(mobile): Add support for metered VPN uploads

URL: https://github.com/immich-app/immich/pull/29558

Reason to consider: useful if backup traffic runs over a VPN that reports as metered.

Risk: moderate. Adds new settings and changes network gating.

## Large Library Organization / Performance Candidates

### PR #29286: perf(server): improve person list performance

URL: https://github.com/immich-app/immich/pull/29286

Reason to consider: adds a persisted `asset_count` on people with database triggers; PR reports about a 10x improvement for large people lists.

Risk: high enough to avoid ad hoc local adoption. It adds a database migration and triggers.

### PR #29732: refactor: resolve all duplicates

URL: https://github.com/immich-app/immich/pull/29732

Reason to consider: fixes large duplicate-resolution requests exceeding the server 10 MB JSON body limit by adding a resolve-all endpoint.

Risk: moderate. Server and web API behavior change.

### PR #30021: fix(web): download archives via html POST forms

URL: https://github.com/immich-app/immich/pull/30021

Reason to consider: avoids buffering large download archives in browser memory.

Risk: moderate. Web/server download flow change.

### PR #29528: feat: same-second photos now sub-sort by filename

URL: https://github.com/immich-app/immich/pull/29528

Reason to consider: better timeline ordering for cameras without subsecond EXIF data.

Risk: low to moderate. Query ordering change.

### PR #29401: fix(server): preserve time in album start and end dates

URL: https://github.com/immich-app/immich/pull/29401

Reason to consider: improves album chronological ordering when many albums share the same day.

Risk: moderate. Previous approach was rejected for timeline query performance, though this PR notes PostgreSQL 18 work may change that.

### PR #29338: fix(mobile): order album/place/person timelines by local date

URL: https://github.com/immich-app/immich/pull/29338

Reason to consider: fixes mobile timeline grouping/order mismatch for album, place, and person views.

Risk: low to moderate. Local DB query ordering change with tests.

### PR #29544: feat: Bulk remove from album modal

URL: https://github.com/immich-app/immich/pull/29544

Reason to consider: directly improves large-library album cleanup workflows.

Risk: not ready for local adoption. The PR itself notes current caveats and uses repeated API calls instead of a bulk endpoint.

## Related But Not Primary

### PR #29965: fix(mobile): decode remote thumbnails at displayed size

URL: https://github.com/immich-app/immich/pull/29965

Reason to consider: reduces iOS memory pressure in long timeline/search scrolling.

### PR #30022: fix(server): handle frame cropping in rkmpp hardware transcoding

URL: https://github.com/immich-app/immich/pull/30022

Reason to consider: relevant for iPhone clean-aperture H.264 videos on RKMPP hardware.

### PR #29660: fix(web): attach file picker input to DOM so iOS Safari fires change

URL: https://github.com/immich-app/immich/pull/29660

Reason to consider: fixes iOS Safari shared-link uploads, especially when iCloud originals make picker return slowly.

### PR #30024: fix(server): file uploads for files with extension only filenames

URL: https://github.com/immich-app/immich/pull/30024

Reason to consider: small upload robustness fix for filenames like `.png`.

## Recommendation

For the current local experiment, keep the implementation focused on iOS original extraction and logging. Do not merge the draft edited-photo stacking PR yet. If we want to broaden scope after device testing, the next safest PRs to try are:

1. #29870 for frozen sync on resume.
2. #29338 for mobile local-date ordering.
3. #29965 for mobile grid memory pressure.

Server/database PRs like #29286, #29732, and #30021 should be tested in a proper server environment before adopting locally.
