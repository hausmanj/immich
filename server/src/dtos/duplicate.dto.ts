import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import { DuplicateClassification } from 'src/utils/duplicate.js';

const DuplicateResponseSchema = z
  .object({
    duplicateId: z.uuidv4().describe('Duplicate group ID'),
    assets: z.array(AssetResponseSchema).describe('Duplicate assets'),
    suggestedKeepAssetIds: z
      .array(z.uuidv4())
      .describe('Suggested asset IDs to keep, ranked by keeper score, album membership and path'),
    classification: z
      .enum(DuplicateClassification)
      .describe(
        'How strong the evidence is that these are the same file. Only conclusive groups may be resolved in bulk',
      ),
    betterQualityOutsideOriginals: z
      .boolean()
      .optional()
      .describe('True if a copy outside the originals folder has higher quality than the copy in originals'),
    betterQualityAssetIds: z
      .array(z.uuidv4())
      .optional()
      .describe('Asset IDs outside originals that have better quality than originals'),
    hasSuspectDate: z
      .boolean()
      .optional()
      .describe('True if any asset in this group has an EXIF date in May-Aug 2015 or May-Aug 2021 (Claude date error)'),
    suspectAssetIds: z
      .array(z.uuidv4())
      .optional()
      .describe('Asset IDs with suspect EXIF dates in May-Aug 2015 or May-Aug 2021'),
  })
  .meta({ id: 'DuplicateResponseDto' });

const DuplicateResolveGroupSchema = z
  .object({
    duplicateId: z.uuidv4(),
    keepAssetIds: z.array(z.uuidv4()).describe('Asset IDs to keep'),
    trashAssetIds: z.array(z.uuidv4()).describe('Asset IDs to trash or delete'),
    reviewed: z
      .boolean()
      .optional()
      .describe(
        'Set when a human has looked at this specific group. Required to trash from a group whose ' +
          'classification is only POSSIBLE_DUPLICATE, i.e. embedding similarity with no proof of identity',
      ),
  })
  .meta({ id: 'DuplicateResolveGroupDto' });

const DuplicateResolveSchema = z
  .object({
    groups: z.array(DuplicateResolveGroupSchema).min(1).describe('List of duplicate groups to resolve'),
  })
  .meta({ id: 'DuplicateResolveDto' });

export class DuplicateResponseDto extends createZodDto(DuplicateResponseSchema) {}
export class DuplicateResolveGroupDto extends createZodDto(DuplicateResolveGroupSchema) {}
export class DuplicateResolveDto extends createZodDto(DuplicateResolveSchema) {}
