export type FrameProfile = {
  frameMs: number;
  layoutMs: number;
  rasterMs: number;
  blurMs: number;
  shapeMs: number;
  fontMs: number;
  eventCount: number;
  layerCount: number;
  start: number;
};

let activeProfile: FrameProfile | null = null;

const now = (): number => {
  if (typeof performance !== "undefined" && performance.now) return performance.now();
  return Date.now();
};

export function startFrameProfile(enabled: boolean): FrameProfile | null {
  if (!enabled) return null;
  activeProfile = {
    frameMs: 0,
    layoutMs: 0,
    rasterMs: 0,
    blurMs: 0,
    shapeMs: 0,
    fontMs: 0,
    eventCount: 0,
    layerCount: 0,
    start: now(),
  };
  return activeProfile;
}

export function endFrameProfile(): FrameProfile | null {
  if (!activeProfile) return null;
  activeProfile.frameMs = now() - activeProfile.start;
  const profile = activeProfile;
  activeProfile = null;
  return profile;
}

export function isProfiling(): boolean {
  return activeProfile !== null;
}

export function addLayoutMs(delta: number): void {
  if (activeProfile) activeProfile.layoutMs += delta;
}

export function addRasterMs(delta: number): void {
  if (activeProfile) activeProfile.rasterMs += delta;
}

export function addBlurMs(delta: number): void {
  if (activeProfile) activeProfile.blurMs += delta;
}

export function addShapeMs(delta: number): void {
  if (activeProfile) activeProfile.shapeMs += delta;
}

export function addFontMs(delta: number): void {
  if (activeProfile) activeProfile.fontMs += delta;
}

export function setEventCount(count: number): void {
  if (activeProfile) activeProfile.eventCount = count;
}

export function setLayerCount(count: number): void {
  if (activeProfile) activeProfile.layerCount = count;
}

export function profileNow(): number {
  return now();
}
