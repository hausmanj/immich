import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';
import { AssistantIndexRunTable } from 'src/schema/tables/assistant-index-run.table';
import { LibraryTable } from 'src/schema/tables/library.table';
import { UserTable } from 'src/schema/tables/user.table';

@Table('assistant_index_asset')
@Index({ columns: ['runId'] })
@Index({ columns: ['assetId'] })
@Index({ columns: ['ownerId', 'libraryId'] })
@Index({ columns: ['sourceDirectory'] })
@Index({ columns: ['fileExtension'] })
@Index({
  columns: ['runId', 'assetId'],
  unique: true,
  where: '"assetId" IS NOT NULL',
})
export class AssistantIndexAssetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssistantIndexRunTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  runId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  libraryId!: string | null;

  @Column()
  originalPath!: string;

  @Column()
  sourceDirectory!: string;

  @Column()
  originalFileName!: string;

  @Column({ type: 'character varying', nullable: true })
  fileExtension!: string | null;

  @Column({ type: 'character varying' })
  type!: string;

  @Column({ type: 'bigint', nullable: true })
  fileSizeInByte!: string | null;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  @Column({ type: 'integer', nullable: true })
  duration!: number | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  localDateTime!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  dateTimeOriginal!: Timestamp | null;

  @Column({ type: 'character varying', nullable: true })
  cameraMake!: string | null;

  @Column({ type: 'character varying', nullable: true })
  cameraModel!: string | null;

  @Column({ type: 'character varying', nullable: true })
  city!: string | null;

  @Column({ type: 'character varying', nullable: true })
  state!: string | null;

  @Column({ type: 'character varying', nullable: true })
  country!: string | null;

  @Column({ type: 'character varying' })
  checksumAlgorithm!: string;

  @Column({ type: 'boolean' })
  isExternal!: boolean;

  @Column({ type: 'boolean' })
  isEdited!: boolean;

  @Column({ type: 'boolean' })
  hasGps!: boolean;

  @Column({ type: 'boolean' })
  hasCamera!: boolean;

  @Column({ type: 'text', array: true })
  noiseLabels!: string[];

  @Column({ type: 'text', array: true })
  riskLabels!: string[];

  @Column({ type: 'jsonb' })
  evidence!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
