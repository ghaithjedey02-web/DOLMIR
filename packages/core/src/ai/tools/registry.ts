import { z } from 'zod';

import { InternalError } from '../../kernel/errors.js';
import type { Permission } from '../../modules/access/index.js';
import type { AnyToolDefinition, ToolDefinition } from './define-tool.js';
import type { ToolEffect } from './policy.js';

/** Provider-agnostic description of a tool, ready to become a vendor tool definition. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly effect: ToolEffect;
  readonly permission: Permission;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly descriptors = new Map<string, ToolDescriptor>();

  register<I, O>(tool: ToolDefinition<I, O>): this {
    if (this.tools.has(tool.name)) {
      throw new InternalError(
        'DUPLICATE_TOOL',
        `A tool named "${tool.name}" is already registered.`,
      );
    }
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = { ...z.toJSONSchema(tool.input) };
    } catch (cause) {
      throw new InternalError(
        'TOOL_SCHEMA_NOT_REPRESENTABLE',
        `The input schema of tool "${tool.name}" cannot be expressed as JSON Schema.`,
        { cause },
      );
    }
    this.tools.set(tool.name, tool);
    this.descriptors.set(tool.name, {
      name: tool.name,
      description: tool.description,
      effect: tool.effect,
      permission: tool.permission,
      inputSchema,
    });
    return this;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  describe(): readonly ToolDescriptor[] {
    return [...this.descriptors.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
