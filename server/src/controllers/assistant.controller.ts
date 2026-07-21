import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
  AssistantExecuteReviewPlanRequestDto,
  AssistantExecuteReviewPlanResponseDto,
  AssistantIndexRunRequestDto,
  AssistantIndexRunResponseDto,
  AssistantIndexRunsResponseDto,
  AssistantMutationCapabilitiesResponseDto,
  AssistantMutationRequestDto,
  AssistantMutationResponseDto,
  AssistantReviewAlbumRequestDto,
  AssistantReviewAlbumResponseDto,
  AssistantToolRequestDto,
  AssistantToolResponseDto,
  AssistantUndoRequestDto,
  AssistantUndoResponseDto,
} from 'src/dtos/assistant.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { AssistantService } from 'src/services/assistant.service';

@ApiTags('Assistant')
@Controller('assistant')
export class AssistantController {
  constructor(private service: AssistantService) {}

  @Get('assessment')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Assess library organization',
    description: 'Read library metadata and return organization findings without mutating assets.',
    history: HistoryBuilder.v3(),
  })
  assessLibrary(@Auth() auth: AuthDto): Promise<AssistantAssessmentResponseDto> {
    return this.service.assess(auth);
  }

  @Post('chat')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Chat with the library assistant',
    description: 'Ask the configured LLM provider for photo library organization suggestions.',
    history: HistoryBuilder.v3(),
  })
  assistantChat(@Auth() auth: AuthDto, @Body() dto: AssistantChatRequestDto): Promise<AssistantChatResponseDto> {
    return this.service.chat(auth, dto);
  }

  @Post('tool')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Run an assistant audit tool',
    description: 'Run a read-only deterministic assistant audit or search against the authenticated user library.',
    history: HistoryBuilder.v3(),
  })
  runTool(@Auth() auth: AuthDto, @Body() dto: AssistantToolRequestDto): Promise<AssistantToolResponseDto> {
    return this.service.runTool(auth, dto);
  }

  @Get('index-runs')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List assistant index runs',
    description: 'List recent persisted assistant indexing runs for the authenticated user.',
    history: HistoryBuilder.v3(),
  })
  getIndexRuns(@Auth() auth: AuthDto): Promise<AssistantIndexRunsResponseDto> {
    return this.service.getIndexRuns(auth);
  }

  @Get('index-runs/:id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get an assistant index run',
    description: 'Get persisted assistant indexing status, summary, and top groups for one run.',
    history: HistoryBuilder.v3(),
  })
  getIndexRun(@Auth() auth: AuthDto, @Param('id') id: string): Promise<AssistantIndexRunResponseDto> {
    return this.service.getIndexRun(auth, id);
  }

  @Post('index-runs')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Create an assistant index run',
    description:
      'Create a read-only persisted assistant index over imported Immich assets. The initial pass records source, metadata, noise, and risk evidence without mutating assets.',
    history: HistoryBuilder.v3(),
  })
  createIndexRun(
    @Auth() auth: AuthDto,
    @Body() dto: AssistantIndexRunRequestDto,
  ): Promise<AssistantIndexRunResponseDto> {
    return this.service.createIndexRun(auth, dto);
  }

  @Post('review-album')
  @Authenticated({ permission: Permission.AlbumCreate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Create an assistant review album',
    description: 'Create a reversible review album from explicit assistant asset IDs or a deterministic assistant cohort.',
    history: HistoryBuilder.v3(),
  })
  createReviewAlbum(
    @Auth() auth: AuthDto,
    @Body() dto: AssistantReviewAlbumRequestDto,
  ): Promise<AssistantReviewAlbumResponseDto> {
    return this.service.createReviewAlbum(auth, dto);
  }

  @Post('review-plan')
  @Authenticated({ permission: Permission.AlbumCreate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Execute an assistant review-album plan',
    description:
      'Create multiple reversible assistant review albums from approved concrete review actions. Each album writes its own assistant change journal and undo path.',
    history: HistoryBuilder.v3(),
  })
  executeReviewPlan(
    @Auth() auth: AuthDto,
    @Body() dto: AssistantExecuteReviewPlanRequestDto,
  ): Promise<AssistantExecuteReviewPlanResponseDto> {
    return this.service.executeReviewPlan(auth, dto);
  }

  @Get('mutation-capabilities')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List assistant mutation capabilities',
    description: 'List impactful assistant change types and whether apply/undo support is currently available.',
    history: HistoryBuilder.v3(),
  })
  getMutationCapabilities(): AssistantMutationCapabilitiesResponseDto {
    return this.service.getMutationCapabilities();
  }

  @Post('mutation')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Plan or apply an assistant mutation',
    description:
      'Plan or apply a supported assistant library mutation. Every request writes a persisted change journal before applying changes.',
    history: HistoryBuilder.v3(),
  })
  runAssistantMutation(
    @Auth() auth: AuthDto,
    @Body() dto: AssistantMutationRequestDto,
  ): Promise<AssistantMutationResponseDto> {
    return this.service.runAssistantMutation(auth, dto);
  }

  @Post('undo')
  @Authenticated({ permission: Permission.AlbumDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Undo an assistant change',
    description: 'Undo a supported assistant-created change from its persisted change journal.',
    history: HistoryBuilder.v3(),
  })
  undoAssistantChange(@Auth() auth: AuthDto, @Body() dto: AssistantUndoRequestDto): Promise<AssistantUndoResponseDto> {
    return this.service.undoAssistantChange(auth, dto);
  }
}
