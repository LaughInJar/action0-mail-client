import { Fragment, useRef, type ReactNode } from "react";
import { useUi } from "../../state/context";
import { COLUMN_LIMITS } from "../../state/uiStore";

/** One column of {@link ResizableColumns}. */
export interface Column {
  readonly id: string;
  /** Accessible name of the column region. */
  readonly label: string;
  /** Index into the persisted column widths; omit for the flexible column. */
  readonly widthIndex?: 0 | 1;
  readonly content: ReactNode;
}

/** Side-by-side columns with draggable (and keyboard-adjustable) dividers. */
export function ResizableColumns({ columns }: { columns: readonly Column[] }) {
  const widths = useUi((state) => state.columnWidths);
  const setColumnWidth = useUi((state) => state.setColumnWidth);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {columns.map((column) => {
        const index = column.widthIndex;
        if (index === undefined) {
          return (
            <section
              key={column.id}
              aria-label={column.label}
              className="min-h-0 min-w-0 flex-1"
            >
              {column.content}
            </section>
          );
        }
        return (
          <Fragment key={column.id}>
            <section
              aria-label={column.label}
              className="min-h-0 shrink-0 border-r border-zinc-200 dark:border-zinc-800"
              style={{ width: widths[index] }}
            >
              {column.content}
            </section>
            <ColumnResizer
              label={column.label}
              width={widths[index]}
              min={COLUMN_LIMITS[index].min}
              max={COLUMN_LIMITS[index].max}
              onResize={(width) => {
                setColumnWidth(index, width);
              }}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

interface ColumnResizerProps {
  readonly label: string;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (width: number) => void;
}

function ColumnResizer({
  label,
  width,
  min,
  max,
  onResize,
}: ColumnResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  /* A focusable separator is the ARIA "window splitter" widget (WAI-ARIA 1.2,
     APG), which jsx-a11y still classifies as non-interactive. */
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          onResize(
            drag.current.startWidth + event.clientX - drag.current.startX,
          );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === "ArrowLeft") onResize(width - step);
        else if (event.key === "ArrowRight") onResize(width + step);
        else return;
        event.preventDefault();
      }}
      className="relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none hover:bg-blue-500/30 focus-visible:bg-blue-500/40 focus-visible:outline-none"
    />
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
