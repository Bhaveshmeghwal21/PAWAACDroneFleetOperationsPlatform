import {
  collectPlaceholders,
  instantiateTemplate,
  requiredParameters,
} from '../src/templates/template-substitution';
import { BUILT_IN_TEMPLATES } from '../src/templates/in-memory-template-store';
import { sampleTemplate } from './helpers';

const PLACEHOLDER_RE = /\$\{[^}]*\}/;

describe('instantiateTemplate — pure substitution (Requirement 6, P14)', () => {
  it('resolves every placeholder in name and waypoints with valid params', () => {
    const result = instantiateTemplate(sampleTemplate(), {
      site: 'North Gate',
      lat: 12.5,
      lon: 56.25,
    });

    expect(result.missingParameters).toEqual([]);
    expect(result.unresolvedPlaceholders).toEqual([]);
    expect(result.mission).toBeDefined();
    expect(result.mission?.name).toBe('Sweep of North Gate');
    expect(result.mission?.waypoints[0]).toMatchObject({ lat: 12.5, lon: 56.25 });
  });

  it('leaves NO unresolved placeholder anywhere in the produced mission (6.3)', () => {
    const result = instantiateTemplate(sampleTemplate(), {
      site: 'Site A',
      lat: 1,
      lon: 2,
    });
    const serialized = JSON.stringify(result.mission);
    expect(serialized).not.toMatch(PLACEHOLDER_RE);
  });

  it('coerces single-placeholder numeric fields to numbers', () => {
    const result = instantiateTemplate(sampleTemplate(), {
      site: 'S',
      lat: '40.0',
      lon: '-3.7',
    });
    expect(typeof result.mission?.waypoints[0]?.lat).toBe('number');
    expect(result.mission?.waypoints[0]?.lat).toBe(40);
    expect(result.mission?.waypoints[0]?.lon).toBe(-3.7);
  });

  it('reports a missing required parameter by name and produces no mission (6.2)', () => {
    const result = instantiateTemplate(sampleTemplate(), { lat: 1, lon: 2 });
    expect(result.mission).toBeUndefined();
    expect(result.missingParameters).toContain('site');
  });

  it('reports every missing parameter when several are omitted', () => {
    const result = instantiateTemplate(sampleTemplate(), {});
    expect(result.missingParameters).toEqual(['lat', 'lon', 'site']);
  });

  it('honours a declared required parameter even if unused in the body', () => {
    const template = sampleTemplate({ requiredParams: ['site', 'lat', 'lon', 'operator'] });
    const result = instantiateTemplate(template, { site: 'S', lat: 1, lon: 2 });
    expect(result.missingParameters).toEqual(['operator']);
  });

  it('does not mutate the input template', () => {
    const template = sampleTemplate();
    const snapshot = structuredClone(template);
    instantiateTemplate(template, { site: 'S', lat: 1, lon: 2 });
    expect(template).toEqual(snapshot);
  });
});

describe('placeholder discovery', () => {
  it('collects distinct placeholders referenced in the body', () => {
    expect(collectPlaceholders(sampleTemplate()).sort()).toEqual(['lat', 'lon', 'site']);
  });

  it('unions declared and referenced params, sorted, for the required set', () => {
    const template = sampleTemplate({ requiredParams: ['site', 'extra'] });
    expect(requiredParameters(template)).toEqual(['extra', 'lat', 'lon', 'site']);
  });
});

describe('built-in catalogue is fully instantiable', () => {
  it('every built-in template resolves with its declared params supplied', () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const params = Object.fromEntries(
        requiredParameters(template).map((name) => [name, name === 'site' || name === 'poi' ? 'X' : 1]),
      );
      const result = instantiateTemplate(template, params);
      expect(result.missingParameters).toEqual([]);
      expect(result.unresolvedPlaceholders).toEqual([]);
      expect(JSON.stringify(result.mission)).not.toMatch(PLACEHOLDER_RE);
    }
  });
});
