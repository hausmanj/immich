import Photos

extension PHAsset {
  var platformPlaybackStyle: PlatformAssetPlaybackStyle {
    switch playbackStyle {
    case .image: return .image
    case .imageAnimated: return .imageAnimated
    case .livePhoto: return .livePhoto
    case .video: return .video
    case .videoLooping: return .videoLooping
    @unknown default: return .unknown
    }
  }

  func toPlatformAsset() -> PlatformAsset {
    return PlatformAsset(
      id: localIdentifier,
      name: title,
      type: Int64(mediaType.rawValue),
      createdAt: creationDate.map { Int64($0.timeIntervalSince1970) },
      updatedAt: modificationDate.map { Int64($0.timeIntervalSince1970) },
      width: Int64(pixelWidth),
      height: Int64(pixelHeight),
      durationMs: Int64(duration * 1000),
      orientation: 0,
      isFavorite: isFavorite,
      adjustmentTime: adjustmentTimestamp,
      latitude: location?.coordinate.latitude,
      longitude: location?.coordinate.longitude,
      playbackStyle: platformPlaybackStyle
    )
  }

  var title: String {
    return filename ?? originalFilename ?? "<unknown>"
  }

  var filename: String? {
    return value(forKey: "filename") as? String
  }

  var adjustmentTimestamp: Int64? {
    if let date = value(forKey: "adjustmentTimestamp") as? Date {
      return Int64(date.timeIntervalSince1970)
    }
    return nil
  }

  // This method is expected to be slow as it goes through the asset resources to fetch the originalFilename
  var originalFilename: String? {
    return getResource()?.originalFilename
  }

  func getResource() -> PHAssetResource? {
    let resources = PHAssetResource.assetResources(for: self)

    let filteredResources = resources.filter { $0.isMediaResource && isValidResourceType($0.type) }

    guard !filteredResources.isEmpty else {
      return nil
    }

    if filteredResources.count == 1 {
      return filteredResources.first
    }

    if let originalResource = getOriginalResource(from: filteredResources) {
      return originalResource
    }

    if let fullSizeResource = filteredResources.first(where: { isFullSizeResourceType($0.type) }) {
      return fullSizeResource
    }

    return filteredResources.first(where: { $0.isCurrent })
  }

  private func isValidResourceType(_ type: PHAssetResourceType) -> Bool {
    switch mediaType {
    case .image:
      return [.photo, .alternatePhoto, .fullSizePhoto, .adjustmentBasePhoto].contains(type)
    case .video:
      if [.video, .fullSizeVideo, .fullSizePairedVideo].contains(type) {
        return true
      }
      if #available(iOS 13, *) {
        return type == .adjustmentBaseVideo
      }
      return false
    default:
      return false
    }
  }

  private func isFullSizeResourceType(_ type: PHAssetResourceType) -> Bool {
    switch mediaType {
    case .image:
      return type == .fullSizePhoto
    case .video:
      return type == .fullSizeVideo
    default:
      return false
    }
  }

  private func getOriginalResource(from resources: [PHAssetResource]) -> PHAssetResource? {
    switch mediaType {
    case .image:
      return resources.first(where: { $0.type == .photo && !$0.isCurrent })
        ?? resources.first(where: { $0.type == .adjustmentBasePhoto })
        ?? resources.first(where: { $0.type == .photo })
    case .video:
      if let video = resources.first(where: { $0.type == .video && !$0.isCurrent }) {
        return video
      }

      if #available(iOS 13, *) {
        if let adjustmentBaseVideo = resources.first(where: { $0.type == .adjustmentBaseVideo }) {
          return adjustmentBaseVideo
        }
      }

      return resources.first(where: { $0.type == .video })
    default:
      return nil
    }
  }
}
