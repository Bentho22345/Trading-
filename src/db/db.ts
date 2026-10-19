// Local-first storage (IndexedDB via Dexie). Nothing here ever leaves the device.

import Dexie, { type Table } from 'dexie';
import type { Events, PoseTrack, View } from '../core/types';
import type { VideoMeta } from '../video/meta';
import type { ScanResult } from '../pose/pipeline';

export interface BallData {
  velo?: number; spin?: number; spinEff?: number; gyro?: number; ivb?: number; hb?: number;
  relHeight?: number; relSide?: number; extension?: number;
}

export interface ClipRecord {
  id: string;
  name: string;
  createdAt: number;
  hash: string;
  size: number;
  meta: VideoMeta;
  trim: { inS: number; outS: number };
  slowmo: number;
  view?: View; // user override
  heightM?: number;
  edits: Partial<Events>;
  athleteId?: string;
  sessionId?: string;
  pitchType?: string;
  effortPct?: number;
  tags: string[];
  starred?: boolean;
  notes?: string;
  ballData?: BallData;
  thumb?: Blob;
  mirror?: boolean;
  rotate?: number; // extra clockwise rotation chosen by the user (0/90/180/270)
  personId?: number; // person chosen as the pitcher (when the user switched)
  veloManual?: { mph: number; low: number; high: number }; // from the user marking the ball
  calibPxPerM?: number; // user calibration (track pixels per metre)
  analyzedWith?: string; // model id once a track exists
}

export interface Athlete {
  id: string; name: string; birthYear?: number; heightCm?: number; weightKg?: number;
  throws: 'R' | 'L'; level?: string; team?: string; createdAt: number;
}
export interface Session {
  id: string; athleteId: string; date: string; location?: string; cameraSetup?: string; notes?: string; armFeel?: number;
}
export interface WorkloadEntry {
  id: string; athleteId: string; date: string; pitches: number; intent?: 'Recovery' | 'Medium' | 'Medium-High' | 'High';
  armFeel?: number; pain?: boolean; notes?: string; innings?: number;
}
export interface Annotation {
  id: string; clipId: string; frame?: number; kind: string; points: [number, number][]; text?: string; color?: string;
}
export interface Marker { id: string; athleteId: string; date: string; text: string }
export interface DrillAssignment { id: string; athleteId: string; drillId: string; createdAt: number; done: boolean; note?: string }

class MoundDB extends Dexie {
  clips!: Table<ClipRecord, string>;
  videos!: Table<{ id: string; blob: Blob }, string>;
  tracks!: Table<{ id: string; track: PoseTrack; scan?: ScanResult }, string>; // id = trackKey(...)
  frames!: Table<{ id: string; frames: Blob[] }, string>;
  athletes!: Table<Athlete, string>;
  sessions!: Table<Session, string>;
  workload!: Table<WorkloadEntry, string>;
  annotations!: Table<Annotation, string>;
  markers!: Table<Marker, string>;
  assignments!: Table<DrillAssignment, string>;
  kv!: Table<{ key: string; value: unknown }, string>;
  constructor() {
    super('mound-lab');
    this.version(1).stores({
      clips: 'id, createdAt, athleteId, sessionId, pitchType, hash, *tags',
      videos: 'id',
      tracks: 'id',
      frames: 'id',
      athletes: 'id, name',
      sessions: 'id, athleteId, date',
      workload: 'id, athleteId, date',
      annotations: 'id, clipId',
      markers: 'id, athleteId, date',
      assignments: 'id, athleteId',
      kv: 'key',
    });
  }
}

export const db = new MoundDB();

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Content hash of a file (first/last 2 MB + size) for caching tracks. */
export async function hashFile(f: Blob): Promise<string> {
  const head = await f.slice(0, 2 * 1024 * 1024).arrayBuffer();
  const tail = await f.slice(Math.max(0, f.size - 2 * 1024 * 1024)).arrayBuffer();
  const buf = new Uint8Array(head.byteLength + tail.byteLength + 8);
  buf.set(new Uint8Array(head), 0);
  buf.set(new Uint8Array(tail), head.byteLength);
  new DataView(buf.buffer).setFloat64(head.byteLength + tail.byteLength, f.size);
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const trackKey = (c: Pick<ClipRecord, 'hash' | 'trim' | 'slowmo' | 'rotate' | 'personId'>, model: string) =>
  `${c.hash}:${model}:${c.trim.inS.toFixed(3)}-${c.trim.outS.toFixed(3)}:${c.slowmo}:r${c.rotate ?? 0}:p${c.personId ?? 'auto'}:v2`;

/** Key of the person scan (independent of which person is chosen). */
export const scanKey = (c: Pick<ClipRecord, 'hash' | 'trim' | 'slowmo' | 'rotate'>, model: string) =>
  `scan:${c.hash}:${model}:${c.trim.inS.toFixed(3)}-${c.trim.outS.toFixed(3)}:r${c.rotate ?? 0}:v2`;
