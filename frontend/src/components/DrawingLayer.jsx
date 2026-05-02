import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
} from "react";
import { apiFetch } from "../api";
import { COLOR_PALETTE, TOOL_LABELS } from "../constants/drawingConstants";

const PAGE_WIDTH = 794;
const DEFAULT_FILL = "#dbeafe";
const DEFAULT_STROKE = "#0c1017";
const MIN_SIZE = 36;
const API_URL = import.meta.env.VITE_API_URL;

function createId(prefix) {
  if (globalThis.crypto?.randomUUID)
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeBox(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(MIN_SIZE, Math.abs(end.x - start.x)),
    height: Math.max(MIN_SIZE, Math.abs(end.y - start.y)),
  };
}

function rectsOverlap(a, b, padding = 10) {
  return !(
    a.x + a.width + padding < b.x ||
    b.x + b.width + padding < a.x ||
    a.y + a.height + padding < b.y ||
    b.y + b.height + padding < a.y
  );
}

function shapeBounds(shape) {
  if (!shape) return null;
  if (shape.type === "pen") {
    const xs = shape.points.map((point) => point.x);
    const ys = shape.points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };
  }
  return {
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
  };
}

function shapeCenter(shape) {
  const bounds = shapeBounds(shape);
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function clampShape(shape, width, height) {
  const bounds = shapeBounds(shape);
  const dx =
    Math.min(Math.max(bounds.x, 0), Math.max(0, width - bounds.width)) -
    bounds.x;
  const dy =
    Math.min(Math.max(bounds.y, 0), Math.max(0, height - bounds.height)) -
    bounds.y;
  return moveShape(shape, dx, dy);
}

function avoidTextBlocks(shape, textRects, canvasWidth, canvasHeight) {
  let adjusted = shape;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bounds = shapeBounds(adjusted);
    const hit = textRects.find((rect) => rectsOverlap(bounds, rect));
    if (!hit) return clampShape(adjusted, canvasWidth, canvasHeight);

    const moveRight = hit.x + hit.width + 16 - bounds.x;
    const moveDown = hit.y + hit.height + 16 - bounds.y;
    adjusted = moveShape(
      adjusted,
      moveRight < canvasWidth / 3 ? moveRight : 0,
      moveDown,
    );
  }
  return clampShape(adjusted, canvasWidth, canvasHeight);
}

function moveShape(shape, dx, dy) {
  if (shape.type === "pen") {
    return {
      ...shape,
      points: shape.points.map((point) => ({
        x: point.x + dx,
        y: point.y + dy,
      })),
    };
  }
  return {
    ...shape,
    x: shape.x + dx,
    y: shape.y + dy,
  };
}

function getPointerPosition(event, svg, pageHeight) {
  const rect = svg.getBoundingClientRect();
  const scaleX = PAGE_WIDTH / rect.width;
  const scaleY = pageHeight / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function toPath(points) {
  if (!points.length) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function getShapeEdgePoint(shape, target) {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;

  const dx = target.x - cx;
  const dy = target.y - cy;

  if (Math.abs(dx) > Math.abs(dy)) {
    return {
      x: cx + (dx > 0 ? shape.width / 2 : -shape.width / 2),
      y: cy,
    };
  } else {
    return {
      x: cx,
      y: cy + (dy > 0 ? shape.height / 2 : -shape.height / 2),
    };
  }
}

function connectorPath(connector, fromShape, toShape) {
  const from = getShapeEdgePoint(fromShape, shapeCenter(toShape));
  const to = getShapeEdgePoint(toShape, shapeCenter(fromShape));

  const cx1 = fromShape.x + fromShape.width / 2;
  const cy1 = fromShape.y + fromShape.height / 2;
  const cx2 = toShape.x + toShape.width / 2;
  const cy2 = toShape.y + toShape.height / 2;
  const dx = Math.abs(cx2 - cx1);
  const dy = Math.abs(cy2 - cy1);

  // If shapes are roughly aligned on one axis, use a straight line
  const ALIGN_THRESHOLD = 48;
  if (dx < ALIGN_THRESHOLD || dy < ALIGN_THRESHOLD) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }

  // Otherwise use an elbow (L-shaped) connector
  if (dx >= dy) {
    const midX = from.x + (to.x - from.x) / 2;
    return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
  } else {
    const midY = from.y + (to.y - from.y) / 2;
    return `M ${from.x} ${from.y} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y}`;
  }
}

function trianglePoints(shape) {
  return [
    `${shape.x + shape.width / 2},${shape.y}`,
    `${shape.x + shape.width},${shape.y + shape.height}`,
    `${shape.x},${shape.y + shape.height}`,
  ].join(" ");
}

function AutoFitText({ text, width, height }) {
  const spanRef = useRef(null);
  const [fontSize, setFontSize] = useState(16);

  useEffect(() => {
    let size = 24; // start big
    const minSize = 6;

    const el = spanRef.current;
    if (!el) return;

    el.style.fontSize = size + "px";

    while (
      (el.scrollWidth > width || el.scrollHeight > height) &&
      size > minSize
    ) {
      size -= 1;
      el.style.fontSize = size + "px";
    }

    setFontSize(size);
  }, [text, width, height]);

  return (
    <span
      ref={spanRef}
      className="w-full h-full flex items-center justify-center text-center break-words leading-tight"
      style={{ fontSize }}
    >
      {text}
    </span>
  );
}

const HandIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v0" />
    <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
    <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>
);
const SelectIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    <path d="m13 13 6 6" />
  </svg>
);
const RectIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="3" />
  </svg>
);
const CircleIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="9" />
  </svg>
);
const ArrowIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);
const StrokeOnlyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect
      x="2"
      y="2"
      width="12"
      height="12"
      rx="2"
      stroke="currentColor"
      strokeWidth="2"
      fill="transparent"
    />
  </svg>
);
const FillStrokeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect
      x="2"
      y="2"
      width="12"
      height="12"
      rx="2"
      stroke="currentColor"
      strokeWidth="2"
      fill="#93c5fd"
    />
  </svg>
);
const FillOnlyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#93c5fd" />
  </svg>
);

const TOOLS = [
  { id: "hand", label: "Hand (pan)", Icon: HandIcon },
  { id: "select", label: "Select", Icon: SelectIcon },
  { id: "rect", label: "Rectangle", Icon: RectIcon },
  { id: "circle", label: "Circle", Icon: CircleIcon },
  { id: "arrow", label: "Arrow", Icon: ArrowIcon },
];

export function DrawingToolbar({
  activeTool,
  setActiveTool,
  selectedShape,
  updateSelectedText,
  updateSelectedStroke,
  updateSelectedStrokeWidth,
  updateSelectedFill,
  updateSelectedFillColor,
  disabled,
  selectedStroke,
  selectedFillColor,
}) {
  const showProps = selectedShape && selectedShape.type !== "pen";

  // Derive fill mode from shape state
  const fillMode = (() => {
    if (!showProps) return "fill-stroke";
    const hasFill = selectedShape.fill && selectedShape.fill !== "transparent";
    const hasStroke = selectedShape.strokeWidth !== 0;
    if (hasFill && hasStroke) return "fill-stroke";
    if (hasFill) return "fill-only";
    return "stroke-only";
  })();

  const applyFillMode = (mode) => {
    if (!selectedShape) return;
    if (mode === "stroke-only") {
      updateSelectedFill(false); // fill → transparent
      updateSelectedStrokeWidth(2);
    } else if (mode === "fill-stroke") {
      updateSelectedFill(true);
      updateSelectedStrokeWidth(2);
    } else if (mode === "fill-only") {
      updateSelectedFill(true);
      updateSelectedStrokeWidth(0);
    }
  };

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* ── Tool Buttons ─────────────────────────────── */}
      <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-1">
        {TOOLS.map(({ id, label, Icon }) => (
          <button
            key={id}
            title={label}
            disabled={disabled}
            onClick={() => setActiveTool(id)}
            className={`
              p-1.5 rounded-lg transition-all duration-100
              ${
                activeTool === id
                  ? "bg-white shadow text-violet-700 ring-1 ring-violet-300"
                  : "text-gray-500 hover:bg-white/70 hover:text-gray-800"
              }
              ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
            `}
          >
            <Icon />
          </button>
        ))}
      </div>

      {/* ── Shape Properties (shown only when a shape is selected) ── */}
      {showProps && (
        <>
          <div className="w-px h-6 bg-gray-200 mx-1" />

          {/* Fill mode toggle */}
          <div
            className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-1"
            title="Fill style"
          >
            {[
              {
                mode: "stroke-only",
                title: "Border only",
                Icon: StrokeOnlyIcon,
              },
              {
                mode: "fill-stroke",
                title: "Fill + Border",
                Icon: FillStrokeIcon,
              },
              { mode: "fill-only", title: "Fill only", Icon: FillOnlyIcon },
            ].map(({ mode, title, Icon }) => (
              <button
                key={mode}
                title={title}
                onClick={() => applyFillMode(mode)}
                className={`
                  p-1.5 rounded-lg transition-all duration-100
                  ${
                    fillMode === mode
                      ? "bg-white shadow ring-1 ring-violet-300 text-violet-700"
                      : "text-gray-500 hover:bg-white/70"
                  }
                `}
              >
                <Icon />
              </button>
            ))}
          </div>

          <div className="w-px h-6 bg-gray-200 mx-1" />

          {/* Stroke color */}
          {fillMode !== "fill-only" && (
            <label
              className="flex items-center gap-1 cursor-pointer"
              title="Border color"
            >
              <span className="text-xs text-gray-400 select-none">Border</span>
              <span
                className="w-6 h-6 rounded-full border-2 border-white shadow"
                style={{ background: selectedStroke || DEFAULT_STROKE }}
              >
                <input
                  type="color"
                  value={selectedStroke || DEFAULT_STROKE}
                  onChange={(e) => updateSelectedStroke(e.target.value)}
                  className="opacity-0 w-full h-full cursor-pointer"
                />
              </span>
            </label>
          )}

          {/* Fill color */}
          {fillMode !== "stroke-only" && (
            <label
              className="flex items-center gap-1 cursor-pointer"
              title="Fill color"
            >
              <span className="text-xs text-gray-400 select-none">Fill</span>
              <span
                className="w-6 h-6 rounded-full border-2 border-white shadow"
                style={{ background: selectedFillColor || DEFAULT_FILL }}
              >
                <input
                  type="color"
                  value={selectedFillColor || DEFAULT_FILL}
                  onChange={(e) => updateSelectedFillColor(e.target.value)}
                  className="opacity-0 w-full h-full cursor-pointer"
                />
              </span>
            </label>
          )}

          <div className="w-px h-6 bg-gray-200 mx-1" />

          {/* Text label */}
          <input
            className="border border-gray-200 rounded-lg px-2 py-1 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-violet-300"
            value={selectedShape.text || ""}
            onChange={(e) => updateSelectedText(e.target.value)}
            placeholder="Label…"
            title="Shape text"
          />
        </>
      )}
    </div>
  );
}

// AFTER — always centered inside the shape
function ShapeLabel({ shape }) {
  if (!shape.text) return null;

  const x = shape.x + 4;
  const y = shape.y + 4;
  const width = Math.max(1, shape.width - 8);
  const height = Math.max(1, shape.height - 8);

  return (
    <foreignObject
      x={x}
      y={y}
      width={width}
      height={height}
      className="pointer-events-none"
    >
      <div className="w-full h-full overflow-hidden">
        <AutoFitText text={shape.text} width={width} height={height} />
      </div>
    </foreignObject>
  );
}

function DrawingLayer(
  {
    docId,
    ydoc,
    canEdit,
    pageHeight,
    editor,
    activeTool = "select",
    setActiveTool,
    connectorKind = "line",
    setConnectorKind,
    connectorFilled = true,
    setConnectorFilled,
    lineStyle = "solid",
    setLineStyle,
    onSelectionChange,
  },
  ref,
) {
  // placeholder: useImperativeHandle moved below after selectedShape is declared
  const svgRef = useRef(null);
  const lastClickRef = useRef({ id: null, time: 0 });
  const lastDocClickRef = useRef({ time: 0, x: 0, y: 0 });
  const [elements, setElements] = useState([]);
  const [localActiveTool, setLocalActiveTool] = useState(activeTool);
  const [selectedId, setSelectedId] = useState(null);
  const [connectorStart, setConnectorStart] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [strokeColor, setStrokeColor] = useState(DEFAULT_STROKE);
  const [fillColor, setFillColor] = useState(DEFAULT_FILL);
  const [shapesFilled, setShapesFilled] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [resizeState, setResizeState] = useState(null);
  const [editingTextId, setEditingTextId] = useState(null);
  const [editingTextValue, setEditingTextValue] = useState("");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [fillOpacity, setFillOpacity] = useState(1);
  const [panState, setPanState] = useState(null); // { startX, startY, scrollLeft, scrollTop }

  const drawings = useMemo(() => ydoc?.getMap("drawings"), [ydoc]);
  const shapes = elements.filter((element) => element.kind === "shape");
  const connectors = elements.filter((element) => element.kind === "connector");

  const shapeById = useMemo(
    () => new Map(shapes.map((shape) => [shape.id, shape])),
    [shapes],
  );

  const selectedShape = selectedId ? shapeById.get(selectedId) : null;

  // Keep move/up handlers in refs to avoid stale closures
  const handlePointerMoveRef = useRef(null);
  const finishDraftRef = useRef(null);

  // Sync refs on every render
  useEffect(() => {
    handlePointerMoveRef.current = handlePointerMove;
    finishDraftRef.current = finishDraft;
  });

  // Attach to window only while an operation is active
  useEffect(() => {
    const active = dragState || resizeState || panState || isDrawing;
    if (!active) return;

    const onMove = (e) => handlePointerMoveRef.current?.(e);
    const onUp = (e) => finishDraftRef.current?.(e);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragState, resizeState, panState, isDrawing]);

  useEffect(() => {
    if (onSelectionChange) onSelectionChange(selectedShape);
  }, [selectedShape, onSelectionChange]);

  // expose imperative methods + selection callback via ref
  useImperativeHandle(ref, () => ({
    getSelectedShape: () => selectedShape,
    updateSelectedStroke: (c) => updateSelectedStroke(c),
    updateSelectedFillColor: (c) => updateSelectedFillColor(c),
    updateSelectedText: (t) => updateSelectedText(t),
    updateSelectedStrokeWidth: (w) => updateSelectedStrokeWidth(w),
    updateSelectedFill: (f) => updateSelectedFill(f),
    updateSelectedFillOpacity: (o) => updateSelectedFillOpacity(o),
    clearSelection: () => {
      setSelectedId(null);
      setConnectorStart(null);
    }, // ← ADD
  }));

  // Effective active tool + setter: use parent-controlled if provided, otherwise local state
  const effectiveActiveTool = setActiveTool ? activeTool : localActiveTool;
  const setEffectiveActiveTool = (tool) => {
    if (setActiveTool) setActiveTool(tool);
    else setLocalActiveTool(tool);
  };

  const updateSelectedText = (text) => {
    if (!selectedShape || selectedShape.type === "pen") return;
    upsertElement({
      ...selectedShape,
      text: text || "",
    });
  };

  const updateSelectedStrokeWidth = (width) => {
    if (!selectedShape) return;
    setStrokeWidth(width);
    upsertElement({ ...selectedShape, strokeWidth: width });
  };

  const updateSelectedFillOpacity = (opacity) => {
    if (!selectedShape || selectedShape.type === "pen") return;
    setFillOpacity(opacity);
    upsertElement({ ...selectedShape, fillOpacity: opacity });
  };

  const activeShapeTool = ["rect", "circle"].includes(effectiveActiveTool);

  const readElements = useCallback(() => {
    if (!drawings) return;
    setElements(
      [...drawings.values()].sort((a, b) => a.createdAt - b.createdAt),
    );
  }, [drawings]);

  useEffect(() => {
    if (!drawings) return undefined;
    readElements();
    drawings.observe(readElements);
    return () => drawings.unobserve(readElements);
  }, [drawings, readElements]);

  // Smart versioning: watch combined text (editor + shapes) and create snapshot only when text changes
  const lastSavedTextRef = useRef("");
  useEffect(() => {
    if (!docId) return undefined;
    let mounted = true;

    const getCombinedText = () => {
      return editor?.getText?.() || "";
    };

    lastSavedTextRef.current = getCombinedText();

    const id = setInterval(async () => {
      if (!mounted || !canEdit) return;
      try {
        const current = getCombinedText();
        if (current !== lastSavedTextRef.current) {
          const res = await apiFetch(
            `${API_URL}/api/documents/${docId}/snapshots`,
            {
              method: "POST",
              body: JSON.stringify({ label: "Text change" }),
            },
          );
          if (res.ok) lastSavedTextRef.current = current;
        }
      } catch (e) {
        // ignore
      }
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [docId, editor, shapes, canEdit]);

  useEffect(() => {
    if (!editor) return undefined;

    const handleEditorFocus = () => {
      setSelectedId(null);
      setConnectorStart(null);
    };

    editor.on("focus", handleEditorFocus);
    return () => editor.off("focus", handleEditorFocus);
  }, [editor]);

  const getTextRects = useCallback(() => {
    const svg = svgRef.current;
    const editorDom = editor?.view?.dom;
    if (!svg || !editorDom) return [];
    const svgRect = svg.getBoundingClientRect();
    const scaleX = PAGE_WIDTH / svgRect.width;
    const scaleY = pageHeight / svgRect.height;

    return [...editorDom.children]
      .filter((child) => child.textContent?.trim())
      .map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          x: (rect.left - svgRect.left) * scaleX,
          y: (rect.top - svgRect.top) * scaleY,
          width: rect.width * scaleX,
          height: rect.height * scaleY,
        };
      });
  }, [editor]);

  const upsertElement = useCallback(
    (element) => {
      drawings?.set(element.id, element);
    },
    [drawings],
  );

  const addElement = useCallback(
    (element) => {
      drawings?.set(element.id, { ...element, createdAt: Date.now() });
    },
    [drawings],
  );

  const updateSelectedStroke = (color) => {
    if (!selectedShape) return;
    setStrokeColor(color);
    upsertElement({ ...selectedShape, stroke: color });
  };

  const updateSelectedFillColor = (color) => {
    if (!selectedShape || selectedShape.type === "pen") return;
    setFillColor(color);
    const newFill = shapesFilled ? color : "transparent";
    upsertElement({ ...selectedShape, fill: newFill });
  };

  const updateSelectedFill = (filled) => {
    if (!selectedShape || selectedShape.type === "pen") return;
    const newFill = filled ? fillColor : "transparent";
    setShapesFilled(filled);
    upsertElement({ ...selectedShape, fill: newFill });
  };

  const handlePointerDown = (event) => {
    if (!canEdit || !drawings || event.button !== 0) return;

    if (effectiveActiveTool === "hand") {
      const container = svgRef.current?.closest(".editor-body");
      if (container) {
        setPanState({
          startX: event.clientX,
          startY: event.clientY,
          scrollLeft: container.scrollLeft,
          scrollTop: container.scrollTop,
        });
        event.preventDefault();
      }
      return;
    }

    // When using select tool, let shapes handle their own clicks
    // When using drawing tools, we want to draw over shapes, so continue processing
    if (
      event.target.classList?.contains("drawing-shape") &&
      effectiveActiveTool === "select"
    ) {
      return;
    }

    const svg = svgRef.current;
    const point = getPointerPosition(event, svg, pageHeight);

    // Check for resize handle
    if (
      selectedShape &&
      effectiveActiveTool === "select" &&
      selectedShape.type !== "pen"
    ) {
      const isResizeHandle = event.target.classList?.contains("resize-handle");
      if (isResizeHandle) {
        const handle = event.target.getAttribute("data-handle");
        setResizeState({ shape: selectedShape, start: point, handle });
        return;
      }
    }

    // Handle double-click on document with select tool to edit text
    if (effectiveActiveTool === "select") {
      const now = Date.now();
      const isDoubleClick =
        now - lastDocClickRef.current.time < 300 &&
        Math.abs(point.x - lastDocClickRef.current.x) < 10 &&
        Math.abs(point.y - lastDocClickRef.current.y) < 10;

      lastDocClickRef.current = { time: now, x: point.x, y: point.y };

      if (isDoubleClick) {
        const editorView = editor?.view;
        if (editorView) {
          // Translate the screen-space click to a ProseMirror document position
          const pmPos = editorView.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          editor.commands.focus();
          if (pmPos) {
            editor.commands.setTextSelection(pmPos.pos);
          }
        }
        return;
      }

      // Single click: deselect shape and connector
      setSelectedId(null);
      setConnectorStart(null);
      return;
    }

    if (effectiveActiveTool === "pen") {
      event.preventDefault();
      setIsDrawing(true);
      setDraft({
        kind: "shape",
        id: createId("shape"),
        type: "pen",
        points: [point],
        stroke: strokeColor,
        lineStyle,
        strokeWidth,
      });
      return;
    }

    if (activeShapeTool) {
      event.preventDefault();
      setDraft({
        kind: "shape",
        id: createId("shape"),
        type: effectiveActiveTool,
        startPoint: point,
        ...normalizeBox(point, point),
        fill: shapesFilled ? fillColor : "transparent",
        stroke: strokeColor,
        strokeWidth,
        fillOpacity,
        text: "",
      });
      return;
    }

    if (effectiveActiveTool === "select") {
      setSelectedId(null);
      setConnectorStart(null);
    }
  };

  const handlePointerMove = (event) => {
    const svg = svgRef.current;
    if (!svg) return;
    const point = getPointerPosition(event, svg, pageHeight);

    if (panState) {
      const container = svgRef.current?.closest(".editor-body");
      if (container) {
        container.scrollLeft =
          panState.scrollLeft - (event.clientX - panState.startX);
        container.scrollTop =
          panState.scrollTop - (event.clientY - panState.startY);
      }
      return;
    }

    if (resizeState) {
      const { shape, handle } = resizeState;
      const dx = point.x - resizeState.start.x;
      const dy = point.y - resizeState.start.y;
      let updated = { ...shape };

      if (handle === "se") {
        updated.width = Math.max(MIN_SIZE, shape.width + dx);
        updated.height = Math.max(MIN_SIZE, shape.height + dy);
      } else if (handle === "sw") {
        updated.x = Math.min(shape.x + shape.width - MIN_SIZE, shape.x + dx);
        updated.y = shape.y;
        updated.width = Math.max(MIN_SIZE, shape.width - dx);
        updated.height = Math.max(MIN_SIZE, shape.height + dy);
      } else if (handle === "ne") {
        updated.x = shape.x;
        updated.y = Math.min(shape.y + shape.height - MIN_SIZE, shape.y + dy);
        updated.width = Math.max(MIN_SIZE, shape.width + dx);
        updated.height = Math.max(MIN_SIZE, shape.height - dy);
      } else if (handle === "nw") {
        updated.x = Math.min(shape.x + shape.width - MIN_SIZE, shape.x + dx);
        updated.y = Math.min(shape.y + shape.height - MIN_SIZE, shape.y + dy);
        updated.width = Math.max(MIN_SIZE, shape.width - dx);
        updated.height = Math.max(MIN_SIZE, shape.height - dy);
      }

      // Constrain within page boundaries
      let clamped = clampShape(updated, PAGE_WIDTH, pageHeight);
      upsertElement(clamped);
      setResizeState({ ...resizeState, shape: clamped, start: point });
      return;
    }

    if (draft?.type === "pen") {
      setDraft((current) => ({
        ...current,
        points: [...current.points, point],
      }));
      return;
    }

    if (draft && activeShapeTool) {
      setDraft((current) => ({
        ...current,
        ...normalizeBox(current.startPoint, point),
      }));
      return;
    }

    if (dragState) {
      const dx = point.x - dragState.start.x;
      const dy = point.y - dragState.start.y;
      let next = moveShape(dragState.shape, dx, dy);
      // Constrain shape within page boundaries
      next = clampShape(next, PAGE_WIDTH, pageHeight);
      upsertElement(next);
      // Update dragState with the constrained position
      setDragState({ ...dragState, shape: next, start: point });
    }
  };

  const finishDraft = () => {
    if (panState) {
      setPanState(null);
      return;
    }
    if (resizeState) {
      setResizeState(null);
      return;
    }
    if (dragState) {
      setDragState(null);
      return;
    }
    if (!draft) {
      setIsDrawing(false);
      return;
    }
    if (draft.type === "pen" && draft.points.length < 2) {
      setDraft(null);
      setIsDrawing(false);
      return;
    }
    const { startPoint, ...shapeDraft } = draft;
    let normalized = shapeDraft.type === "pen" ? draft : shapeDraft;
    // Constrain shape within page boundaries
    normalized = clampShape(normalized, PAGE_WIDTH, pageHeight);
    addElement(normalized);
    setSelectedId(normalized.id);
    setStrokeColor(normalized.stroke);
    if (normalized.type !== "pen") {
      setFillColor(
        normalized.fill !== "transparent" ? normalized.fill : DEFAULT_FILL,
      );
      setShapesFilled(normalized.fill !== "transparent");
    }
    setDraft(null);
    setIsDrawing(false);
    // Always snap back to select so the user can immediately move/resize
    setEffectiveActiveTool("select");
  };

  const handleShapePointerDown = (event, shape) => {
    event.preventDefault();
    if (!canEdit) return;
    event.stopPropagation();
    const point = getPointerPosition(event, svgRef.current, pageHeight);

    // If a drawing tool is active, don't interact with shape - let drawing happen
    if (activeShapeTool || effectiveActiveTool === "pen") {
      return;
    }

    setSelectedId(shape.id);
    setStrokeColor(shape.stroke);
    if (shape.type !== "pen") {
      setFillColor(shape.fill !== "transparent" ? shape.fill : DEFAULT_FILL);
      setShapesFilled(shape.fill !== "transparent");
    }

    // Double-click to edit text - track click timing (only in select mode)
    if (effectiveActiveTool === "select") {
      const now = Date.now();
      const isDoubleClick =
        lastClickRef.current.id === shape.id &&
        now - lastClickRef.current.time < 300;

      lastClickRef.current = { id: shape.id, time: now };

      if (isDoubleClick && shape.type !== "pen") {
        setEditingTextId(shape.id);
        setEditingTextValue(shape.text || "");
        lastClickRef.current = { id: null, time: 0 }; // Reset to avoid triple-click
        return;
      }
    } else {
      lastClickRef.current = { id: null, time: 0 };
    }

    if (effectiveActiveTool === "arrow") {
      if (!connectorStart || connectorStart === shape.id) {
        setConnectorStart(shape.id);
        return;
      }
      addElement({
        kind: "connector",
        id: createId("connector"),
        fromId: connectorStart,
        toId: shape.id,
        stroke: strokeColor,
        filled: true,
        lineStyle,
      });

      setConnectorStart(null);
      setEffectiveActiveTool("select"); // snap back after arrow is placed
      return;
    }

    if (effectiveActiveTool === "select") {
      setDragState({ shape, start: point });
    }
  };

  const deleteSelected = () => {
    if (!selectedId || !drawings) return;
    drawings.delete(selectedId);
    for (const connector of connectors) {
      if (connector.fromId === selectedId || connector.toId === selectedId)
        drawings.delete(connector.id);
    }
    setSelectedId(null);
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!canEdit || (event.key !== "Backspace" && event.key !== "Delete"))
        return;
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }
      deleteSelected();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Map tools to cursor styles
  const getCursorStyle = () => {
    const cursors = {
      hand: panState ? "grabbing" : "grab",
      select: "default",
      rect: "crosshair",
      circle: "crosshair",
      arrow: "crosshair",
    };
    return cursors[effectiveActiveTool] || "default";
  };

  return (
    <>
      <svg
        ref={svgRef}
        className="drawing-layer w-full h-full"
        viewBox={`0 0 ${PAGE_WIDTH} ${pageHeight}`}
        style={{
          height: pageHeight,
          width: PAGE_WIDTH,
          // In select mode: background is transparent so clicks reach the text editor.
          // Shapes override this with pointer-events: all (see Change 2).
          // In drawing mode: SVG captures everything so the user can draw on empty space.
          pointerEvents:
            effectiveActiveTool === "select" && !dragState && !resizeState
              ? "none"
              : "auto",
          cursor: effectiveActiveTool === "select" ? "text" : getCursorStyle(),
        }}
        onPointerDown={(event) => {
          if (effectiveActiveTool === "hand") {
            handlePointerDown(event); // pan starts here
            return;
          }
          if (effectiveActiveTool === "select") {
            if (
              event.target === svgRef.current ||
              event.target.tagName === "svg"
            ) {
              setSelectedId(null);
              setConnectorStart(null);
              // (keep existing double-click-to-focus-editor code)
            }
            return;
          }
          handlePointerDown(event);
        }}
        onPointerMove={handlePointerMove} // still needed: drag/resize track via window
        onPointerUp={finishDraft}
      >
        <defs>
          <marker
            id="arrow-filled"
            markerWidth="12"
            markerHeight="12"
            refX="10"
            refY="6"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M 0 0 L 12 6 L 0 12 z" fill={DEFAULT_STROKE} />
          </marker>
          <marker
            id="arrow-line"
            markerWidth="12"
            markerHeight="12"
            refX="10"
            refY="6"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path
              d="M 0 0 L 12 6 L 0 12"
              fill="none"
              stroke={DEFAULT_STROKE}
              strokeWidth="2"
            />
          </marker>
          {/* Dynamic marker colors for each stroke color */}
          {COLOR_PALETTE.map((color) => (
            <g key={`markers-${color.value}`}>
              <marker
                id={`arrow-filled-${color.value.slice(1)}`}
                markerWidth="12"
                markerHeight="12"
                refX="10"
                refY="6"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 12 6 L 0 12 z" fill={color.value} />
              </marker>
              <marker
                id={`arrow-line-${color.value.slice(1)}`}
                markerWidth="12"
                markerHeight="12"
                refX="10"
                refY="6"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path
                  d="M 0 0 L 12 6 L 0 12"
                  fill="none"
                  stroke={color.value}
                  strokeWidth="2"
                />
              </marker>
            </g>
          ))}
        </defs>

        {connectors.map((connector) => {
          const fromShape = shapeById.get(connector.fromId);
          const toShape = shapeById.get(connector.toId);
          if (!fromShape || !toShape) return null;
          const markerSuffix =
            connector.stroke === DEFAULT_STROKE
              ? ""
              : `-${connector.stroke.slice(1)}`;
          return (
            <path
              key={connector.id}
              className="drawing-connector"
              d={connectorPath(connector, fromShape, toShape)}
              fill="none"
              style={{ pointerEvents: "all" }}
              stroke={connector.stroke}
              strokeWidth={connector.strokeWidth ?? 2.5}
              strokeDasharray={
                connector.lineStyle === "dashed" ? "8 6" : undefined
              }
              markerEnd={`url(#${connector.filled ? "arrow-filled" : "arrow-line"}${markerSuffix})`}
            />
          );
        })}

        {[...shapes, draft].filter(Boolean).map((shape) => {
          if (!shape || isNaN(shape.x) || isNaN(shape.y)) return null;
          const selected =
            selectedId === shape.id || connectorStart === shape.id;
          const common = {
            className: `drawing-shape${selected ? " selected" : ""}`,
            stroke: shape.stroke,
            strokeWidth: shape.strokeWidth ?? (selected ? 3 : 2),
            strokeDasharray: shape.lineStyle === "dashed" ? "7 5" : undefined,
            style: { pointerEvents: "all" }, // ← ADD THIS
            onPointerDown: (event) => {
              if (!activeShapeTool && effectiveActiveTool !== "pen") {
                event.stopPropagation();
              }
              handleShapePointerDown(event, shape);
            },
          };
          if (shape.type === "pen") {
            return (
              <path
                key={shape.id}
                {...common}
                style={{ pointerEvents: "all" }}
                d={toPath(shape.points)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          }
          return (
            <g key={shape.id} style={{ pointerEvents: "all" }}>
              {shape.type === "rect" && (
                <rect
                  {...common}
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  rx="6"
                  fill={shape.fill}
                  fillOpacity={shape.fillOpacity ?? 1}
                />
              )}
              {shape.type === "circle" && (
                <ellipse
                  {...common}
                  cx={shape.x + shape.width / 2}
                  cy={shape.y + shape.height / 2}
                  rx={shape.width / 2}
                  ry={shape.height / 2}
                  fill={shape.fill}
                  fillOpacity={shape.fillOpacity ?? 1}
                />
              )}
              {shape.type === "triangle" && (
                <polygon
                  {...common}
                  points={trianglePoints(shape)}
                  fill={shape.fill}
                  fillOpacity={shape.fillOpacity ?? 1}
                />
              )}

              {/* Inline text editor */}
              {editingTextId === shape.id ? (
                <foreignObject
                  x={shape.x + 4}
                  y={shape.y + 4}
                  width={Math.max(50, shape.width - 8)}
                  height={Math.max(20, shape.height - 8)}
                  className="text-editor-wrap"
                >
                  <input
                    autoFocus
                    type="text"
                    value={editingTextValue}
                    onChange={(e) => setEditingTextValue(e.target.value)}
                    onBlur={() => {
                      updateSelectedText(editingTextValue);
                      setEditingTextId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        updateSelectedText(editingTextValue);
                        setEditingTextId(null);
                      }
                    }}
                    className="w-full h-full text-center outline-none bg-transparent overflow-hidden"
                    style={{ fontSize: "16px" }}
                  />
                </foreignObject>
              ) : (
                <ShapeLabel shape={shape} />
              )}

              {/* Resize handles */}
              {selected &&
                shape.type !== "pen" &&
                effectiveActiveTool === "select" && (
                  <>
                    <circle
                      cx={shape.x + shape.width}
                      cy={shape.y + shape.height}
                      r="6"
                      className="resize-handle"
                      data-handle="se"
                      fill="white"
                      stroke={shape.stroke}
                      strokeWidth="2"
                      style={{ cursor: "se-resize" }}
                    />
                    <circle
                      cx={shape.x}
                      cy={shape.y + shape.height}
                      r="6"
                      className="resize-handle"
                      data-handle="sw"
                      fill="white"
                      stroke={shape.stroke}
                      strokeWidth="2"
                      style={{ cursor: "sw-resize" }}
                    />
                    <circle
                      cx={shape.x + shape.width}
                      cy={shape.y}
                      r="6"
                      className="resize-handle"
                      data-handle="ne"
                      fill="white"
                      stroke={shape.stroke}
                      strokeWidth="2"
                      style={{ cursor: "ne-resize" }}
                    />
                    <circle
                      cx={shape.x}
                      cy={shape.y}
                      r="6"
                      className="resize-handle"
                      data-handle="nw"
                      fill="white"
                      stroke={shape.stroke}
                      strokeWidth="2"
                      style={{ cursor: "nw-resize" }}
                    />
                  </>
                )}
            </g>
          );
        })}
      </svg>
    </>
  );
}

export default React.forwardRef(DrawingLayer);
