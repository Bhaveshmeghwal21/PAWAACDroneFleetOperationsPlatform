import { Controller, Get, Query } from '@nestjs/common';
import type { Alert } from '@pawaac/shared-types';
import { AnalyticsQueryDto, AlertHistoryQueryDto } from './dto';
import { AnalyticsService } from './analytics.service';
import type { AlertAnalytics } from './analytics.logic';

/**
 * REST surface for alert history and analytics (task 11.9, Requirement 17):
 * - `GET /alerts`           — queryable, paginated history of past alerts (17.3).
 * - `GET /alerts/analytics` — alert counts grouped by zone and by hour for a
 *                             time range, with conservation guaranteed (17.1/17.2).
 *
 * The more specific `/alerts/analytics` route is declared before the generic
 * history handler so it is matched first.
 */
@Controller('alerts')
export class AlertsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('analytics')
  getAnalytics(@Query() query: AnalyticsQueryDto): Promise<AlertAnalytics> {
    return this.analytics.getAnalytics(query);
  }

  @Get()
  getHistory(@Query() query: AlertHistoryQueryDto): Promise<Alert[]> {
    return this.analytics.getHistory(query);
  }
}
