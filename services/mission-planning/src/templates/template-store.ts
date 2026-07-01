import type { MissionTemplate } from './template';

/**
 * Read-only registry port for the mission template library (Requirement 6). The
 * service depends only on this interface; the default binding is an in-memory
 * registry of built-in templates, and a richer (e.g. persisted) catalogue can
 * be substituted without touching the service.
 */
export interface TemplateStore {
  /** Returns all available templates. */
  findAll(): Promise<MissionTemplate[]>;
  /** Returns a template by id, or `null` when it does not exist. */
  findById(id: string): Promise<MissionTemplate | null>;
}

/** DI token for the {@link TemplateStore} port. */
export const TEMPLATE_STORE = Symbol('TEMPLATE_STORE');
