import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
  AssistantReviewAlbumRequestDto,
  AssistantReviewAlbumResponseDto,
  AssistantToolRequestDto,
  AssistantToolResponseDto,
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
}
