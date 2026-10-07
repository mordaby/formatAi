// The Save popup when the learned output is one of the user's saved formats (owner decision 2026-10-07, "fewer clicks: ask once, at the moment
// it matters"). ONE dialog, the format question first:
//   - the input is one of the format's sources: "This is your format X, from Y. Update its rules, or save as a new format?" -
//     Update its rules / Save as a new format / Cancel;
//   - it is not: "This looks like your format X. Add this file as a new source of it?" - Add as a source / Save as a new format / Cancel;
//   - it is not, and the learned rules break the format lock: "... but this file can't be added as a source of it: <why>." - Save as a new
//     format / Cancel;
//   - it is not, and the format already has as many sources as the plan allows (SPEC 11): "This output looks like one of your formats." and
//     "X already has N sources (your plan's limit)." with the upgrade - Save as a new format / Cancel (never an add the server would refuse);
//   - several formats: a radio list (most recently used first, the first chosen), each saying which of these it is; the buttons follow it.
// All of it is part of "Formats with several sources" (the feature switch): while it is off this dialog is never shown.
// ... and below it, when the rules hold a list of fixed values or an identifier-shaped value (`CopiedListSave`), the same lines and the same
// question, answered with a radio (neither is chosen for the user: the words have no agenda) before the save buttons can be used.
import { useId, useState, type ReactNode } from 'react';
import type { SaveFinding } from '../../editor';
import { UpgradeButton } from '../../app/Upgrade';
import { useI18n, type MessageKey } from '../../i18n';
import { Button, Dialog } from '../../ui';
import { FindingLines, findingForm, type SaveChoice } from './CopiedListSave';
import { ChoiceGroup } from './fields';
import { Marked } from './Named';
import type { FormatOffer, LockReason } from './useFormatMatch';

/** The reasons as one phrase in the UI's language ("the title rows differ and the column widths differ"). */
export function useReasonsText(): (reasons: readonly LockReason[]) => string {
  const { t, lang } = useI18n();
  return (reasons) => {
    const parts = reasons.map((r) => (r.kind === 'numberFormat' ? t('match.reason.numberFormat', { column: r.column }) : t(`match.reason.${r.kind}` as MessageKey)));
    try {
      return new Intl.ListFormat(lang === 'he' ? 'he' : 'en', { type: 'conjunction' }).format(parts);
    } catch {
      return parts.join(', ');
    }
  };
}

interface Props {
  offers: readonly FormatOffer[];
  findings: readonly SaveFinding[];
  /** Columns of the rules about to be saved that still need the user's input (an update saves them empty). */
  needsInput: number;
  onAnswer(keep: boolean, choice: SaveChoice): void;
  onCancel(): void;
}

export function FormatMatchDialog({ offers, findings, needsInput, onAnswer, onCancel }: Props) {
  const { t } = useI18n();
  const reasonsText = useReasonsText();
  const groupId = useId();
  const [selected, setSelected] = useState(0);
  const [keep, setKeep] = useState<'keep' | 'without' | undefined>(undefined);
  const offer = offers[Math.min(selected, offers.length - 1)]!;
  const askKeep = findings.length > 0;
  const waitingForKeep = askKeep && keep === undefined;
  const answer = (choice: SaveChoice): void => onAnswer(!askKeep || keep === 'keep', choice);

  const name = (text: string): ReactNode => (
    <strong>
      <bdi>{text}</bdi>
    </strong>
  );
  // What saving into the chosen format means, said under the question.
  const notes = (o: FormatOffer): ReactNode[] => {
    if (o.kind !== 'update') return [];
    const out: ReactNode[] = [];
    if (o.reasons.length > 0 && o.sources > 1) {
      out.push(<p key="format" className="muted">{t(o.sources === 2 ? 'match.formatChange.one' : 'match.formatChange.other', { n: o.sources - 1 })}</p>);
    }
    if (needsInput > 0) out.push(<p key="input" className="muted">{t(needsInput === 1 ? 'match.needsInput.one' : 'match.needsInput.other', { n: needsInput })}</p>);
    return out;
  };
  // A format at the plan's sources per format: said with the upgrade, under the question (the add is not offered).
  const limit = (o: FormatOffer): ReactNode =>
    o.kind === 'full' ? (
      <div className="format-match__limit" data-testid="format-match-limit">
        <p>
          <Marked id="match.limit" nodes={{ format: name(o.formatName), n: <span className="tabular">{o.sources}</span> }} />
        </p>
        <UpgradeButton variant="link" trigger="sourcesPerFormat" />
      </div>
    ) : null;

  const question =
    offers.length === 1 ? (
      <>
        <p data-testid="format-match-question" data-kind={offer.kind}>
          {offer.kind === 'update' ? (
            <Marked id="match.update" nodes={{ format: name(offer.formatName), source: name(offer.conversion!.sourceName) }} />
          ) : offer.kind === 'attach' ? (
            <Marked id="match.attach" nodes={{ format: name(offer.formatName) }} />
          ) : offer.kind === 'full' ? (
            t('match.full')
          ) : (
            <Marked id="match.locked" nodes={{ format: name(offer.formatName), reasons: reasonsText(offer.reasons) }} />
          )}
        </p>
        {limit(offer)}
        {notes(offer)}
      </>
    ) : (
      <>
        <fieldset className="choices format-match__list" data-testid="format-match-question" data-kind="several">
          <legend>{t('match.several', { n: offers.length })}</legend>
          {offers.map((o, i) => {
            const id = `${groupId}-${i}`;
            return (
              <div className="format-match__option" key={o.formatId} data-format={o.formatId} data-kind={o.kind}>
                <input id={id} className="choice__input" type="radio" name={groupId} checked={i === selected} onChange={() => setSelected(i)} aria-describedby={`${id}-what`} />
                <label htmlFor={id}>
                  <bdi>{o.formatName}</bdi>
                </label>
                <span id={`${id}-what`} className="muted format-match__what">
                  {o.kind === 'update' ? (
                    <Marked id="match.option.update" nodes={{ source: <bdi>{o.conversion!.sourceName}</bdi> }} />
                  ) : o.kind === 'attach' ? (
                    t('match.option.attach')
                  ) : o.kind === 'full' ? (
                    t('match.option.full', { n: o.sources })
                  ) : (
                    t('match.option.locked', { reasons: reasonsText(o.reasons) })
                  )}
                </span>
              </div>
            );
          })}
        </fieldset>
        {limit(offer)}
        {notes(offer)}
      </>
    );

  const form = askKeep ? findingForm(findings) : 'these';
  return (
    <Dialog open onClose={onCancel} title={t('copiedList.title')}>
      <div data-testid="format-match-dialog">
        {question}
        {askKeep ? (
          <div className="format-match__keep" data-testid="format-match-keep">
            <FindingLines findings={findings} />
            <ChoiceGroup<'keep' | 'without'>
              label={t(`copiedList.ask.${form}`)}
              value={keep}
              onChange={setKeep}
              options={[
                { value: 'keep', label: t(`copiedList.keep.${form}`) },
                { value: 'without', label: t(`copiedList.without.${form}`) },
              ]}
            />
            {waitingForKeep ? <p className="muted" data-testid="format-match-keep-first">{t('match.keepFirst')}</p> : null}
          </div>
        ) : null}
      </div>
      <div className="dialog__actions">
        {offer.kind === 'update' ? (
          <Button variant="primary" disabled={waitingForKeep} onClick={() => answer({ kind: 'update', offer })} data-answer="update">
            {t('match.do.update')}
          </Button>
        ) : offer.kind === 'attach' ? (
          <Button variant="primary" disabled={waitingForKeep} onClick={() => answer({ kind: 'attach', offer })} data-answer="attach">
            {t('match.do.attach')}
          </Button>
        ) : null}
        <Button variant={offer.kind === 'locked' || offer.kind === 'full' ? 'primary' : 'secondary'} disabled={waitingForKeep} onClick={() => answer({ kind: 'new' })} data-answer="new">
          {t('match.do.new')}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-answer="cancel">
          {t('copiedList.cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
