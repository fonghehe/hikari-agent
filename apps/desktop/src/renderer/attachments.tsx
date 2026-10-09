import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import {
  attachmentLimits,
  type Attachment,
  type AttachmentBatch,
  type AttachmentContent,
} from '@hikari/shared';
import { api } from './store';
import { useI18n } from './i18n';

interface Draft {
  prompt: string;
  attachments: Attachment[];
  errors: string[];
}
const empty: Draft = { prompt: '', attachments: [], errors: [] };
export function useComposerDraft(key: string) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const epochs = useRef<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const { t } = useI18n();
  const update = (fn: (draft: Draft) => Draft, target = key) =>
    setDrafts((all) => ({ ...all, [target]: fn(all[target] ?? empty) }));
  const clear = (target = key) => {
    epochs.current[target] = (epochs.current[target] ?? 0) + 1;
    setDrafts((all) => {
      const next = { ...all };
      delete next[target];
      return next;
    });
  };
  const importResult = async (action: () => Promise<AttachmentBatch>) => {
    if (importing) return;
    const target = key;
    const epoch = epochs.current[target] ?? 0;
    setImporting(true);
    update((draft) => ({ ...draft, errors: [] }));
    try {
      const batch = await action();
      if ((epochs.current[target] ?? 0) !== epoch) return;
      update((draft) => {
        const attachments = [...draft.attachments];
        const errors = batch.errors.map((error) => `${error.name}: ${error.message}`);
        for (const item of batch.items) {
          if (attachments.length >= attachmentLimits.maxFiles)
            errors.push(t('Attach up to 6 files. Remove one to add another.'));
          else if (
            item.kind === 'image' &&
            attachments.filter((file) => file.kind === 'image').length >= attachmentLimits.maxImages
          )
            errors.push(t('Attach up to 3 images per question.'));
          else if (
            attachments.reduce((total, file) => total + file.size, item.size) >
            attachmentLimits.maxTotalBytes
          )
            errors.push(t('Total attachment size exceeds 20 MB.'));
          else attachments.push(item);
        }
        return { ...draft, attachments, errors: [...new Set(errors)] };
      }, target);
    } catch (error) {
      if ((epochs.current[target] ?? 0) === epoch)
        update((draft) => ({ ...draft, errors: [String(error)] }), target);
    } finally {
      setImporting(false);
    }
  };
  const importFiles = (files: File[]) =>
    importResult(async () => {
      const errors: AttachmentBatch['errors'] = [];
      const uploads = [];
      for (const file of files.slice(0, attachmentLimits.maxFiles)) {
        try {
          if (file.size > attachmentLimits.maxFileBytes || file.size === 0)
            throw new Error(t('Each file must be non-empty and at most 10 MB.'));
          uploads.push({
            name: file.name || 'pasted-image.png',
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
        } catch (error) {
          errors.push({ name: file.name, message: String(error) });
        }
      }
      if (files.length > attachmentLimits.maxFiles)
        errors.push({
          name: t('Attachments'),
          message: t('Attach up to 6 files. Remove one to add another.'),
        });
      const batch = uploads.length
        ? await api().attachments.import(uploads)
        : { items: [], errors: [] };
      return { items: batch.items, errors: [...errors, ...batch.errors] };
    });
  const draft = drafts[key] ?? empty;
  return {
    ...draft,
    importing,
    clear,
    setPrompt: (prompt: string) => update((draft) => ({ ...draft, prompt })),
    remove: (id: string) =>
      update((draft) => ({
        ...draft,
        attachments: draft.attachments.filter((file) => file.id !== id),
      })),
    pick: () => importResult(() => api().attachments.pick()),
    importFiles,
  };
}

export function AttachButton({ busy, pick }: { busy: boolean; pick(): void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="attach-button"
      aria-label={t('Attach files or images')}
      title={t('Attach files or images')}
      disabled={busy}
      onClick={pick}
    >
      <Paperclip size={18} />
    </button>
  );
}
export function AttachmentList({
  files,
  remove,
}: {
  files: Attachment[];
  remove?(id: string): void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Attachment>();
  const [chunkIndex, setChunkIndex] = useState(0);
  const [content, setContent] = useState<AttachmentContent>();
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [selected?.id]);
  const close = () => {
    sequence.current++;
    setSelected(undefined);
    setContent(undefined);
    setError('');
  };
  const preview = async (file: Attachment) => {
    const request = ++sequence.current;
    setSelected(file);
    setContent(undefined);
    setError('');
    try {
      const value = await api().attachments.read(file.id);
      if (sequence.current === request) {
        setContent(value);
        setChunkIndex(0);
      }
    } catch (error) {
      if (sequence.current === request) setError(String(error));
    }
  };
  return (
    <>
      {files.length > 0 && (
        <div className="attachment-list" aria-label={t('Attachments')}>
          {files.map((file) => (
            <div className="attachment-chip" key={file.id}>
              <button
                type="button"
                className="attachment-preview"
                onClick={() => void preview(file)}
                aria-label={t('Preview {name}', { name: file.name })}
              >
                {file.preview ? (
                  <img src={file.preview} alt="" />
                ) : file.kind === 'image' ? (
                  <ImageIcon size={20} />
                ) : (
                  <FileText size={20} />
                )}
                <span>
                  <strong>{file.name}</strong>
                  <small>
                    {file.kind === 'image'
                      ? `${file.width} × ${file.height}`
                      : `${file.textLength?.toLocaleString() ?? 0} ${t('characters')}`}
                    {file.truncated ? ` · ${t('Truncated')}` : ''}
                  </small>
                </span>
              </button>
              {remove && (
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={t('Remove {name}', { name: file.name })}
                  onClick={() => remove(file.id)}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <div
          className="modal-backdrop"
          onClick={close}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
            if (event.key === 'Tab') {
              const focusable = Array.from(
                dialog.current?.querySelectorAll<HTMLElement>(
                  'button,select,input,textarea,a[href]',
                ) ?? [],
              ).filter((element) => !element.hasAttribute('disabled'));
              const first = focusable[0],
                last = focusable.at(-1);
              if (
                event.shiftKey &&
                (document.activeElement === first || document.activeElement === dialog.current)
              ) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t('Preview {name}', { name: selected.name })}
            className="modal attachment-modal"
            tabIndex={-1}
            ref={dialog}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="task-heading">
              <h2>{selected.name}</h2>
              <button type="button" aria-label={t('Close preview')} onClick={close}>
                <X size={18} />
              </button>
            </div>
            {error ? (
              <p role="alert">{error}</p>
            ) : !content ? (
              <p role="status">{t('Loading…')}</p>
            ) : content.image ? (
              <img
                className="attachment-full-image"
                src={`data:${content.image.mimeType};base64,${content.image.data}`}
                alt={selected.name}
              />
            ) : (
              <pre className="attachment-text">{content.text}</pre>
            )}
            {content?.chunks?.length ? (
              <div className="document-chunks">
                <label>
                  {t('Document section')}
                  <select
                    aria-label={t('Document section')}
                    value={chunkIndex}
                    onChange={(event) => setChunkIndex(Number(event.target.value))}
                  >
                    {content.chunks.map((chunk) => (
                      <option key={chunk.index} value={chunk.index}>
                        {chunk.label}
                      </option>
                    ))}
                  </select>
                </label>
                <pre className="attachment-text">{content.chunks[chunkIndex]?.text}</pre>
                {content.ocr && (
                  <p className="muted">{t('Local OCR text may contain recognition errors.')}</p>
                )}
              </div>
            ) : null}
            {selected.truncated && (
              <p className="muted">
                {t(
                  'The initial preview is shortened. The agent can search and read the full saved document.',
                )}
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
