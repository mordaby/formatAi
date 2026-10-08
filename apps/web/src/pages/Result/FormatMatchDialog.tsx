// The Save popup when the learned output is one of the user's saved formats AND the example input is one of that format's inputs - the same
// file with other values (owner decisions 2026-10-07, "fewer clicks: ask once, at the moment it matters"). ONE dialog, the format question
// first, with no "source" in it:
//   - "Update your format X, or save as a new format?" - Update X / Save as a new format / Cancel. Update saves the learned rules as a new
//     version (earlier versions are kept); when that changes the format's output side and other inputs feed it: "Updating changes the format
//     for its other N input files too.";
//   - several formats: a radio list (most recently used first, the first chosen); the buttons follow it.
// ... and below it, when the rules hold a list of fixed values or an identifier-shaped value (`CopiedListSave`), the same lines and the same
// question, answered with a radio (neither is chosen for the user: the words have no agenda) before the save buttons can be used.
// (Another input for a format is asked at Learn, before anything is learned - not here.) It does not depend on the feature switch.
import { useId, useState, type ReactNode } from 'react';
import type { SaveFinding } from '../../editor';
import { useI18n } from '../../i18n';
import { Button, Dialog } from '../../ui';
import { FindingLines, findingForm, type SaveChoice } from './CopiedListSave';
import { ChoiceGroup } from './fields';
import { Marked } from './Named';
import type { FormatOffer } from './useFormatMatch';

interface Props {
  /** The formats this input already feeds (updates), most recently used first. */
  offers: readonly FormatOffer[];
  findings: readonly SaveFinding[];
  /** Columns of the rules about to be saved that still need the user's input (an update saves them empty). */
  needsInput: number;
  onAnswer(keep: boolean, choice: SaveChoice): void;
  onCancel(): void;
}

export function FormatMatchDialog({ offers, findings, needsInput, onAnswer, onCancel }: Props) {
  const { t } = useI18n();
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
  // What updating the chosen format means, said under the question.
  const notes = (o: FormatOffer): ReactNode[] => {
    const out: ReactNode[] = [];
    if (o.reasons.length > 0 && o.sources > 1) {
      out.push(<p key="format" className="muted">{t(o.sources === 2 ? 'match.formatChange.one' : 'match.formatChange.other', { n: o.sources - 1 })}</p>);
    }
    if (needsInput > 0) out.push(<p key="input" className="muted">{t(needsInput === 1 ? 'match.needsInput.one' : 'match.needsInput.other', { n: needsInput })}</p>);
    return out;
  };

  const question =
    offers.length === 1 ? (
      <>
        <p data-testid="format-match-question" data-kind={offer.kind}>
          <Marked id="match.update" nodes={{ format: name(offer.formatName) }} />
        </p>
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
                <input id={id} className="choice__input" type="radio" name={groupId} checked={i === selected} onChange={() => setSelected(i)} />
                <label htmlFor={id}>
                  <bdi>{o.formatName}</bdi>
                </label>
              </div>
            );
          })}
        </fieldset>
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
        <Button variant="primary" disabled={waitingForKeep} onClick={() => answer({ kind: 'update', offer })} data-answer="update">
          {t('match.do.update', { format: offer.formatName })}
        </Button>
        <Button variant="secondary" disabled={waitingForKeep} onClick={() => answer({ kind: 'new' })} data-answer="new">
          {t('match.do.new')}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-answer="cancel">
          {t('copiedList.cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
