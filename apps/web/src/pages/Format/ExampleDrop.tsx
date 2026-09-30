// An optional example pair for a saved source (SPEC 8.11, 8.12): example files are never stored, so a source opened for editing has
// nothing to compare with. Dropping the two files again reads them in the worker (nothing is sent) and turns the live check on.
import type { Format } from '@formatai/shared';
import { useState } from 'react';
import { useFileInfo } from '../../app/useFileInfo';
import { webConfig } from '../../config';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, DropZone, Icon, InlineMessage } from '../../ui';

export interface ExampleDropProps {
  /** The format the output must match (turns on the format's own file settings when the example is read). */
  target?: Format | undefined;
  /** The example is in the worker's memory: its id, and the input file (for the flagged rows a real run would give). */
  onLoaded(loaded: { exampleId: string; input: File }): void;
}

export function ExampleDrop({ target, onLoaded }: ExampleDropProps) {
  const { t } = useI18n();
  const { engine } = useServices();
  const [input, setInput] = useState<File | null>(null);
  const [output, setOutput] = useState<File | null>(null);
  const [state, setState] = useState<'idle' | 'reading' | 'failed'>('idle');
  const inputInfo = useFileInfo(input, 'input');
  const outputInfo = useFileInfo(output, 'output');

  const ready = input !== null && output !== null && inputInfo?.status !== 'unreadable' && outputInfo?.status !== 'unreadable';

  const check = async (): Promise<void> => {
    if (!input || !output) return;
    setState('reading');
    try {
      const res = await engine.loadExample({
        input: { name: input.name, bytes: await input.arrayBuffer() },
        output: { name: output.name, bytes: await output.arrayBuffer() },
        ...(target ? { target } : {}),
      });
      if (res.ok) onLoaded({ exampleId: res.exampleId, input });
      else setState('failed');
    } catch {
      setState('failed');
    }
  };

  return (
    <section className="example-drop" aria-labelledby="example-drop-title" data-testid="example-drop">
      <h2 id="example-drop-title">
        <Icon name="info" size={18} /> {t('edit.noExample.title')}
      </h2>
      <p className="muted">{t('edit.noExample.text')}</p>
      <div className="zones">
        <DropZone
          label={t('home.input.title')}
          caption={t('home.input.caption')}
          file={input}
          info={inputInfo}
          onFile={setInput}
          onClear={() => setInput(null)}
          maxBytes={webConfig.maxFileBytes}
          disabled={state === 'reading'}
        />
        <span className="zones__arrow" aria-hidden="true">
          <Icon name="arrow" size={22} />
        </span>
        <DropZone
          label={t('home.output.title')}
          caption={t('home.output.caption')}
          file={output}
          info={outputInfo}
          onFile={setOutput}
          onClear={() => setOutput(null)}
          maxBytes={webConfig.maxFileBytes}
          disabled={state === 'reading'}
        />
      </div>
      {state === 'failed' ? <InlineMessage tone="block">{t('edit.checkFailed')}</InlineMessage> : null}
      <div>
        <Button variant="secondary" disabled={!ready} loading={state === 'reading'} onClick={() => void check()}>
          {state === 'reading' ? t('edit.checking') : t('edit.check')}
        </Button>
      </div>
    </section>
  );
}
