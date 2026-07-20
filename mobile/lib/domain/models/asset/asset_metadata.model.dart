enum RemoteAssetMetadataKey {
  mobileApp("mobile-app");

  final String key;

  const RemoteAssetMetadataKey(this.key);
}

abstract class RemoteAssetMetadataValue {
  const RemoteAssetMetadataValue();

  Map<String, dynamic> toJson();
}

class RemoteAssetMetadataItem {
  final RemoteAssetMetadataKey key;
  final RemoteAssetMetadataValue value;

  const RemoteAssetMetadataItem({required this.key, required this.value});

  Map<String, Object?> toJson() {
    return {'key': key.key, 'value': value};
  }
}

class RemoteAssetMobileAppMetadata extends RemoteAssetMetadataValue {
  final String? cloudId;
  final String? createdAt;
  final String? adjustmentTime;
  final String? latitude;
  final String? longitude;
  final String? originalUploadSource;
  final bool? hasAdjustments;
  final bool? usedBaseOriginal;
  final bool? usedFallback;
  final String? uploadFileName;
  final int? uploadFileSizeBytes;
  final int? width;
  final int? height;
  final int? durationMs;

  const RemoteAssetMobileAppMetadata({
    this.cloudId,
    this.createdAt,
    this.adjustmentTime,
    this.latitude,
    this.longitude,
    this.originalUploadSource,
    this.hasAdjustments,
    this.usedBaseOriginal,
    this.usedFallback,
    this.uploadFileName,
    this.uploadFileSizeBytes,
    this.width,
    this.height,
    this.durationMs,
  });

  @override
  Map<String, dynamic> toJson() {
    final map = <String, Object?>{};
    if (cloudId != null) {
      map["iCloudId"] = cloudId;
    }
    if (createdAt != null) {
      map["createdAt"] = createdAt;
    }
    if (adjustmentTime != null) {
      map["adjustmentTime"] = adjustmentTime;
    }
    if (latitude != null) {
      map["latitude"] = latitude;
    }
    if (longitude != null) {
      map["longitude"] = longitude;
    }
    if (originalUploadSource != null) {
      map["originalUploadSource"] = originalUploadSource;
    }
    if (hasAdjustments != null) {
      map["hasAdjustments"] = hasAdjustments;
    }
    if (usedBaseOriginal != null) {
      map["usedBaseOriginal"] = usedBaseOriginal;
    }
    if (usedFallback != null) {
      map["usedFallback"] = usedFallback;
    }
    if (uploadFileName != null) {
      map["uploadFileName"] = uploadFileName;
    }
    if (uploadFileSizeBytes != null) {
      map["uploadFileSizeBytes"] = uploadFileSizeBytes;
    }
    if (width != null) {
      map["width"] = width;
    }
    if (height != null) {
      map["height"] = height;
    }
    if (durationMs != null) {
      map["durationMs"] = durationMs;
    }

    return map;
  }
}
