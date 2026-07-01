import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import type { Mission } from '@pawaac/shared-types';
import { InstantiateTemplateDto } from './dto';
import type { MissionTemplate } from './template';
import { TemplatesService } from './templates.service';

/** REST surface for the mission template library (Requirement 6). */
@Controller('templates')
export class TemplatesController {
  constructor(private readonly service: TemplatesService) {}

  @Get()
  list(): Promise<MissionTemplate[]> {
    return this.service.listTemplates();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<MissionTemplate> {
    return this.service.getTemplate(id);
  }

  /**
   * Instantiates a template into a new validated mission. Returns `201 Created`
   * with the persisted mission; `400` when a required parameter is missing
   * (naming it) and `404` when the template is unknown.
   */
  @Post(':id/instantiate')
  @HttpCode(HttpStatus.CREATED)
  instantiate(
    @Param('id') id: string,
    @Body() dto: InstantiateTemplateDto,
  ): Promise<Mission> {
    return this.service.instantiate(id, dto.params);
  }
}
