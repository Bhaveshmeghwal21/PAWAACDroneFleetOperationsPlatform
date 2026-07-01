import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import type { Mission } from '@pawaac/shared-types';
import { CreateMissionDto, UpdateMissionDto } from './dto';
import { MissionPlanningService } from './mission-planning.service';

/** REST surface for versioned mission authoring (Requirement 4). */
@Controller('missions')
export class MissionsController {
  constructor(private readonly service: MissionPlanningService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateMissionDto): Promise<Mission> {
    return this.service.createMission(dto);
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMissionDto,
  ): Promise<Mission> {
    return this.service.updateMission(id, dto);
  }

  @Get(':id')
  getLatest(@Param('id', ParseUUIDPipe) id: string): Promise<Mission> {
    return this.service.getLatestMission(id);
  }

  @Get(':id/versions/:version')
  getVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<Mission> {
    return this.service.getMissionVersion(id, version);
  }
}
