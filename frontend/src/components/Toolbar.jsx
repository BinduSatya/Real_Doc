import React from 'react';

const ToolbarButton = ({ onClick, active, disabled, title, children }) => (
  <button
    onMouseDown={(e) => { e.preventDefault(); onClick(); }}
    disabled={disabled}
    title={title}
    className={`toolbar-btn${active ? ' active' : ''}`}
  >
    {children}
  </button>
);

const Divider = () => <span className="toolbar-divider" />;

export default function Toolbar({ editor }) {
  if (!editor) return null;

  return (
    <div className="toolbar">
      {/* Headings */}
      <ToolbarButton
        title="Heading 1"
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >H1</ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >H2</ToolbarButton>
      <ToolbarButton
        title="Heading 3"
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >H3</ToolbarButton>

      <Divider />

      {/* Inline formatting */}
      <ToolbarButton
        title="Bold (Ctrl+B)"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      ><strong>B</strong></ToolbarButton>
      <ToolbarButton
        title="Italic (Ctrl+I)"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      ><em>I</em></ToolbarButton>
      <ToolbarButton
        title="Underline (Ctrl+U)"
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      ><span style={{ textDecoration: 'underline' }}>U</span></ToolbarButton>
      <ToolbarButton
        title="Inline Code"
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >{"<>"}</ToolbarButton>

      <Divider />

      {/* Lists */}
      <ToolbarButton
        title="Bullet List"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >• List</ToolbarButton>
      <ToolbarButton
        title="Ordered List"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >1. List</ToolbarButton>

      <Divider />

      {/* Code block */}
      <ToolbarButton
        title="Code Block"
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >Block</ToolbarButton>
    </div>
  );
}
