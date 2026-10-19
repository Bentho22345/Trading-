// IndexedDB schema of a Mound Lab library (shared by db.ts and the guest → account move).
export const SCHEMA_V1: Record<string, string> = {
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
};
