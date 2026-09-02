import { inspect } from 'node:util';

/**
 * A configuration secret that cannot be printed by accident: string
 * conversion, JSON serialisation and `util.inspect` all yield a placeholder.
 * The value is obtained only through `reveal()`, which makes every use
 * greppable.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** Length is safe to expose for diagnostics ("secret present, 44 chars"). */
  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return 'Secret([secret])';
  }
}
