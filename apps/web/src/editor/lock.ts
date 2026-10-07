// Read-only while the deep analysis with AI works (SPEC 21 v5 item 6, the Result screen's panel): the fields it is asked for
// (output columns, by header; layout parts, by code) cannot be edited until it is done, and neither can the shape of the columns
// (adding, moving or removing one would shift what the answer was made for). Everything else stays editable; the answer is merged
// with those edits when it arrives (`mergeRules`). Pure: the store asks `lockProblem` before every edit.
import type { AiStepPartCode } from '@formatai/shared';
import type { EditAction, EditableRules, EditProblem } from './types';

/** What the deep analysis is working on. */
export interface EditLock {
  columns: ReadonlySet<string>;
  parts: ReadonlySet<AiStepPartCode>;
}

/** The layout part an action edits, if it edits one. */
function partOf(action: EditAction): AiStepPartCode | undefined {
  switch (action.type) {
    case 'setExpand':
      return 'rows';
    case 'addFilter':
    case 'updateFilter':
    case 'removeFilter':
    case 'setDedupe':
      return 'droppedRows';
    case 'setSort':
      return 'sort';
    case 'setGroup':
      return 'group';
    case 'setSummaryRows':
    case 'addSummaryRow':
    case 'updateSummaryRow':
    case 'removeSummaryRow':
      return 'summaryRows';
    case 'setTitleRows':
    case 'addTitleRow':
    case 'removeTitleRow':
    case 'setTitleText':
    case 'insertMonthFromDate':
      return 'dateTitle';
    default:
      return undefined;
  }
}

const locked = (path?: string, column?: string): EditProblem => ({
  code: 'locked',
  message: 'The deep analysis with AI is working on this part of the rules.',
  ...(path ? { path } : {}),
  ...(column ? { column } : {}),
});

/** The problem to answer an edit with while the deep analysis runs, or null when the edit may go ahead. */
export function lockProblem(action: EditAction, rules: EditableRules, lock: EditLock): EditProblem | null {
  switch (action.type) {
    // A whole new rules text, and the shape of the columns: they would move what the answer was made for.
    case 'setAdvancedJson':
    case 'replaceRules':
    case 'addColumn':
    case 'removeColumn':
    case 'reorderColumns':
      return locked();
    case 'setColumnHeader':
    case 'setColumnMethod':
    case 'setColumnFormat':
    case 'setColumnAgg': {
      const header = rules.output.columns[action.index]?.header;
      return header !== undefined && lock.columns.has(header) ? locked(`output.columns[${action.index}]`, header) : null;
    }
    default: {
      const part = partOf(action);
      // (a part that is not one of the codes - a setOutputOptions, a check - is never locked)
      return part !== undefined && lock.parts.has(part) ? locked() : null;
    }
  }
}
