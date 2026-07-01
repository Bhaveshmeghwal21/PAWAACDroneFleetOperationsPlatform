import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';
import type { TemplateParams } from './template';

/**
 * Validates that a parameter map contains only primitive string/number values —
 * the only value kinds the substitution engine can interpolate into a mission
 * field (Requirement 6.1).
 */
@ValidatorConstraint({ name: 'isTemplateParams', async: false })
export class IsTemplateParamsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every(
      (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)),
    );
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'params must be an object whose values are strings or finite numbers';
  }
}

/**
 * Body for `POST /templates/:id/instantiate` (Requirement 6.1). Carries the
 * parameter map used to resolve the template's `${param}` placeholders. Whether
 * a *required* parameter is missing is determined by the service against the
 * specific template, so it raises a descriptive `400` naming the parameter
 * rather than being a static DTO rule (Requirement 6.2).
 */
export class InstantiateTemplateDto {
  @Validate(IsTemplateParamsConstraint)
  params!: TemplateParams;
}
