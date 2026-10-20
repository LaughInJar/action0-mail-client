import { addDays } from "./dates";

/** Something with a start and end in epoch ms. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Where a timed event sits in a day column. */
export interface DayPlacement<T> {
  readonly item: T;
  /** Fraction of the day from its top, 0–1. */
  readonly top: number;
  /** Fraction of the day it covers (at least a sliver). */
  readonly height: number;
  /** Its lane among the overlapping ones, and how many lanes they need. */
  readonly lane: number;
  readonly lanes: number;
}

/**
 * Lays out a day's timed events: overlapping events share the width side by
 * side. Events are grouped into clusters that overlap one another; within a
 * cluster each event takes the first lane that's free when it starts.
 */
export function layoutDay<T>(
  day: Date,
  items: readonly T[],
  spanOf: (item: T) => Span,
): DayPlacement<T>[] {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const length = dayEnd - dayStart;
  const sorted = items
    .map((item) => ({ item, span: spanOf(item) }))
    .filter(({ span }) => span.start < dayEnd && span.end > dayStart)
    .sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);

  const placements: DayPlacement<T>[] = [];
  let cluster: { item: T; span: Span; lane: number }[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((entry) => entry.lane + 1));
    for (const { item, span, lane } of cluster) {
      const start = Math.max(span.start, dayStart);
      const end = Math.min(span.end, dayEnd);
      placements.push({
        item,
        top: (start - dayStart) / length,
        height: Math.max((end - start) / length, 1 / 96),
        lane,
        lanes,
      });
    }
    cluster = [];
  };

  for (const entry of sorted) {
    if (entry.span.start >= clusterEnd) flush();
    const laneEnds: number[] = [];
    for (const placed of cluster)
      laneEnds[placed.lane] = Math.max(
        laneEnds[placed.lane] ?? -Infinity,
        placed.span.end,
      );
    let lane = laneEnds.findIndex((end) => end <= entry.span.start);
    if (lane === -1) lane = laneEnds.length;
    cluster.push({ ...entry, lane });
    clusterEnd = Math.max(clusterEnd, entry.span.end);
  }
  flush();
  return placements;
}

/** A bar of an all-day (or multi-day) event across a row of days. */
export interface BarPlacement<T> {
  readonly item: T;
  /** First and last day it covers within the row (indices), inclusive. */
  readonly first: number;
  readonly last: number;
  /** Its row among the bars, so bars never overlap. */
  readonly row: number;
  /** It started before the row / goes on after it. */
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

/**
 * Lays out bars over `days` consecutive days starting at `first`: each bar
 * takes the lowest row that's free on all its days. Longer bars go first.
 */
export function layoutBars<T>(
  first: Date,
  days: number,
  items: readonly T[],
  spanOf: (item: T) => Span,
): BarPlacement<T>[] {
  const starts = Array.from({ length: days + 1 }, (_, i) =>
    addDays(first, i).getTime(),
  );
  const rowEnd = starts[days] ?? 0;
  const dayIndex = (time: number) => {
    let index = 0;
    while (index < days && (starts[index + 1] ?? Infinity) <= time) index++;
    return index;
  };
  const entries = items
    .map((item) => ({ item, span: spanOf(item) }))
    .filter(({ span }) => span.start < rowEnd && span.end > (starts[0] ?? 0))
    .map(({ item, span }) => ({
      item,
      span,
      first: dayIndex(Math.max(span.start, starts[0] ?? 0)),
      last: dayIndex(Math.min(span.end, rowEnd) - 1),
    }))
    .sort(
      (a, b) =>
        a.first - b.first ||
        b.last - b.first - (a.last - a.first) ||
        a.span.start - b.span.start,
    );

  const taken: boolean[][] = [];
  return entries.map(({ item, span, first: from, last: to }) => {
    let row = 0;
    for (;;) {
      const cells = (taken[row] ??= []);
      let free = true;
      for (let day = from; day <= to; day++)
        if (cells[day]) {
          free = false;
          break;
        }
      if (free) {
        for (let day = from; day <= to; day++) cells[day] = true;
        break;
      }
      row++;
    }
    return {
      item,
      first: from,
      last: to,
      row,
      continuesBefore: span.start < (starts[0] ?? 0),
      continuesAfter: span.end > rowEnd,
    };
  });
}
