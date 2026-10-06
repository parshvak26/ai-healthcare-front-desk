// Kept so older imports keep working. The fictional catalog and seed data now live in packages/shared, which the
// browser, the Worker, and the Retell tools all share.
export { allowedDemoPatients, createSeedState, faqEntries } from "../../../../packages/shared/src/index.ts";
export type { FaqEntry } from "../../../../packages/shared/src/index.ts";
