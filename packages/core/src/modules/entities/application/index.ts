export type {
  EntityAliasRepository,
  EntityPatch,
  EntityQuery,
  EntityRepository,
  SimilarName,
} from './ports.js';
export {
  EntityResolver,
  type EntityResolverOptions,
  type ResolveEntityInput,
} from './entity-resolver.js';
export {
  ImportEntities,
  type ImportEntitiesDependencies,
  type ImportEntitiesInput,
  ImportEntitiesInputSchema,
  type ImportEntitiesReport,
  type ImportEntityRow,
  ImportEntityRowSchema,
} from './import-entities.js';
