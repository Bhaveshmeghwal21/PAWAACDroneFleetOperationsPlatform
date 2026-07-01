import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { MavlinkExportService } from './mavlink-export.service';
import { MavlinkFormat, MavlinkMission } from './mavlink';

/** Default export format used when the `format` query parameter is omitted. */
const DEFAULT_FORMAT: MavlinkFormat = 'json';

/**
 * Normalizes and validates the `format` query parameter, defaulting to JSON.
 * Rejects anything other than `json`/`binary` with a `400` so the contract
 * surfaces clearly (Requirement 7.1).
 */
function parseFormat(raw: string | undefined): MavlinkFormat {
  if (raw === undefined || raw === '') {
    return DEFAULT_FORMAT;
  }
  if (raw === 'json' || raw === 'binary') {
    return raw;
  }
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: `format must be "json" or "binary", received "${raw}"`,
  });
}

/**
 * REST surface for PX4 MAVLink export (Requirement 7). Exposes
 * `GET /missions/:id/export?format=json|binary` alongside the authoring
 * controller's `GET /missions/:id` (the more specific `:id/export` route is
 * matched first by Express).
 *
 * - `format=json` (default) returns the {@link MavlinkMission} as JSON.
 * - `format=binary` returns the deterministic byte stream as
 *   `application/octet-stream`.
 *
 * Errors propagate from {@link MavlinkExportService}: `404` (unknown mission),
 * `422` (mission not validated, 7.2) and `409` (geofence conflict, 7.7).
 */
@Controller('missions')
export class ExportController {
  constructor(private readonly service: MavlinkExportService) {}

  @Get(':id/export')
  async export(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MavlinkMission | StreamableFile> {
    const fmt = parseFormat(format);
    const result = await this.service.exportMission(id, fmt);

    if (fmt === 'binary' && result.bytes) {
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="mission-${id}.mavlink"`,
      });
      return new StreamableFile(result.bytes);
    }

    return result;
  }
}
