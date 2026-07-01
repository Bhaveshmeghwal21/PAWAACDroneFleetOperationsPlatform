import fc from 'fast-check';
import {
  instantiateTemplate,
  requiredParameters,
} from '../src/templates/template-substitution';
import { BUILT_IN_TEMPLATES } from '../src/templates/in-memory-template-store';
import type {
  MissionTemplate,
  TemplateParams,
  TemplateValue,
  TemplateWaypoint,
} from '../src/templates/template';

/**
 * Property-based test for Mission Template substitution (design property P14,
 * Requirement 6). The property runs well above the mandated minimum of 100
 * iterations via `numRuns` (Requirement 30.3) and references P14 explicitly.
 *
 * **P14 — Template substitution totality (Validates: Requirements 6.1, 6.3):**
 * For ANY template and ANY parameter map that supplies every required
 * parameter, `instantiateTemplate` produces a mission with NO unresolved
 * `${...}` placeholder anywhere (name + waypoint fields) and reports no
 * missing parameters. Conversely, when a required parameter is omitted it is
 * reported in `missingParameters` and no mission is produced.
 */

/** Minimum iterations mandated for every property (Requirement 30.3). */
const NUM_RUNS = 300;

/** Detects any residual `${...}` placeholder in serialized output. */
const PLACEHOLDER_RE = /\$\{[^}]*\}/;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const ALNUM = [...LETTERS, ...'0123456789'.split(''), '_'];

/** A valid parameter identifier matching the substitution grammar. */
const identifierArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...LETTERS), fc.array(fc.constantFrom(...ALNUM), { maxLength: 6 }))
  .map(([head, rest]) => head + rest.join(''));

/** A non-empty set of distinct parameter names. */
const paramNamesArb: fc.Arbitrary<string[]> = fc.uniqueArray(identifierArb, {
  minLength: 1,
  maxLength: 6,
});

/**
 * Literal text that can never introduce a spurious placeholder: the `$`, `{`
 * and `}` characters are stripped so any `${...}` in the output must originate
 * from the template, never from interpolated literal text.
 */
const cleanWordArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 8 })
  .map((s) => s.replace(/[${}]/g, ''));

/**
 * A parameter value. Strings are scrubbed of `${}` so a substituted value can
 * never itself look like an unresolved placeholder (a realistic constraint:
 * a parameter value should not be a placeholder).
 */
const valueArb: fc.Arbitrary<string | number> = fc.oneof(
  fc.double({ min: -1000, max: 1000, noNaN: true }),
  fc.integer({ min: -1000, max: 1000 }),
  cleanWordArb,
);

const placeholder = (name: string): string => '${' + name + '}';

/** A waypoint field: either a literal number or a `${name}` placeholder. */
const fieldArb = (names: string[]): fc.Arbitrary<TemplateValue> =>
  fc.oneof(
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.constantFrom(...names).map(placeholder),
  );

const waypointArb = (names: string[]): fc.Arbitrary<TemplateWaypoint> =>
  fc.record({
    seq: fc.oneof(fc.nat(8), fc.constantFrom(...names).map(placeholder)),
    lat: fieldArb(names),
    lon: fieldArb(names),
    altitude: fieldArb(names),
    speed: fieldArb(names),
    gimbalAngle: fieldArb(names),
    loiterTime: fieldArb(names),
  });

/** A name string interleaving literal words and `${name}` placeholders. */
const nameFieldArb = (names: string[]): fc.Arbitrary<string> =>
  fc
    .array(fc.oneof(cleanWordArb, fc.constantFrom(...names).map(placeholder)), {
      minLength: 1,
      maxLength: 4,
    })
    .map((parts) => parts.join(' '));

/** A name string guaranteed to reference at least one placeholder. */
const nameFieldWithPlaceholderArb = (names: string[]): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...names),
      fc.array(fc.oneof(cleanWordArb, fc.constantFrom(...names).map(placeholder)), {
        maxLength: 3,
      }),
    )
    .map(([required, rest]) => [placeholder(required), ...rest].join(' '));

const buildTemplate = (
  name: string,
  waypoints: TemplateWaypoint[],
  requiredParams: string[],
): MissionTemplate => ({
  id: 'generated',
  name: 'Generated Template',
  description: 'A generated parameterizable template.',
  requiredParams,
  body: { name, status: 'draft', waypoints },
});

/** An arbitrary parameterizable template (placeholders are optional). */
const generatedTemplateArb: fc.Arbitrary<MissionTemplate> = paramNamesArb.chain((names) =>
  fc
    .record({
      name: nameFieldArb(names),
      waypoints: fc.array(waypointArb(names), { minLength: 0, maxLength: 4 }),
      requiredParams: fc.subarray(names),
    })
    .map(({ name, waypoints, requiredParams }) =>
      buildTemplate(name, waypoints, requiredParams),
    ),
);

/** A template guaranteed to have at least one required parameter. */
const requiredTemplateArb: fc.Arbitrary<MissionTemplate> = paramNamesArb.chain((names) =>
  fc
    .record({
      name: nameFieldWithPlaceholderArb(names),
      waypoints: fc.array(waypointArb(names), { minLength: 0, maxLength: 4 }),
      requiredParams: fc.subarray(names),
    })
    .map(({ name, waypoints, requiredParams }) =>
      buildTemplate(name, waypoints, requiredParams),
    ),
);

/** Mix generated templates with the shipped built-in catalogue. */
const anyTemplateArb: fc.Arbitrary<MissionTemplate> = fc.oneof(
  generatedTemplateArb,
  fc.constantFrom(...BUILT_IN_TEMPLATES),
);

const anyRequiredTemplateArb: fc.Arbitrary<MissionTemplate> = fc.oneof(
  requiredTemplateArb,
  fc.constantFrom(...BUILT_IN_TEMPLATES),
);

/** A parameter map supplying a value for every name in `names`. */
function paramsArb(names: string[]): fc.Arbitrary<TemplateParams> {
  if (names.length === 0) {
    return fc.constant({});
  }
  return fc.record(Object.fromEntries(names.map((name) => [name, valueArb])));
}

describe('P14 — Template substitution totality (design P14, Requirement 6)', () => {
  it('with ALL required params supplied, leaves no unresolved placeholder and produces a mission — Validates: Requirements 6.1, 6.3', () => {
    fc.assert(
      fc.property(
        anyTemplateArb.chain((template) =>
          paramsArb(requiredParameters(template)).map((params) => ({ template, params })),
        ),
        ({ template, params }) => {
          const result = instantiateTemplate(template, params);

          // No required parameter is reported missing (6.1) ...
          expect(result.missingParameters).toEqual([]);
          // ... no placeholder survives substitution (6.3) ...
          expect(result.unresolvedPlaceholders).toEqual([]);
          // ... and a concrete mission is produced.
          expect(result.mission).toBeDefined();

          // The serialized mission (name + all waypoint fields) contains no
          // `${...}` placeholder anywhere.
          const serialized = JSON.stringify(result.mission);
          expect(serialized).not.toContain('${');
          expect(serialized).not.toMatch(PLACEHOLDER_RE);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('when a required param is omitted, reports it and produces no mission — Validates: Requirements 6.1, 6.3', () => {
    fc.assert(
      fc.property(
        anyRequiredTemplateArb.chain((template) => {
          const required = requiredParameters(template);
          return fc
            .record({
              omit: fc.constantFrom(...required),
              params: paramsArb(required),
            })
            .map(({ omit, params }) => ({ template, omit, params }));
        }),
        ({ template, omit, params }) => {
          const partial: TemplateParams = { ...params };
          delete partial[omit];

          const result = instantiateTemplate(template, partial);

          // The omitted required parameter is named and no mission is produced.
          expect(result.missingParameters).toContain(omit);
          expect(result.mission).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
