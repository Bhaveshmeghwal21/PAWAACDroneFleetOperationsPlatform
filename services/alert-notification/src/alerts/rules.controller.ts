import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { AlertRule } from '@pawaac/shared-types';
import { UpsertRuleDto } from './dto';
import { RulesService } from './rules.service';

/**
 * REST surface for the configurable rule engine (Requirement 14.1). A single
 * upsert endpoint persists a rule and returns the stored representation.
 */
@Controller('rules')
export class RulesController {
  constructor(private readonly service: RulesService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  upsert(@Body() dto: UpsertRuleDto): Promise<AlertRule> {
    return this.service.upsertRule(dto);
  }
}
