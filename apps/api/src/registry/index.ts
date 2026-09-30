// The registry (SPEC 8.12, 8.15, 13): a signed-in user's saved formats, the sources they read, and the conversions between them.
export { registerRegistryRoutes, type RegisterRegistryRoutesOptions } from './routes.js';
export { applyFormat, headerRenames, type Propagated } from './propagate.js';
export {
  applySource,
  mergeForReuse,
  mergeFromEdit,
  pickReusableSource,
  structureOfDoc,
  withDerivedRequired,
  withSourceAliases,
  type EditMerge,
  type ReuseMerge,
  type SourceApplied,
} from './sourceLogic.js';
export { describeMigration, groupingKey, planSourceMigration, runSourceMigration, type MigrationPlan, type MigrationSummary } from './migrate.js';
export { checkRulesFile, signatureOf, type RulesCheck } from './rules.js';
