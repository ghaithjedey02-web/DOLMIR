import { InternalError } from '../../../kernel/errors.js';
import type { Document } from '../../documents/index.js';
import type { AiSystemDefinition } from './ai-system.js';

/** The systems a deployment ships; registered by the composition root. */
export class AiSystemRegistry {
  private readonly systems = new Map<string, AiSystemDefinition>();

  register(system: AiSystemDefinition): this {
    if (!/^[a-z][a-z0-9_]*$/.test(system.key)) {
      throw new InternalError(
        'INVALID_SYSTEM_KEY',
        `System key "${system.key}" must be snake_case.`,
      );
    }
    if (this.systems.has(system.key)) {
      throw new InternalError('DUPLICATE_SYSTEM', `System "${system.key}" is already registered.`);
    }
    this.systems.set(system.key, system);
    return this;
  }

  get(key: string): AiSystemDefinition | undefined {
    return this.systems.get(key);
  }

  list(): readonly AiSystemDefinition[] {
    return [...this.systems.values()];
  }

  forDocument(kind: Document['kind']): readonly AiSystemDefinition[] {
    return this.list().filter((system) => system.documentKinds.includes(kind));
  }
}
