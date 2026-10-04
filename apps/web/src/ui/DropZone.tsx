import { useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Cell } from '../components/Cell';
import { useI18n, type MessageKey } from '../i18n';
import { Button } from './Button';
import { Icon } from './Icon';
import { Spinner } from './Spinner';

/** SPEC 6.1: the file types we read. */
export const ACCEPTED_EXTENSIONS: readonly string[] = ['.xlsx', '.xls', '.csv', '.txt'];

export function isAcceptedFile(fileName: string, accept: readonly string[] = ACCEPTED_EXTENSIONS): boolean {
  const name = fileName.toLowerCase();
  return accept.some((ext) => name.endsWith(ext));
}

/** What the engine worker reported about the dropped file. `null` counts = no table found (the pre-flight explains when the user goes on). */
export type DropZoneInfo = { status: 'reading' } | { status: 'ready'; rows: number | null; columns: number | null } | { status: 'unreadable' };

export type DropRejection = { kind: 'type'; file: File } | { kind: 'size'; file: File; maxBytes: number };

export interface DropZoneProps {
  /** "Example input" / "Example output". */
  label: string;
  /** One short line under the label. */
  caption?: string;
  file: File | null;
  /** Rows and columns once the worker has read the file; while it is `reading` a small spinner shows. */
  info?: DropZoneInfo | undefined;
  onFile(file: File): void;
  /**
   * Turns the zone into one that takes several files (the browse dialog allows it too): one file still goes to `onFile`, with the
   * checks below; two or more go to `onFiles` as they are, and the caller turns away what it cannot use. Leave it out for one file only.
   */
  onFiles?(files: File[]): void;
  onClear?(): void;
  onReject?(rejection: DropRejection): void;
  accept?: readonly string[];
  /** Bigger files are turned away at the door, with the reason. */
  maxBytes?: number | undefined;
  /** Greyed out and ignoring drops, e.g. while a learn is starting. */
  disabled?: boolean | undefined;
}

function plural(base: 'file.rows' | 'file.columns', n: number): MessageKey {
  return `${base}.${n === 1 ? 'one' : 'other'}` as MessageKey;
}

function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !types || Array.from(types).includes('Files');
}

/**
 * One drop zone: drag a file over it (it reacts), drop it (the file settles in with its name, then
 * its row and column count once the worker reports them), or click / press Enter or Space to
 * browse. Only the accepted types get in; a refused file is explained right here.
 */
export function DropZone({ label, caption, file, info, onFile, onFiles, onClear, onReject, accept = ACCEPTED_EXTENSIONS, maxBytes, disabled }: DropZoneProps) {
  const { t, lang } = useI18n();
  const id = useId();
  const labelId = `${id}-label`;
  const captionId = `${id}-caption`;
  const errorId = `${id}-error`;
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<DropRejection | null>(null);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  function take(files: FileList | File[] | null | undefined): void {
    if (disabled) return;
    const first = files && files.length > 0 ? files[0] : undefined;
    if (!first) return;
    if (onFiles && files && files.length > 1) {
      setRejected(null);
      onFiles(Array.from(files));
      return;
    }
    if (!isAcceptedFile(first.name, accept)) {
      const r: DropRejection = { kind: 'type', file: first };
      setRejected(r);
      onReject?.(r);
      return;
    }
    if (maxBytes !== undefined && first.size > maxBytes) {
      const r: DropRejection = { kind: 'size', file: first, maxBytes };
      setRejected(r);
      onReject?.(r);
      return;
    }
    setRejected(null);
    onFile(first);
  }

  function onChange(e: ChangeEvent<HTMLInputElement>): void {
    take(e.target.files);
    // Lets the same file be chosen again after it was removed.
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

  const nf = new Intl.NumberFormat(lang);
  const unreadable = info?.status === 'unreadable';
  const errorText = rejected
    ? rejected.kind === 'type'
      ? t('error.unsupportedFileType')
      : t('error.fileTooLarge', { mb: (rejected.file.size / (1024 * 1024)).toFixed(1), maxMb: Math.round(rejected.maxBytes / (1024 * 1024)) })
    : unreadable
      ? t('error.cannotRead')
      : null;

  return (
    <div className="dz" data-dragging={dragging || undefined} data-filled={file ? 'true' : undefined} data-invalid={errorText ? 'true' : undefined} data-disabled={disabled || undefined}>
      <label className="dz__target" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <input
          ref={input}
          className="dz__input"
          type="file"
          accept={accept.join(',')}
          multiple={onFiles !== undefined}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={errorText ? `${captionId} ${errorId}` : captionId}
          onChange={onChange}
        />
        {file ? (
          // Keyed on the file, so each newly dropped file plays the settle-in again.
          <span className="dz__file" key={`${file.name}:${file.size}:${file.lastModified}`}>
            <span className="dz__icon">
              <Icon name="file" />
            </span>
            <span className="dz__label" id={labelId}>
              {label}
            </span>
            <span className="dz__name">
              <Cell value={file.name} />
            </span>
            <span className="dz__meta" aria-live="polite">
              {info?.status === 'reading' || !info ? (
                <>
                  <Spinner size={14} />
                  {t('dropzone.reading')}
                </>
              ) : info.status === 'ready' && info.rows !== null && info.columns !== null ? (
                <>
                  <span className="dz__meta-item">{t(plural('file.rows', info.rows), { rows: nf.format(info.rows) })}</span>
                  <span className="dz__dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="dz__meta-item">{t(plural('file.columns', info.columns), { columns: nf.format(info.columns) })}</span>
                </>
              ) : info.status === 'ready' ? (
                <span className="dz__meta-item">{t('file.size', { kb: nf.format(Math.max(1, Math.round(file.size / 1024))) })}</span>
              ) : null}
            </span>
            <span className="dz__hint" id={captionId}>
              {t('dropzone.replace')}
            </span>
          </span>
        ) : (
          <>
            <span className="dz__icon">
              <Icon name="upload" />
            </span>
            <span className="dz__label" id={labelId}>
              {label}
            </span>
            {caption ? (
              <span className="dz__caption" id={captionId}>
                {caption}
              </span>
            ) : (
              <span id={captionId} hidden />
            )}
            <span className="dz__hint">
              {dragging ? (
                t(onFiles ? 'dropzone.releaseMany' : 'dropzone.release')
              ) : (
                <>
                  {t(onFiles ? 'dropzone.dropMany' : 'dropzone.drop')} <u>{t('dropzone.browse')}</u>
                </>
              )}
            </span>
            <span className="dz__hint" dir="ltr">
              {accept.join('  ')}
            </span>
          </>
        )}
      </label>
      {file && onClear ? (
        <Button
          className="dz__clear"
          variant="ghost"
          size="sm"
          icon="close"
          aria-label={t('dropzone.remove', { label })}
          onClick={() => {
            setRejected(null);
            onClear();
          }}
        />
      ) : null}
      {errorText ? (
        <p className="dz__error" role="alert" id={errorId}>
          <Icon name="alert" size={16} />
          <span>{errorText}</span>
        </p>
      ) : null}
    </div>
  );
}
