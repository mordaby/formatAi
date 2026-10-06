// The API tests were written against the plans' original AI quotas (registered 3 a month, paid 150): "learn 3 times, then 429", the
// quota line, the admin's limit editor ... The quota itself is a product number that changes (owner decision 2026-10-06: 500 a month
// for the beta), so the API suite pins the original numbers here and keeps testing the COUNTING, not today's number. The config's own
// value is tested where it lives (packages/shared/test/apiMessages.test.ts).
import { tiers } from '@formatai/shared';

tiers.registered.aiLearns = { count: 3, period: 'month' };
tiers.paid.aiLearns = { count: 150, period: 'month' };
