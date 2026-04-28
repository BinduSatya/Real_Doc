import React from "react";

const ToolbarButton = ({ onClick, active, disabled, title, children }) => (
  <button
    onMouseDown={(e) => {
      e.preventDefault();
      if (!disabled) onClick();
    }}
    disabled={disabled}
    title={title}
    // className={`toolbar-btn${active ? " active" : ""}`}
    className={`
  px-2 py-1 rounded-md text-sm
  ${active ? "bg-gray-200 font-medium" : "hover:bg-gray-100"}
`}
    type="button"
  >
    {children}
  </button>
);

const Divider = () => <span className="toolbar-divider" />;

// const Divider = () => (
//   <div className="flex flex-wrap w-px h-5 bg-red-400 m-2" />
// );

export default function Toolbar({ editor, disabled = false }) {
  if (!editor) return null;

  const fontOptions = [
    { label: "Sans", value: "var(--font-ui)" },
    { label: "Serif", value: "Georgia, serif" },
    { label: "Mono", value: "var(--font-mono)" },
    { label: "Arial", value: "Arial, sans-serif" },
    { label: "Times", value: '"Times New Roman", serif' },
  ];
  const sizeOptions = [
    "12px",
    "14px",
    "16px",
    "18px",
    "20px",
    "24px",
    "30px",
    "36px",
  ];

  const align = (value) =>
    editor
      .chain()
      .focus()
      .updateAttributes("paragraph", { textAlign: value })
      .updateAttributes("heading", { textAlign: value })
      .run();
  const alignActive = (value) =>
    editor.isActive({ textAlign: value }) ||
    (value === "left" &&
      !editor.isActive({ textAlign: "center" }) &&
      !editor.isActive({ textAlign: "right" }));
  const currentStyle = editor.getAttributes("textStyle");
  const setTextStyle = (attrs) =>
    editor
      .chain()
      .focus()
      .setMark("textStyle", {
        ...currentStyle,
        ...attrs,
      })
      .run();
  const currentFont = currentStyle.fontFamily || "var(--font-ui)";
  const currentSize = currentStyle.fontSize || "18px";

  return (
    // <div className="toolbar">
    <div className="flex items-center gap-2 px-3 py-2 bg-white border-b shadow-sm">
      <select
        className="toolbar-select"
        value={currentFont}
        disabled={disabled}
        onChange={(event) => setTextStyle({ fontFamily: event.target.value })}
        title="Font style"
      >
        {fontOptions.map((font) => (
          <option key={font.value} value={font.value}>
            {font.label}
          </option>
        ))}
      </select>
      <select
        className="toolbar-select toolbar-select--size"
        value={currentSize}
        disabled={disabled}
        onChange={(event) => setTextStyle({ fontSize: event.target.value })}
        title="Font size"
      >
        {sizeOptions.map((size) => (
          <option key={size} value={size}>
            {Number.parseInt(size, 10)}
          </option>
        ))}
      </select>

      <Divider />

      <ToolbarButton
        title="Heading 1"
        disabled={disabled}
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        disabled={disabled}
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        title="Heading 3"
        disabled={disabled}
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        title="Bold"
        disabled={disabled}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        title="Italic"
        disabled={disabled}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        disabled={disabled}
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <span style={{ textDecoration: "underline" }}>U</span>
      </ToolbarButton>
      <ToolbarButton
        title="Inline Code"
        disabled={disabled}
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        {"<>"}
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        title="Align left"
        disabled={disabled}
        active={alignActive("left")}
        onClick={() => align("left")}
      >
        Left
      </ToolbarButton>
      <ToolbarButton
        title="Align center"
        disabled={disabled}
        active={alignActive("center")}
        onClick={() => align("center")}
      >
        Center
      </ToolbarButton>
      <ToolbarButton
        title="Align right"
        disabled={disabled}
        active={alignActive("right")}
        onClick={() => align("right")}
      >
        Right
      </ToolbarButton>

      <Divider />
      <ToolbarButton
        title="Bullet List"
        disabled={disabled}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        List
      </ToolbarButton>
      <ToolbarButton
        title="Ordered List"
        disabled={disabled}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        title="Code Block"
        disabled={disabled}
        active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        Block
      </ToolbarButton>
    </div>
  );
}
