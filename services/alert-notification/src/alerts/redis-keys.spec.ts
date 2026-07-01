import {
  ALERT_STATE_FIELDS,
  ESCALATION_DUE_ZSET,
  alertStateKey,
  failedChannelsKey,
} from './redis-keys';

describe('Alert & Notification Redis key layout', () => {
  it('uses a single sorted-set key for the escalation timer wheel', () => {
    expect(ESCALATION_DUE_ZSET).toBe('alert:escalation:due');
  });

  it('namespaces per-alert state hashes by alert id', () => {
    expect(alertStateKey('abc-123')).toBe('alert:state:abc-123');
  });

  it('namespaces failed-channel sets by alert id', () => {
    expect(failedChannelsKey('abc-123')).toBe('alert:failed-channels:abc-123');
  });

  it('keeps distinct alert ids in distinct keyspaces', () => {
    expect(alertStateKey('a')).not.toBe(alertStateKey('b'));
    expect(failedChannelsKey('a')).not.toBe(failedChannelsKey('a-extra'));
  });

  it('exposes the escalation-state hash field names', () => {
    expect(ALERT_STATE_FIELDS).toEqual({
      status: 'status',
      escalationLevel: 'escalationLevel',
      intervalMs: 'intervalMs',
      ruleId: 'ruleId',
    });
  });
});
