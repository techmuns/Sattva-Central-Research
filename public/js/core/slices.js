// ONE IMPLEMENTATION, TWO DRIVERS.
//
// A rebuild or a ranking written as a generator that yields between units of work — a bucket of
// rows, a company's card — can be driven synchronously, which is the reference every consumer
// that must answer now still uses, or in ~12ms slices with a yield to input between them, so the
// same work spread over time never lands as one multi-second task. The result is identical either
// way: the generator decides the work and the driver only decides when it happens. Slicing is a
// scheduling change, never a change to what is collected, matched, ordered or shown.
export const SLICE_MS = 12;
export const yieldToInput = () => typeof window === 'undefined' ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 0));

/** Drive a generator to completion now and return its result. */
export function runSteps(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * A stable merge sort as a generator: runs of `run` elements are sorted natively, then merged
 * bottom-up, yielding after every run and every `stride` merged elements, so a hundred-thousand-
 * row sort never lands as one task. Ties take the left run first, which keeps it stable — and a
 * stable sort under the same comparator orders exactly as `Array.prototype.sort` does (V8's is
 * stable too), so the synchronous drive and the sliced drive agree element for element. In place.
 */
export function* sortSteps(array, compare, { run = 2048, stride = 4096 } = {}) {
  const n = array.length;
  if (n < 2) return array;
  for (let lo = 0; lo < n; lo += run) {
    const part = array.slice(lo, Math.min(lo + run, n)).sort(compare);
    for (let i = 0; i < part.length; i++) array[lo + i] = part[i];
    yield;
  }
  let src = array, dst = new Array(n);
  for (let width = run; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n), hi = Math.min(lo + 2 * width, n);
      let i = lo, j = mid, k = lo, since = 0;
      while (i < mid && j < hi) {
        dst[k++] = compare(src[j], src[i]) < 0 ? src[j++] : src[i++];
        if (++since >= stride) { since = 0; yield; }
      }
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
      yield;
    }
    [src, dst] = [dst, src];
  }
  if (src !== array) for (let i = 0; i < n; i++) array[i] = src[i];
  return array;
}

/**
 * Drive a generator in slices. Between slices `keepGoing()` is asked whether anybody is still
 * waiting; once it says no the work stops and the promise resolves to `undefined`, so an abandoned
 * rebuild is never installed or published as a result.
 */
export async function runStepsInSlices(steps, { yieldForInput = yieldToInput, sliceMs = SLICE_MS, keepGoing = () => true } = {}) {
  let started = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - started >= sliceMs) {
      await yieldForInput();
      if (!keepGoing()) return undefined;
      started = performance.now();
    }
  }
}
