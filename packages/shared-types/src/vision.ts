/**
 * Vision AI Results domain types: detections, stitched tracks and scene events.
 */
import type { EpochSeconds, Uuid } from './common.js';

/**
 * An oriented bounding box `[cx, cy, w, h, angle]` with positive width/height.
 * Exactly five elements.
 */
export type Obb = [cx: number, cy: number, w: number, h: number, angle: number];

/** A single YOLOv11x OBB detection from an onboard vision pipeline. */
export interface Detection {
  id: Uuid;
  droneId: Uuid;
  /** Frame capture time in epoch seconds, `>= 0`. */
  frameTs: EpochSeconds;
  /** Object class label. */
  cls: string;
  /** Detection confidence, `[0, 1]`. */
  confidence: number;
  obb: Obb;
  /** Track assigned by stitching, or `null` before assignment. */
  trackId: Uuid | null;
}

/** A temporally stitched sequence of detections of a single object. */
export interface Track {
  trackId: Uuid;
  /** Object class shared by all detections in the track. */
  cls: string;
  /** Detections ordered chronologically. */
  detections: Detection[];
  /** Frame timestamp of the most recent detection. */
  lastSeenTs: EpochSeconds;
}

/** Kinds of scene event classified from tracks against mission zones. */
export const SCENE_EVENT_KINDS = [
  'person_entered_zone',
  'vehicle_stopped',
  'group_gathering',
] as const;
export type SceneEventKind = (typeof SCENE_EVENT_KINDS)[number];

/** A classified scene-intelligence event referencing tracks and a zone. */
export interface SceneEvent {
  kind: SceneEventKind;
  zoneId: Uuid;
  /** Track ids participating in the event. */
  trackIds: Uuid[];
  ts: EpochSeconds;
}
