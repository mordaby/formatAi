// A drop zone for many files (SPEC 5 D). The single-file DropZone takes one file; this one takes a handful at once, from a
// drop or from the file picker, and hands them all to `onFiles` (the flow decides what fits the plan).
import { useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ACCEPTED_EXTENSIONS, Icon } from '../../ui';
import { useI18n } from '../../i18n';

export interface BatchDropZoneProps {
  files: number;
  limit: number;
  disabled?: boolean;
  onFiles(files: File[]): void;
}

function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !types || Array.from(types).includes('Files');
}

export function BatchDropZone({ files, limit, disabled, onFiles }: BatchDropZoneProps) {
  const { t } = useI18n();
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  function take(list: FileList | null | undefined): void {
    if (disabled || !list || list.length === 0) return;
    onFiles(Array.from(list));
  }
  function onChange(e: ChangeEvent<HTMLInputElement>): void {
    take(e.target.files);
    e.target.value = '';
  }
  function onDragEnter(e: DragEvent): void {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(): void {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }
  function onDrop(e: DragEvent): void {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    take(e.dataTransfer?.files);
  }

  return (
    <div className="dz dz--batch" data-dragging={dragging || undefined} data-filled={files > 0 ? 'true' : undefined} data-disabled={disabled || undefined}>
      <label className="dz__target" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <input
          className="dz__input"
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(',')}
          disabled={disabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-caption`}
          data-testid="batch-input"
          onChange={onChange}
        />
        <span className="dz__icon">
          <Icon name="upload" />
        </span>
        <span className="dz__label" id={`${id}-label`}>
          {t('batch.drop.label')}
        </span>
        <span className="dz__caption" id={`${id}-caption`}>
          {t('batch.drop.caption', { n: limit })}
        </span>
        <span className="dz__hint">
          {dragging ? (
            t('batch.drop.release')
          ) : (
            <>
              {t('batch.drop.text')} <u>{t('batch.drop.browse')}</u>
            </>
          )}
        </span>
        <span className="dz__hint" dir="ltr">
          {ACCEPTED_EXTENSIONS.join('  ')}
        </span>
      </label>
    </div>
  );
}
