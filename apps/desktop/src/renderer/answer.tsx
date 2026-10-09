import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { api, perform } from './store';
import { useI18n } from './i18n';
function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : String(child),
    )
    .join('');
}
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timeout.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={copied ? t('Copied') : label}
      onClick={() =>
        void perform(async () => {
          await api().clipboard.write(text);
          setCopied(true);
          clearTimeout(timeout.current);
          timeout.current = setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? t('Copied') : label}
    </button>
  );
}
export function Answer({ text, copy = true }: { text: string; copy?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="answer markdown-answer">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void perform(() => api().external.open(href));
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a
              href={src}
              onClick={(event) => {
                event.preventDefault();
                if (src) void perform(() => api().external.open(src));
              }}
            >
              {alt || t('Open image link')}
            </a>
          ),
          pre: ({ children }) => (
            <div className="code-block">
              <CopyButton text={plainText(children)} label={t('Copy code')} />
              <pre>{children}</pre>
            </div>
          ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {copy && <CopyButton text={text} label={t('Copy response')} />}
    </div>
  );
}
