import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyAiService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.service';
import { GenerateAdCopyDto, ImproveTextDto } from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';

@ApiTags('Agency AI')
@Controller('/agency/ai')
export class AgencyAiController {
  constructor(private readonly aiService: AgencyAiService) {}

  @Post('/generate-copy')
  async generateCopy(@Body() body: GenerateAdCopyDto) {
    return this.aiService.generateCopy(body);
  }

  @Post('/improve-text')
  async improveText(@Body() body: ImproveTextDto) {
    return this.aiService.improveText(body);
  }
}
