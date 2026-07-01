/**
 * Alert & Notification domain types: rules, conditions, channels and alerts.
 */
import type { IsoTimestamp, Uuid } from './common.js';

/** Comparison operators usable in a rule condition predicate. */
export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'contains',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/**
 * A single field predicate evaluated against a domain event. A rule's
 * conditions are AND-combined.
 */
export interface Condition {
  /** Dot-path of the event field to evaluate (e.g. `payload.kind`). */
  field: string;
  operator: ConditionOperator;
  /** Comparison operand; shape depends on `operator`. */
  value: unknown;
}

/** Delivery channels an alert can be dispatched through. */
export const CHANNEL_TYPES = ['in_app', 'email', 'whatsapp'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** A configured notification channel with an optional destination target. */
export interface Channel {
  type: ChannelType;
  /** Destination (email address, phone number, ...); omitted for `in_app`. */
  target?: string;
}

/** Categories of domain event a rule can match. */
export const EVENT_KINDS = ['anomaly', 'scene', 'maintenance'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Alert severity levels. */
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * A minutes-of-day window `[startMin, endMin)` within `[0, 1440)`. When
 * `startMin > endMin` the window wraps around midnight.
 */
export interface TimeWindow {
  startMin: number;
  endMin: number;
}

/** A configurable alert rule evaluated against incoming domain events. */
export interface AlertRule {
  id: Uuid;
  name: string;
  enabled: boolean;
  eventKind: EventKind;
  /** AND-combined field predicates. */
  conditions: Condition[];
  /** Optional active window in minutes-of-day. */
  timeWindow?: TimeWindow;
  /** Optional zone scope. */
  zoneId?: Uuid;
  severity: AlertSeverity;
  channels: Channel[];
  /** Ordered contact ids for escalation. */
  escalationChain: Uuid[];
  /** Minutes between escalation steps, `> 0`. */
  escalationIntervalMin: number;
}

/** Lifecycle status of an alert. */
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'CLOSED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** A raised alert instance tracked through acknowledgement and escalation. */
export interface Alert {
  id: Uuid;
  ruleId: Uuid;
  severity: AlertSeverity;
  status: AlertStatus;
  /** Current escalation level, `0..escalationChain.length`. */
  escalationLevel: number;
  createdAt: IsoTimestamp;
  acknowledgedAt?: IsoTimestamp;
  acknowledgedBy?: Uuid;
}
