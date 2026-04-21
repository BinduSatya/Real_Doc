/**
 * CollabEditor
 * ------------
 * TipTap rich-text editor wired to a Yjs Y.Doc via the Collaboration
 * and CollaborationCursor extensions.
 *
 * Props:
 *   ydoc       — Y.Doc instance from useCollaboration()
 *   provider   — WebsocketProvider instance (for cursor awareness)
 *   localUser  — { name, color }
 */
import { useEditor, EditorContent } from '@tiptap/react';
import Document    from '@tiptap/extension-document';
import Paragraph   from '@tiptap/extension-paragraph';
import Text        from '@tiptap/extension-text';
import Heading     from '@tiptap/extension-heading';
import Bold        from '@tiptap/extension-bold';
import Italic      from '@tiptap/extension-italic';
import Underline   from '@tiptap/extension-underline';
import Code        from '@tiptap/extension-code';
import CodeBlock   from '@tiptap/extension-code-block';
import BulletList  from '@tiptap/extension-bullet-list';
import OrderedList from '@tiptap/extension-ordered-list';
import ListItem    from '@tiptap/extension-list-item';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration       from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';

import Toolbar      from './Toolbar';
import UserPresence from './UserPresence';

export default function CollabEditor({
  ydoc,
  provider,
  localUser,
  awarenessUsers,
  status,
}) {
  const editor = useEditor(
    {
      extensions: [
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
        Placeholder.configure({
          placeholder: 'Start writing… everyone can see your changes in real time.',
        }),

        // ── CRDT collaboration ────────────────────────────────────────────
        // Binds TipTap's internal ProseMirror doc to the Yjs Y.XmlFragment
        Collaboration.configure({ document: ydoc }),

        // ── Live cursors ──────────────────────────────────────────────────
        // Renders other users' cursors with their name + color
        ...(provider
          ? [CollaborationCursor.configure({
              provider,
              user: { name: localUser.name, color: localUser.color },
            })]
          : []),
      ],

      editorProps: {
        attributes: {
          class:       'editor-content',
          spellcheck:  'true',
        },
      },
    },
    // Re-create editor when ydoc/provider change (new document opened)
    [ydoc, provider]
  );

  return (
    <div className="editor-shell">
      <div className="editor-header">
        <Toolbar editor={editor} />
        <UserPresence
          localUser={localUser}
          awarenessUsers={awarenessUsers}
          status={status}
        />
      </div>
      <div className="editor-body">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
