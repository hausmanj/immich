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
import { AssistantIndexRunTable } from 'src/schema/tables/assistant-index-run.table';

@Table('assistant_index_group')
@Index({ columns: ['runId', 'groupType'] })
@Index({ columns: ['runId', 'groupType', 'groupKey'], unique: true })
export class AssistantIndexGroupTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssistantIndexRunTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  runId!: string;

  @Column({ type: 'character varying' })
  groupType!: string;

  @Column()
  groupKey!: string;

  @Column()
  label!: string;

  @Column({ type: 'integer' })
  assetCount!: number;

  @Column({ type: 'real' })
  confidence!: number;

  @Column({ type: 'jsonb' })
  evidence!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
