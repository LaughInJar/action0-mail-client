import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { useT } from "../../i18n/context";
import { BUTTON, HINT, PRIMARY } from "../common/formStyles";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import {
  cropPicture,
  loadPicture,
  releasePicture,
  type LoadedPicture,
} from "./photoCrop";

/** The frame's size on screen (px). */
const FRAME = 256;
const MAX_ZOOM = 4;
/** How far an arrow key moves the picture (px on screen). */
const STEP = 12;

interface View {
  readonly zoom: number;
  /** The picture's top-left corner relative to the frame's (px on screen, ≤ 0). */
  readonly x: number;
  readonly y: number;
}

/** Keeps the picture covering the whole frame. */
function clamp(picture: LoadedPicture, view: View): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const scale = (FRAME / Math.min(picture.width, picture.height)) * zoom;
  const width = picture.width * scale;
  const height = picture.height * scale;
  return {
    zoom,
    x: Math.min(0, Math.max(FRAME - width, view.x)),
    y: Math.min(0, Math.max(FRAME - height, view.y)),
  };
}

/** Zooms around the frame's middle. */
function zoomTo(picture: LoadedPicture, view: View, zoom: number): View {
  const factor = Math.min(MAX_ZOOM, Math.max(1, zoom)) / view.zoom;
  const middle = FRAME / 2;
  return clamp(picture, {
    zoom: view.zoom * factor,
    x: middle - (middle - view.x) * factor,
    y: middle - (middle - view.y) * factor,
  });
}

/**
 * Fits a picture into the round avatar: a square frame over it, moved by
 * dragging (or the arrow keys) and zoomed with the slider, the wheel, a
 * pinch or +/−. Use hands back a JPEG of at most 512 px.
 */
export function PhotoCropper({
  file,
  onUse,
  onCancel,
}: {
  file: Blob;
  onUse: (photo: Blob) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const [picture, setPicture] = useState<LoadedPicture | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  useEffect(() => {
    let loaded: LoadedPicture | undefined;
    let cancelled = false;
    loadPicture(file).then(
      (result) => {
        loaded = result;
        if (cancelled) {
          releasePicture(result);
          return;
        }
        setPicture(result);
        // Centred, the shorter side filling the frame.
        const scale = FRAME / Math.min(result.width, result.height);
        setView({
          zoom: 1,
          x: (FRAME - result.width * scale) / 2,
          y: (FRAME - result.height * scale) / 2,
        });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (loaded) releasePicture(loaded);
    };
  }, [file]);

  const move = (dx: number, dy: number) => {
    if (picture)
      setView((current) =>
        clamp(picture, { ...current, x: current.x + dx, y: current.y + dy }),
      );
  };
  const zoom = (next: number) => {
    if (picture) setView((current) => zoomTo(picture, current, next));
  };

  const use = async () => {
    if (!picture) return;
    const scale = (FRAME / Math.min(picture.width, picture.height)) * view.zoom;
    try {
      onUse(
        await cropPicture(picture, {
          x: -view.x / scale,
          y: -view.y / scale,
          size: FRAME / scale,
        }),
      );
    } catch {
      setFailed(true);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, now);
    const points = [...pointers.current.values()];
    const [a, b] = points;
    if (points.length === 2 && a && b) {
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current !== null && pinch.current > 0)
        zoom(view.zoom * (distance / pinch.current));
      pinch.current = distance;
      return;
    }
    move(now.x - last.x, now.y - last.y);
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
  };

  const scale = picture
    ? (FRAME / Math.min(picture.width, picture.height)) * view.zoom
    : 1;

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onCancel}>
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
        <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
          {c.cropTitle}
        </h2>
        <IconButton label={c.cancel} icon="x" onClick={onCancel} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto p-4">
        {failed ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {c.couldntReadPicture}
          </p>
        ) : (
          <>
            {/* A two-dimensional crop area moved by dragging and the arrow keys
                (no ARIA widget fits); the slider below zooms accessibly. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <div
              role="application"
              aria-label={c.photo}
              aria-describedby={`${id}-hint`}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              style={{ width: FRAME, height: FRAME }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                pointers.current.set(event.pointerId, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onWheel={(event) => {
                zoom(view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
              }}
              onKeyDown={(event) => {
                const keys: Record<string, () => void> = {
                  ArrowLeft: () => {
                    move(STEP, 0);
                  },
                  ArrowRight: () => {
                    move(-STEP, 0);
                  },
                  ArrowUp: () => {
                    move(0, STEP);
                  },
                  ArrowDown: () => {
                    move(0, -STEP);
                  },
                  "+": () => {
                    zoom(view.zoom * 1.1);
                  },
                  "=": () => {
                    zoom(view.zoom * 1.1);
                  },
                  "-": () => {
                    zoom(view.zoom / 1.1);
                  },
                };
                const run = keys[event.key];
                if (!run) return;
                event.preventDefault();
                run();
              }}
              className="relative shrink-0 cursor-move touch-none overflow-hidden rounded-lg bg-zinc-200 select-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:bg-zinc-800"
            >
              {picture && (
                <img
                  src={picture.url}
                  alt=""
                  draggable={false}
                  style={{
                    width: picture.width * scale,
                    height: picture.height * scale,
                    transform: `translate(${String(view.x)}px, ${String(view.y)}px)`,
                  }}
                  className="pointer-events-none absolute top-0 left-0 max-w-none"
                />
              )}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
              />
            </div>
            <div className="flex w-full max-w-64 items-center gap-2">
              <IconButton
                label={c.zoomOut}
                icon="minimize"
                disabled={!picture || view.zoom <= 1}
                onClick={() => {
                  zoom(view.zoom / 1.25);
                }}
              />
              <input
                type="range"
                aria-label={c.zoom}
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={view.zoom}
                disabled={!picture}
                onChange={(event) => {
                  zoom(Number(event.target.value));
                }}
                className="min-w-0 flex-1 accent-blue-600"
              />
              <IconButton
                label={c.zoomIn}
                icon="maximize"
                disabled={!picture || view.zoom >= MAX_ZOOM}
                onClick={() => {
                  zoom(view.zoom * 1.25);
                }}
              />
            </div>
            <p id={`${id}-hint`} className={`${HINT} text-center`}>
              {c.cropHint}
            </p>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <button type="button" onClick={onCancel} className={BUTTON}>
          {c.cancel}
        </button>
        <button
          type="button"
          disabled={!picture || failed}
          onClick={() => {
            void use();
          }}
          className={PRIMARY}
        >
          {c.usePhoto}
        </button>
      </div>
    </Sheet>
  );
}
