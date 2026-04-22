import { useEffect, useMemo, useState } from 'react';
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { useEditor, EditorContent } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import BulletList from '@tiptap/extension-bullet-list';
import OrderedList from '@tiptap/extension-ordered-list';
import ListItem from '@tiptap/extension-list-item';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';

import Toolbar from './Toolbar';
import UserPresence from './UserPresence';

const TextAlign = Extension.create({
  name: 'textAlign',

  addGlobalAttributes() {
    return [
      {
        types: ['heading', 'paragraph'],
        attributes: {
          textAlign: {
            default: 'left',
            parseHTML: (element) => element.style.textAlign || 'left',
            renderHTML: (attributes) => {
              if (!attributes.textAlign || attributes.textAlign === 'left') return {};
              return { style: `text-align: ${attributes.textAlign}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTextAlign: (alignment) => ({ commands }) => (
        commands.updateAttributes('paragraph', { textAlign: alignment }) ||
        commands.updateAttributes('heading', { textAlign: alignment })
      ),
    };
  },
});

const TextStyle = Mark.create({
  name: 'textStyle',

  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (element) => element.style.fontFamily?.replaceAll('"', '') || null,
      },
      fontSize: {
        default: null,
        parseHTML: (element) => element.style.fontSize || null,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[style]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const styles = [];
    if (HTMLAttributes.fontFamily) styles.push(`font-family: ${HTMLAttributes.fontFamily}`);
    if (HTMLAttributes.fontSize) styles.push(`font-size: ${HTMLAttributes.fontSize}`);

    const { fontFamily, fontSize, style, ...rest } = HTMLAttributes;
    return ['span', mergeAttributes(rest, {
      style: [style, styles.join('; ')].filter(Boolean).join('; '),
    }), 0];
  },
});

function marksToMd(text, marks = []) {
  return marks.reduce((value, mark) => {
    if (mark.type === 'bold') return `**${value}**`;
    if (mark.type === 'italic') return `_${value}_`;
    if (mark.type === 'code') return `\`${value}\``;
    return value;
  }, text);
}

function nodeToMd(node, index = 0) {
  if (node.type === 'text') return marksToMd(node.text || '', node.marks);
  const children = (node.content || []).map((child, childIndex) => nodeToMd(child, childIndex)).join('');
  if (node.type === 'heading') return `${'#'.repeat(node.attrs?.level || 1)} ${children}\n\n`;
  if (node.type === 'paragraph') return `${children}\n\n`;
  if (node.type === 'bulletList' || node.type === 'orderedList') return `${(node.content || []).map(nodeToMd).join('')}\n`;
  if (node.type === 'listItem') return `- ${children.trim()}\n`;
  if (node.type === 'codeBlock') return `\`\`\`\n${children}\n\`\`\`\n\n`;
  return children || (index ? '' : '\n');
}

function downloadMarkdown(editor) {
  const markdown = nodeToMd(editor.getJSON()).trim() + '\n';
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'document.md';
  link.click();
  URL.revokeObjectURL(url);
}

export { downloadMarkdown };

export default function CollabEditor({
  ydoc,
  provider,
  localUser,
  awarenessUsers,
  status,
  role,
  onAddComment,
  exportAction,
}) {
  const canEdit = role === 'owner' || role === 'editor';
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [commentDraft, setCommentDraft] = useState('');
  const [selectionMenu, setSelectionMenu] = useState(null);
  const [pageCount, setPageCount] = useState(1);

  const extensions = useMemo(() => [
    Document,
    Paragraph,
    Text,
    Heading.configure({ levels: [1, 2, 3] }),
    Bold,
    Italic,
    Underline,
    Code,
    CodeBlock,
    BulletList,
    OrderedList,
    ListItem,
    TextAlign,
    TextStyle,
    Placeholder.configure({
      placeholder: canEdit ? 'Start writing...' : 'You have read-only access.',
    }),
    Collaboration.configure({ document: ydoc }),
    ...(provider
      ? [CollaborationCursor.configure({
          provider,
          user: { id: localUser.id, name: localUser.name, color: localUser.color },
        })]
      : []),
  ], [ydoc, provider, localUser.id, localUser.name, localUser.color, canEdit]);

  const editor = useEditor(
    {
      editable: canEdit,
      extensions,
      editorProps: {
        attributes: {
          class: 'editor-content',
          spellcheck: 'true',
        },
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        const { from, to, empty } = currentEditor.state.selection;
        if (empty) {
          setSelectionMenu(null);
          return;
        }
        const selectedText = currentEditor.state.doc.textBetween(from, to, ' ').trim();
        if (!selectedText) {
          setSelectionMenu(null);
          return;
        }
        const start = currentEditor.view.coordsAtPos(from);
        const end = currentEditor.view.coordsAtPos(to);
        setSelectionMenu({
          anchorFrom: from,
          anchorTo: to,
          selectedText,
          top: Math.min(start.top, end.top) - 6,
          left: (start.left + end.right) / 2,
          mode: 'menu',
        });
      },
    },
    [ydoc, provider, canEdit]
  );

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  useEffect(() => {
    if (!editor) return undefined;

    let frame = null;
    const updatePages = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = editor.view.dom;
        const contentBottom = [...root.children].reduce(
          (bottom, child) => Math.max(bottom, child.offsetTop + child.offsetHeight),
          0
        );
        setPageCount(Math.max(1, Math.ceil((contentBottom + 72) / 1123)));
      });
    };

    const observer = globalThis.ResizeObserver ? new ResizeObserver(updatePages) : null;
    observer?.observe(editor.view.dom);
    editor.on('update', updatePages);
    editor.on('selectionUpdate', updatePages);
    updatePages();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      editor.off('update', updatePages);
      editor.off('selectionUpdate', updatePages);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || !query.trim()) {
      setMatchCount(0);
      return;
    }
    const text = editor.getText().toLowerCase();
    const needle = query.trim().toLowerCase();
    let count = 0;
    let index = text.indexOf(needle);
    while (index >= 0) {
      count += 1;
      index = text.indexOf(needle, index + needle.length);
    }
    setMatchCount(count);
  }, [editor, query]);

  useEffect(() => {
    if (!editor || !exportAction) return;
    if (exportAction.type === 'markdown') downloadMarkdown(editor);
    if (exportAction.type === 'pdf') window.print();
  }, [editor, exportAction]);

  const submitComment = async (event) => {
    event.preventDefault();
    if (!selectionMenu || !commentDraft.trim()) return;
    await onAddComment({ ...selectionMenu, body: commentDraft.trim() });
    setCommentDraft('');
    setSelectionMenu(null);
    editor?.commands.focus();
  };

  const openCommentComposer = () => {
    setSelectionMenu((current) => current ? { ...current, mode: 'comment' } : current);
  };

  const findNext = () => {
    if (!query.trim()) return;
    window.getSelection()?.removeAllRanges();
    window.find(query);
  };

  return (
    <div className="editor-shell">
      <div className="editor-header">
        <Toolbar editor={editor} disabled={!canEdit} />
        <div className="editor-tools">
          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && findNext()}
            placeholder="Search"
          />
          <span className="search-count">{query ? matchCount : 0}</span>
          <button className="toolbar-btn" onClick={findNext} type="button">Find</button>
        </div>
        <UserPresence localUser={localUser} awarenessUsers={awarenessUsers} status={status} />
      </div>

      {selectionMenu && (
        <form
          className={`selection-popover selection-popover--${selectionMenu.mode}`}
          style={{ top: selectionMenu.top, left: selectionMenu.left }}
          onSubmit={submitComment}
        >
          {selectionMenu.mode === 'menu' ? (
            <button
              className="selection-popover__comment"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={openCommentComposer}
            >
              Comment
            </button>
          ) : (
            <>
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment"
                autoFocus
              />
              <div className="selection-popover__actions">
                <button type="button" onClick={() => setSelectionMenu(null)}>Cancel</button>
                <button type="submit" disabled={!commentDraft.trim()}>Save</button>
              </div>
            </>
          )}
        </form>
      )}

      <div className="editor-body">
        <div
          className="page-stack"
          style={{
            '--page-count': pageCount,
            '--page-stack-height': `${pageCount * 1123}px`,
          }}
        >
          <div className="page-backdrop" aria-hidden="true">
            {Array.from({ length: pageCount }, (_, index) => (
              <div className="page-sheet" key={index}>
                <span className="page-label">Page {index + 1}</span>
              </div>
            ))}
          </div>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
