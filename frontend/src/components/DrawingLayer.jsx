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
  const from = getShapeEdgePoint(fromShape, toShape);
  const to = getShapeEdgePoint(toShape, fromShape);

  if (connector.pathType === "curve") {
    const delta = Math.max(60, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + delta} ${from.y}, ${to.x - delta} ${to.y}, ${to.x} ${to.y}`;
  }

  // Orthogonal path: only horizontal and vertical lines (0 or 90 degrees)
  if (connector.pathType === "elbow") {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);

    // Determine if we should go horizontal first or vertical first
    if (dx > dy) {
      // Go horizontal first, then vertical
      const midX = from.x + (to.x - from.x) / 2;
      return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
    } else {
      // Go vertical first, then horizontal
      const midY = from.y + (to.y - from.y) / 2;
      return `M ${from.x} ${from.y} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y}`;
    }
  }

  // Simple straight line
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
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

export function DrawingToolbar({
  activeTool,
  setActiveTool,
  connectorKind,
  setConnectorKind,
  connectorFilled,
  setConnectorFilled,
  lineStyle,
  setLineStyle,
  selectedShape,
  updateSelectedText,
  updateSelectedStroke,
  updateSelectedStrokeWidth,
  updateSelectedFill,
  updateSelectedFillColor,
  updateSelectedFillOpacity,
  selectedStroke,
  selectedFilled,
  selectedFillColor,
  disabled,
  compact = false,
}) {
  const showShapeOptions = selectedShape && selectedShape.type !== "pen";

  if (compact) {
    // Compact version - horizontal buttons for shape tools
    return (
      <div className="drawing-tools-compact flex items-center gap-1">
        {Object.entries(TOOL_LABELS).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setActiveTool(value)}
            disabled={disabled}
            title={label}
            className={`
              px-3 py-1 rounded text-sm font-medium transition-colors
              ${
                activeTool === value
                  ? "bg-blue-500 text-white"
                  : "bg-gray-200 text-gray-800 hover:bg-gray-300"
              }
              ${disabled ? "opacity-50 cursor-not-allowed" : ""}
            `}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  return (
    // <div className="drawing-toolbar" aria-label="Drawing tools">
    <div className="flex items-center gap-2" aria-label="Drawing tools">
      {/* Tool Selection */}
      <div className="toolbar-section">
        <select
          className="toolbar-select"
          value={activeTool}
          disabled={disabled}
          onChange={(event) => setActiveTool(event.target.value)}
        >
          {Object.entries(TOOL_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Connector Options */}
      <div className="toolbar-section">
        <select
          className="toolbar-select toolbar-select--small"
          value={connectorKind}
          hidden={disabled || activeTool !== "connector"}
          onChange={(event) => setConnectorKind(event.target.value)}
          title="Arrow path"
        >
          <option value="line">Line</option>
          <option value="curve">Curve</option>
          <option value="elbow">Elbow</option>
        </select>
        <select
          className="toolbar-select toolbar-select--small"
          value={lineStyle}
          disabled={disabled}
          onChange={(event) => setLineStyle(event.target.value)}
          title="Line style"
        >
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
        </select>
        {activeTool === "connector" && (
          <label className="drawing-toggle" title="Filled arrow head">
            <input
              type="checkbox"
              checked={connectorFilled}
              disabled={disabled}
              onChange={(event) => setConnectorFilled(event.target.checked)}
            />
            Fill
          </label>
        )}
      </div>

      {/* Shape Color & Stroke Options */}
      <div className="toolbar-section">
        <label className="toolbar-label">Stroke:</label>
        <input
          type="color"
          value={selectedStroke || DEFAULT_STROKE}
          disabled={disabled || (!selectedShape && !activeTool)}
          onChange={(event) => updateSelectedStroke(event.target.value)}
          title="Border color"
        />
        <label className="toolbar-label">Width:</label>
        <input
          type="range"
          min="1"
          max="12"
          value={selectedShape?.strokeWidth || 2}
          disabled={disabled || (!selectedShape && !activeTool)}
          onChange={(event) =>
            updateSelectedStrokeWidth(Number(event.target.value))
          }
          title="Border width"
        />
      </div>

      {/* Fill Color Options */}
      {showShapeOptions && (
        <div className="toolbar-section">
          <label className="toolbar-label">Fill:</label>
          <input
            type="color"
            value={selectedFillColor || DEFAULT_FILL}
            disabled={disabled}
            onChange={(event) => updateSelectedFillColor(event.target.value)}
            title="Fill color"
          />
          <label className="toolbar-label">Opacity:</label>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round((selectedShape?.fillOpacity ?? 1) * 100)}
            disabled={disabled}
            onChange={(event) =>
              updateSelectedFillOpacity(Number(event.target.value) / 100)
            }
            title="Fill opacity"
          />
          <label className="drawing-toggle" title="Fill shape">
            <input
              type="checkbox"
              checked={selectedFilled}
              disabled={disabled}
              onChange={(event) => updateSelectedFill(event.target.checked)}
            />
            On
          </label>
        </div>
      )}

      {/* Text Input */}
      {showShapeOptions && (
        <div className="toolbar-section">
          <input
            className="drawing-text-input"
            value={selectedShape?.text || ""}
            onChange={(event) => updateSelectedText(event.target.value)}
            disabled={disabled || !selectedShape}
            placeholder="Text"
            title="Shape text"
          />
        </div>
      )}

      {selectedShape && (
        <div className="flex items-center gap-3 ml-3 px-3 py-1 bg-gray-100 rounded-md">
          {/* Stroke */}
          <input
            type="color"
            value={selectedStroke || "#000"}
            onChange={(e) => updateSelectedStroke(e.target.value)}
          />

          {/* Width */}
          <input
            type="range"
            min="1"
            max="10"
            value={selectedShape?.strokeWidth || 2}
            onChange={(e) => updateSelectedStrokeWidth(Number(e.target.value))}
            className="w-20"
          />

          {/* Fill */}
          {selectedShape.type !== "pen" && (
            <input
              type="color"
              value={selectedFillColor || "#ccc"}
              onChange={(e) => updateSelectedFillColor(e.target.value)}
            />
          )}

          {/* Text */}
          {selectedShape.type !== "pen" && (
            <input
              className="border px-2 py-1 rounded text-sm"
              value={selectedShape.text || ""}
              onChange={(e) => updateSelectedText(e.target.value)}
              placeholder="Text"
            />
          )}
        </div>
      )}
    </div>
  );
}

function ShapeLabel({ shape, allShapes, canvasWidth, canvasHeight }) {
  if (!shape.text) return null;

  // Helper to check text overlap with any shape
  const checkTextOverlap = (x, y, w, h) => {
    const textBounds = { x, y, width: w, height: h };
    return allShapes.some((s) => {
      if (s.id === shape.id || s.type === "pen") return false;
      const sBounds = shapeBounds(s);
      return rectsOverlap(textBounds, sBounds, 2);
    });
  };

  // Calculate optimal text position
  let x = shape.x + 8;
  let y = shape.y + 8;
  let width = Math.max(1, shape.width - 16);
  let height = Math.max(1, shape.height - 16);
  let isInsideShape = true;

  // If text overlaps with shapes, try to move it
  if (shape.type !== "pen" && allShapes.length > 1) {
    const textWidth = 100;
    const lineHeight = 20;

    // Try positions in order: right, below, left, above
    const positions = [
      { x: shape.x + shape.width + 8, y: shape.y, outside: "right" }, // right
      { x: shape.x, y: shape.y + shape.height + 8, outside: "below" }, // below
      { x: shape.x - textWidth - 8, y: shape.y, outside: "left" }, // left
      { x: shape.x, y: shape.y - lineHeight - 8, outside: "above" }, // above
    ];

    for (const pos of positions) {
      if (
        !checkTextOverlap(pos.x, pos.y, textWidth, lineHeight) &&
        pos.x >= 0 &&
        pos.y >= 0 &&
        pos.x + textWidth <= canvasWidth &&
        pos.y + lineHeight <= canvasHeight
      ) {
        x = pos.x;
        y = pos.y;
        width = textWidth;
        height = lineHeight;
        isInsideShape = false;
        break;
      }
    }
  }

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

  const drawings = useMemo(() => ydoc?.getMap("drawings"), [ydoc]);
  const shapes = elements.filter((element) => element.kind === "shape");
  const connectors = elements.filter((element) => element.kind === "connector");

  const shapeById = useMemo(
    () => new Map(shapes.map((shape) => [shape.id, shape])),
    [shapes],
  );

  const selectedShape = selectedId ? shapeById.get(selectedId) : null;

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

  const activeShapeTool = ["rect", "circle", "triangle"].includes(
    effectiveActiveTool,
  );

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
          const res = await apiFetch(`/api/documents/${docId}/snapshots`, {
            method: "POST",
            body: JSON.stringify({ label: "Text change" }),
          });
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
        // Focus the editor for text input
        editor?.commands.focus();
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

    if (effectiveActiveTool === "connector") {
      if (!connectorStart || connectorStart === shape.id) {
        setConnectorStart(shape.id);
        return;
      }
      addElement({
        kind: "connector",
        id: createId("connector"),
        fromId: connectorStart,
        toId: shape.id,
        pathType: connectorKind,
        stroke: strokeColor,
        filled: connectorFilled,
        lineStyle,
      });
      setConnectorStart(null);
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
    const toolCursors = {
      select: "default",
      pen: "crosshair",
      rect: "cell",
      circle: "move",
      triangle: "pointer",
      connector: "copy",
    };
    return toolCursors[effectiveActiveTool] || "crosshair";
  };

  return (
    <>
      <svg
        ref={svgRef}
        className={`
          drawing-layer w-full h-full
        `}
        viewBox={`0 0 ${PAGE_WIDTH} ${pageHeight}`}
        style={{
          height: pageHeight,
          width: PAGE_WIDTH,
          cursor: getCursorStyle(),
        }}
        onPointerDown={(e) => {
          handlePointerDown(e);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDraft}
        onPointerLeave={finishDraft}
        aria-label="Drawing canvas"
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
            onPointerDown: (event) => {
              // Only stop propagation if not using a drawing tool
              // When drawing tool is active, allow drawing on top of shapes
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
                d={toPath(shape.points)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          }
          return (
            <g key={shape.id}>
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
                <ShapeLabel
                  shape={shape}
                  allShapes={shapes}
                  canvasWidth={PAGE_WIDTH}
                  canvasHeight={pageHeight}
                />
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
