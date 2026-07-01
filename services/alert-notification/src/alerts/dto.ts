import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  CHANNEL_TYPES,
  CONDITION_OPERATORS,
  EVENT_KINDS,
} from '@pawaac/shared-types';
import type {
  AlertSeverity,
  AlertStatus,
  ChannelType,
  ConditionOperator,
  EventKind,
} from '@pawaac/shared-types';
import { MINUTES_PER_DAY } from './rule-engine';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from './analytics.logic';

export { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT };

/** A single AND-combined field predicate (Requirement 14.2). */
export class ConditionDto {
  @IsString()
  @IsNotEmpty()
  field!: string;

  @IsIn(CONDITION_OPERATORS)
  operator!: ConditionOperator;

  /** Comparison operand; shape depends on `operator`, so left unconstrained. */
  @IsOptional()
  value?: unknown;
}

/** A configured delivery channel (Requirement 15). */
export class ChannelDto {
  @IsIn(CHANNEL_TYPES)
  type!: ChannelType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  target?: string;
}

/**
 * A minutes-of-day window in `[0, 1440)`. `startMin > endMin` is permitted and
 * denotes a window that wraps around midnight (Requirement 14.4).
 */
export class TimeWindowDto {
  @IsInt()
  @Min(0)
  @Max(MINUTES_PER_DAY - 1)
  startMin!: number;

  @IsInt()
  @Min(0)
  @Max(MINUTES_PER_DAY - 1)
  endMin!: number;
}

/**
 * Body for upserting an alert rule (Requirement 14.1). When `id` is supplied the
 * matching rule is replaced; otherwise a new rule is created.
 */
export class UpsertRuleDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsIn(EVENT_KINDS)
  eventKind!: EventKind;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions?: ConditionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TimeWindowDto)
  timeWindow?: TimeWindowDto;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsIn(ALERT_SEVERITIES)
  severity!: AlertSeverity;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChannelDto)
  channels?: ChannelDto[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  escalationChain?: string[];

  @IsInt()
  @Min(1)
  escalationIntervalMin!: number;
}


/**
 * Query for the alert analytics endpoint (Requirement 17.1/17.2). Both bounds
 * are required ISO-8601 timestamps; the service rejects `from > to`.
 */
export class AnalyticsQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}

/**
 * Query for the alert history endpoint (Requirement 17.3). All filters are
 * optional; when `from`/`to` are supplied the service rejects `from > to`.
 * Results are paginated and ordered newest-first.
 */
export class AlertHistoryQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(ALERT_STATUSES)
  status?: AlertStatus;

  @IsOptional()
  @IsIn(ALERT_SEVERITIES)
  severity?: AlertSeverity;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_HISTORY_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
