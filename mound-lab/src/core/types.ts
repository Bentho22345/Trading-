// Core data types shared by the analysis pipeline, the UI and storage.

export const JOINTS = [
  'nose',
  'lShoulder', 'rShoulder',
  'lElbow', 'rElbow',
  'lWrist', 'rWrist',
  'lHip', 'rHip',
  'lKnee', 'rKnee',
  'lAnkle', 'rAnkle',
  'lHeel', 'rHeel',
  'lToe', 'rToe',
] as const;
export type JointName = (typeof JOINTS)[number];
export const J: Record<JointName, number> = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;
export const NJ = JOINTS.length;

/** MediaPipe Pose Landmarker (33 points) index for each of our joints. */
export const MEDIAPIPE_INDEX: number[] = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

/** Pairs swapped by left/right correction. */
export const ARM_PAIRS: [JointName, JointName][] = [['lElbow', 'rElbow'], ['lWrist', 'rWrist']];
export const LEG_PAIRS: [JointName, JointName][] = [['lKnee', 'rKnee'], ['lAnkle', 'rAnkle'], ['lHeel', 'rHeel'], ['lToe', 'rToe']];

export const BONES: [JointName, JointName][] = [
  ['lShoulder', 'rShoulder'], ['lHip', 'rHip'], ['lShoulder', 'lHip'], ['rShoulder', 'rHip'],
  ['lShoulder', 'lElbow'], ['lElbow', 'lWrist'], ['rShoulder', 'rElbow'], ['rElbow', 'rWrist'],
  ['lHip', 'lKnee'], ['lKnee', 'lAnkle'], ['rHip', 'rKnee'], ['rKnee', 'rAnkle'],
  ['lAnkle', 'lHeel'], ['lHeel', 'lToe'], ['lAnkle', 'lToe'], ['rAnkle', 'rHeel'], ['rHeel', 'rToe'], ['rAnkle', 'rToe'],
];

/**
 * A pose track in image pixel coordinates (x right, y down).
 * Stored joint-major: x[j][i] is joint j at frame i.
 */
export interface PoseTrack {
  fps: number; // real-time frames per second (capture rate)
  width: number;
  height: number;
  t: number[]; // real time (s) of each frame
  x: Float32Array[];
  y: Float32Array[];
  c: Float32Array[]; // confidence 0..1
  filled?: Uint8Array[]; // 1 where a value was interpolated
  model: string;
  /** Optional 3D world landmarks (meters, hip-centred) from the pose model: the monocular "3D estimate". */
  world?: { x: Float32Array[]; y: Float32Array[]; z: Float32Array[] };
}

export type View = 'side-open' | 'side-closed' | 'front' | 'back' | 'oblique';
export type ViewClass = 'S' | 'F' | 'B' | 'O';
export const viewClass = (v: View): ViewClass => (v.startsWith('side') ? 'S' : v === 'front' ? 'F' : v === 'back' ? 'B' : 'O');

export type EventCode = 'FM' | 'PKH' | 'HS' | 'FS' | 'MER' | 'BR' | 'MIR' | 'END';
export const EVENT_CODES: EventCode[] = ['FM', 'PKH', 'HS', 'FS', 'MER', 'BR', 'MIR', 'END'];
export const EVENT_LABELS: Record<EventCode, string> = {
  FM: 'First movement',
  PKH: 'Peak leg lift',
  HS: 'Hand separation',
  FS: 'Foot strike',
  MER: 'Max layback',
  BR: 'Ball release',
  MIR: 'End of deceleration',
  END: 'Finish',
};
export type Events = Record<EventCode, number>; // frame indices

export type Side = 'L' | 'R';
export interface Roles {
  lead: Side; // lead (stride) leg
  throw: Side; // throwing arm
  dir: 1 | -1; // +1 if the pitcher moves toward +x in the image
}

export interface Scale {
  heightPx: number; // estimated standing body height in pixels
  groundY: number; // ground line y (px)
  originX: number; // back-ankle x at the set position (rubber proxy)
  heightM?: number; // athlete height if known
}

export type Tier = 'high' | 'medium' | 'low' | 'na';
export interface MetricValue {
  value: number | null;
  tier: Tier;
  note?: string;
}
export type Metrics = Record<string, MetricValue>;

export interface Analysis {
  version: number;
  view: View;
  viewAuto: View;
  fps: number;
  roles: Roles;
  scale: Scale;
  events: { auto: Events; edited: Partial<Events> };
  metrics: Metrics;
  /** Per-frame series in body units (degrees, % height, etc.) for charts. */
  series: Record<string, Float32Array>;
  warnings: string[];
}

export function resolvedEvents(a: Pick<Analysis, 'events'>): Events {
  return { ...a.events.auto, ...a.events.edited } as Events;
}
