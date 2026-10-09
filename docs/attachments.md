# Ask with files and images

## Add an attachment

Click the paperclip **Attach files or images** beside the input, drop files onto the input area, or paste a screenshot from your clipboard. You can combine documents and images in one question.

1. Add the files and wait for **Preparing attachments…** to finish.
2. Click an attachment to preview the exact extracted text or processed image. Remove an unwanted attachment with its **×** button.
3. Ask a specific question, such as “Compare these requirements” or “Explain the error in this screenshot.”
4. Send with **Enter** or the arrow. Sending attachments without a question asks Hikari to summarize them.

You can ask about attachments without opening a workspace. Connect a model for real analysis. To let the agent inspect or change a local project, open its workspace and start a new task.

## Supported files and limits

| Type                                                  | What Hikari sends                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| UTF-8 text, Markdown, CSV, JSON and common code files | Readable text from the file.                                                        |
| PDF                                                   | Text from up to 100 pages; local OCR for up to 20 scanned pages.                    |
| DOCX                                                  | Extracted document text. Formatting, embedded images and comments are not included. |
| PNG, JPEG, WebP and GIF                               | Image within 1600 × 1600 pixels plus local OCR text. GIF uses the first frame.      |

Attach up to **6 files**, including at most **3 images**, per question. Each original file must be non-empty and at most **10 MB**; the combined original size must be at most **20 MB**. The initial model preview is at most **12,000 characters per document** and **24,000 characters per question**, shared between documents. Full extracted text up to **512,000 characters per file** stays available through attachment search and sequential reading. A **Truncated** badge applies to the preview, not the saved searchable document. Ask the agent to search the full document and cite its page or paragraph label. OCR runs locally with bundled English, Chinese and Japanese recognition data; unclear scans may contain recognition errors.

Unsupported, unreadable or oversized files show an error. Valid files in the same batch remain attached. Spreadsheets, archives, old `.doc` files and password-protected documents are not supported; export relevant content to CSV, UTF-8 text, PDF or screenshots.

## Images and offline demo

For visual questions, select a model that supports image input and enable **This model accepts images** in [Model settings](configuration.md). The switch does not add vision capability to a text-only model. A text-only model can answer from local OCR when readable text was recognized; it cannot see layout or visual details. Images with no recognized text still require a vision model. Images already in recent conversation context also require a vision model.

Offline demo needs no key or network. It displays excerpts of your documents and acknowledges image names and dimensions. It does **not** interpret image contents or provide real model analysis. A failed real-model request is shown as an error, never replaced with a demo answer.

## Continue and review

Sent attachments remain in local task history and can be previewed after restart. **Retry** includes the original attachments; a follow-up can reference attachments from recent turns. For long conversations, attach important sources again in the new question. Switching between conversations preserves their unsent drafts during the current session; **New task** starts an empty draft. Unsent attachments are temporary and may expire after an hour or under cache pressure. Unsent drafts do not survive restart.

Answers support headings, lists, code blocks and tables. Use **Copy code** for a code block or **Copy response** for the whole answer. External links open in your default browser. Remote images in answers are shown as links and are not loaded automatically.

## Where your content goes

Attachment text and processed images are stored locally after sending. A connected model receives the content for your question and may receive recent attachments when you follow up; only attach material you want to share with that provider. Offline demo stays on your device.

Optional task sync excludes full attachment content and image previews. Task prompts, filenames and model answers may still quote sensitive attachment content, so review the task before uploading it. Downloaded snapshots do not restore attachment files on another device.
