// Shelf-based atlas allocator with frame-stamped page recycling.
//
// Both GPU backends key their placement cache on bitmap object identity, which
// hits for static (identity-stable) cached layers but MISSES for animated
// content that produces a fresh Uint8Array per glyph per frame. Under that miss
// pattern the allocator is asked to place ~one screen of fresh glyphs every
// frame, so bounding memory is the whole job.
//
// Bounding strategy: pack slots into shelves on a small set of pages. Each page
// records the newest frame any of its slots was used on. When placement runs
// out of room, recycle a page whose newest slot predates the current frame
// (i.e. nothing drawn THIS frame lives on it) by clearing its shelves and
// reusing its whole area. A page still touched this frame is never recycled, so
// a draw already recorded this frame can never have its atlas region
// overwritten. Static pages keep getting touched every frame and so are never
// recycled, preserving the upload-once fast path.
//
// The backend owns the actual textures (one per page, addressed by pageIndex)
// and re-uploads whenever it is handed a slot whose gen/free state no longer
// matches its cached entry. Recycling bumps gen and marks the old slots free so
// those stale cache entries miss and re-upload.

const DEFAULT_MAX_PAGES = 8;
// Recycle a page once it has gone this many frames without being touched. 1 =
// recycle any page not written on the current frame (tightest bound; safe
// because in-frame pages are protected). Higher values retain more pages to
// spare re-uploads for near-static content at a small memory cost.
const DEFAULT_RETAIN_FRAMES = 1;
// Allow a shelf to accept a slightly shorter slot so near-equal heights share a
// shelf instead of proliferating new ones.
const SHELF_SLACK = 4;

export type AtlasSlot = {
  pageIndex: number;
  x: number;
  y: number;
  // Capacity of the slot (its reserved region in the atlas). Content may be
  // smaller when a larger freed slot is reused for a smaller bitmap.
  w: number;
  h: number;
  usedW: number;
  usedH: number;
  // Bumped whenever the slot's region is reassigned (page recycle), so a stale
  // cache entry pointing at a reassigned slot can detect the mismatch.
  gen: number;
  lastFrame: number;
  free: boolean;
};

type Shelf = {
  y: number;
  height: number;
  cursorX: number;
};

export type AtlasPage = {
  width: number;
  height: number;
  shelves: Shelf[];
  bottom: number;
  slots: AtlasSlot[];
  // Newest frame any slot on this page was allocated or touched on.
  lastFrame: number;
};

export type AtlasAllocatorOptions = {
  pageSize: number;
  padding: number;
  maxPages?: number;
  // Frames a page may go untouched before it becomes recyclable. Accepts the
  // legacy `evictAge` name as an alias.
  retainFrames?: number;
  evictAge?: number;
};

export class AtlasAllocator {
  readonly pageSize: number;
  readonly padding: number;
  readonly maxPages: number;
  readonly retainFrames: number;
  readonly pages: AtlasPage[] = [];

  constructor(opts: AtlasAllocatorOptions) {
    this.pageSize = Math.max(256, opts.pageSize);
    this.padding = Math.max(0, opts.padding);
    this.maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
    this.retainFrames = Math.max(
      1,
      opts.retainFrames ?? opts.evictAge ?? DEFAULT_RETAIN_FRAMES,
    );
  }

  get pageCount(): number {
    return this.pages.length;
  }

  allocate(w: number, h: number, frame: number): AtlasSlot {
    let slot = this.placeInShelf(w, h);
    if (!slot && this.recycleRetiredPage(w, h, frame)) {
      slot = this.placeInShelf(w, h);
    }
    if (!slot && this.pages.length < this.maxPages) {
      this.addPage(w, h);
      slot = this.placeInShelf(w, h);
    }
    if (!slot) {
      // Every page holds content from the current frame and we are at the page
      // cap: growing is the only correct option (a live region must not be
      // overwritten). This only happens if a single frame needs more atlas than
      // the cap allows; the bound is restored on the next frame.
      this.addPage(w, h);
      slot = this.placeInShelf(w, h)!;
    }
    slot.usedW = w;
    slot.usedH = h;
    slot.lastFrame = frame;
    slot.free = false;
    const page = this.pages[slot.pageIndex]!;
    if (frame > page.lastFrame) page.lastFrame = frame;
    return slot;
  }

  touch(slot: AtlasSlot, frame: number): void {
    slot.lastFrame = frame;
    const page = this.pages[slot.pageIndex];
    if (page && frame > page.lastFrame) page.lastFrame = frame;
  }

  private placeInShelf(w: number, h: number): AtlasSlot | null {
    const pad = this.padding;
    for (let p = 0; p < this.pages.length; p++) {
      const page = this.pages[p]!;
      const shelves = page.shelves;
      for (let si = 0; si < shelves.length; si++) {
        const shelf = shelves[si]!;
        if (
          h <= shelf.height &&
          shelf.height <= h + SHELF_SLACK &&
          shelf.cursorX + w <= page.width
        ) {
          const x = shelf.cursorX;
          shelf.cursorX = x + w + pad;
          return this.makeSlot(p, x, shelf.y, w, shelf.height);
        }
      }
      if (w <= page.width && page.bottom + h <= page.height) {
        const y = page.bottom;
        shelves.push({ y, height: h, cursorX: w + pad });
        page.bottom = y + h + pad;
        return this.makeSlot(p, 0, y, w, h);
      }
    }
    return null;
  }

  private makeSlot(
    pageIndex: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): AtlasSlot {
    const slot: AtlasSlot = {
      pageIndex,
      x,
      y,
      w,
      h,
      usedW: w,
      usedH: h,
      gen: 0,
      lastFrame: -1,
      free: false,
    };
    this.pages[pageIndex]!.slots.push(slot);
    return slot;
  }

  private addPage(w: number, h: number): void {
    this.pages.push({
      width: Math.max(this.pageSize, w),
      height: Math.max(this.pageSize, h),
      shelves: [],
      bottom: 0,
      slots: [],
      lastFrame: -1,
    });
  }

  // Reset (in place, keeping its index and the backend's texture) the oldest
  // page that has not been touched this frame and can hold w x h. Returns true
  // if a page was recycled. Old slots are invalidated so stale backend cache
  // entries miss and re-upload.
  private recycleRetiredPage(w: number, h: number, frame: number): boolean {
    const cutoff = frame - this.retainFrames;
    let oldest: AtlasPage | null = null;
    for (let p = 0; p < this.pages.length; p++) {
      const page = this.pages[p]!;
      if (page.lastFrame > cutoff) continue;
      if (page.width < w || page.height < h) continue;
      if (!oldest || page.lastFrame < oldest.lastFrame) oldest = page;
    }
    if (!oldest) return false;
    const slots = oldest.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      s.free = true;
      s.gen++;
    }
    oldest.slots = [];
    oldest.shelves = [];
    oldest.bottom = 0;
    return true;
  }
}
