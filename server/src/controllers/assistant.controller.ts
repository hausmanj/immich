import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AssistantAssessmentResponseDto,
  AssistantChatRequestDto,
  AssistantChatResponseDto,
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
}
