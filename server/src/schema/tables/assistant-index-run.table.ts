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
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { LibraryTable } from 'src/schema/tables/library.table';
import { UserTable } from 'src/schema/tables/user.table';

@Table('assistant_index_run')
@UpdatedAtTrigger('assistant_index_run_updatedAt')
@Index({ columns: ['ownerId', 'createdAt'] })
@Index({ columns: ['libraryId'] })
export class AssistantIndexRunTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  libraryId!: string | null;

  @Column({ type: 'character varying' })
  mode!: string;

  @Column({ type: 'character varying' })
  status!: string;

  @Column({ type: 'character varying', nullable: true })
  originalPathPrefix!: string | null;

  @Column({ type: 'integer', default: 0 })
  totalAssets!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  indexedAssets!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  errorCount!: Generated<number>;

  @Column({ type: 'jsonb' })
  parameters!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  summary!: Record<string, unknown>;

  @Column({ type: 'character varying', nullable: true })
  logFilePath!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
