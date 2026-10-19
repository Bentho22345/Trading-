// Metric catalog: every metric's definition, unit, which camera views can measure it (and how well),
// reference ranges with sources, default change thresholds and plain-language coaching text.

import type { Tier, ViewClass } from './types';

export type Phase = 'windup' | 'stride' | 'cocking' | 'release' | 'follow';
export const PHASE_LABELS: Record<Phase, string> = {
  windup: 'Wind-up & leg lift',
  stride: 'Stride & foot strike',
  cocking: 'Arm cocking → release',
  release: 'Release',
  follow: 'Follow-through',
};

export type Unit = '°' | 'ms' | '% ht' | 'ht/s' | '°/s';

export interface MetricDef {
  key: string;
  label: string;
  short: string; // for tables/readouts
  phase: Phase;
  unit: Unit;
  digits: number;
  /** Validity tier per camera view; views not listed cannot measure it. */
  views: Partial<Record<ViewClass | '3D', Tier>>;
  fpsSensitive?: boolean; // needs ≥120 fps to keep its tier
  definition: string;
  meaning: string; // one plain-language line
  ref?: { lo: number; hi: number; text: string; source: string };
  threshold: number; // default "changed" threshold (absolute, in unit) — or percent when pct is true
  pct?: boolean;
  /** Kinetic-chain position: 1 = tempo/lower body (root causes), 2 = trunk, 3 = arm, 4 = outcome. */
  chain: 1 | 2 | 3 | 4;
  up: string; // what it usually means when the value goes up
  down: string;
  cueUp?: string; // cue when the value went up and you want it back down
  cueDown?: string; // cue when the value went down and you want it back up
  drillsUp?: string[];
  drillsDown?: string[];
  canConvertToFeet?: boolean;
  /**
   * Which way is better, for the "what's better / worse" verdict:
   *  'up' / 'down' = more / less is linked to velocity or lower arm stress in research,
   *  'target' = closer to the reference range is better, 'none' = style (neither better nor worse).
   */
  better: 'up' | 'down' | 'target' | 'none';
  /** Absolute flag: a value in this direction beyond the limit is worth attention on its own. */
  flag?: { above?: number; below?: number; text: string; stress?: boolean };
}

const ASMI = 'Diffendaffer, Fleisig et al., Sports Health 2023 (ASMI clinician\'s guide)';
const DRIVELINE = 'Driveline Baseball, "How We Interpret Biomechanics Reports" (2019)';
const SLOT = 'Arm-slot kinematics, high school vs pro (PMC10601404)';

export const METRICS: MetricDef[] = [
  // ---------- Wind-up / leg lift
  {
    key: 'legLift', better: 'none', label: 'Leg lift height', short: 'Leg lift', phase: 'windup', unit: '% ht', digits: 1,
    views: { S: 'high', F: 'medium', B: 'medium' },
    definition: 'Lead knee height above the hip centre at peak leg lift, as % of body height.',
    meaning: 'How high the front knee comes up. A personal style choice — consistency matters more than height.',
    threshold: 4, chain: 1,
    up: 'Higher leg lift; can add rhythm but also more time to stay balanced.',
    down: 'Lower leg lift; can quicken delivery but may cut momentum if rushed.',
    cueDown: 'Lift it up and let it fall toward the plate.', cueUp: 'Keep the lift simple and repeatable.',
    drillsDown: ['balance-hold', 'walking-windup'], drillsUp: ['balance-hold'],
  },
  {
    key: 'balancePKH', better: 'none', label: 'Head over rubber at leg lift', short: 'Head vs back foot @PKH', phase: 'windup', unit: '% ht', digits: 1,
    views: { S: 'high' },
    definition: 'Horizontal distance from the back ankle to the head at peak leg lift (+ = toward the plate).',
    meaning: 'Whether the body is drifting toward the plate early (+) or hanging back (−) at the top.',
    threshold: 3, chain: 1,
    up: 'Drifting toward the plate earlier — often "rushing", which can leave the arm late.',
    down: 'Staying back more over the rubber at the top of the lift.',
    cueUp: 'Get to the top, then go — don\'t fall forward early.', cueDown: 'Start moving down the mound sooner.',
    drillsUp: ['balance-hold', 'hip-lead'], drillsDown: ['walking-windup', 'hip-lead'],
  },
  {
    key: 'tFmPkh', better: 'none', label: 'Time: first move → leg lift', short: 'FM→PKH', phase: 'windup', unit: 'ms', digits: 0,
    views: { S: 'high', F: 'high', B: 'high', O: 'medium' },
    definition: 'Time from first movement to peak leg lift.',
    meaning: 'The tempo of the first part of the delivery.',
    threshold: 60, chain: 1,
    up: 'Slower start to the delivery.', down: 'Quicker start to the delivery.',
  },
  {
    key: 'tPkhFs', better: 'none', label: 'Time: leg lift → foot strike', short: 'PKH→FS', phase: 'stride', unit: 'ms', digits: 0,
    views: { S: 'high', F: 'high', B: 'high', O: 'medium' },
    definition: 'Time from peak leg lift to lead-foot strike.',
    meaning: 'How fast you move down the mound. Faster usually means more momentum toward the plate.',
    threshold: 50, chain: 1,
    up: 'Slower move down the mound — less momentum toward the plate.', down: 'Faster move down the mound — more momentum, but the arm must keep up.',
    cueUp: 'Be quicker to the plate after the lift ("go get it").', cueDown: 'Stay smooth — let the arm get up on time.',
    drillsUp: ['walking-windup', 'hip-lead', 'step-behind'], drillsDown: ['connection-ball', 'roll-in'],
  },
  {
    key: 'handBreakTiming', better: 'none', label: 'Hand break timing', short: 'HS vs PKH', phase: 'windup', unit: 'ms', digits: 0,
    views: { S: 'medium', F: 'medium', B: 'medium' },
    definition: 'Time of hand separation relative to peak leg lift (+ = after the top).',
    meaning: 'When the hands break. Breaking later can leave the arm late at foot strike.',
    threshold: 60, chain: 1,
    up: 'Hands break later relative to the leg lift — the arm has less time to get up.',
    down: 'Hands break earlier relative to the leg lift.',
    cueUp: 'Break the hands as the knee starts down.', cueDown: 'Keep the hands quiet until the knee peaks.',
    drillsUp: ['connection-ball', 'pivot-pickoff'],
  },
  {
    key: 'handBreakHeight', better: 'none', label: 'Hand break height', short: 'Hands @HS', phase: 'windup', unit: '% ht', digits: 1,
    views: { S: 'medium', F: 'medium', B: 'medium' },
    definition: 'Height of the throwing hand above the ground at hand separation, % of body height.',
    meaning: 'Where the hands start the arm action.',
    threshold: 5, chain: 1,
    up: 'Hands break higher.', down: 'Hands break lower.',
  },
  // ---------- Stride / foot strike
  {
    key: 'stride', better: 'target', label: 'Stride length', short: 'Stride', phase: 'stride', unit: '% ht', digits: 1, canConvertToFeet: true,
    views: { S: 'high' },
    definition: 'Distance from the back ankle at the set to the lead ankle at foot strike, % of body height.',
    meaning: 'How far down the mound you land. Longer strides (≈85–90% of height) are linked to more velocity when the front leg can still block.',
    ref: { lo: 80, hi: 90, text: '≈85% of height (older data ≈87%)', source: ASMI },
    threshold: 4, chain: 1,
    up: 'Longer stride — more distance to build momentum and extension.',
    down: 'Shorter stride — less momentum and extension; often comes with a more upright trunk at release.',
    cueDown: 'Push off and land farther down the mound — "get down the hill".', cueUp: 'Land where you can still firm up the front leg.',
    drillsDown: ['walking-windup', 'step-behind', 'hip-lead', 'stride-line'], drillsUp: ['front-leg-block', 'rocker'],
    flag: { below: 72, text: 'Stride is short for your height (under ~72%).' },
  },
  {
    key: 'comSpeed', better: 'up', label: 'Peak hip speed toward plate', short: 'Hip speed', phase: 'stride', unit: 'ht/s', digits: 2,
    views: { S: 'medium' },
    definition: 'Peak forward speed of the hip centre (centre-of-mass proxy) between leg lift and foot strike, body heights per second.',
    meaning: 'How much momentum you carry toward the plate. Faster is linked to more velocity in research.',
    threshold: 8, pct: true, chain: 1,
    up: 'More momentum toward the plate.', down: 'Less momentum toward the plate — a common cause of lost velocity.',
    cueDown: 'Lead with the hip and attack the plate.', drillsDown: ['hip-lead', 'walking-windup', 'step-behind'],
  },
  {
    key: 'hipSink', better: 'none', label: 'Hip drop into foot strike', short: 'Hip sink', phase: 'stride', unit: '% ht', digits: 1,
    views: { S: 'high', F: 'medium', B: 'medium' },
    definition: 'Drop of the hip centre from peak leg lift to foot strike, % of body height.',
    meaning: 'How much you sink as you stride. Some drop is needed for a long stride.',
    threshold: 3, chain: 1,
    up: 'Sinking more into the stride.', down: 'Staying taller into foot strike — often goes with a shorter stride.',
  },
  {
    key: 'leadKneeFS', better: 'target', label: 'Front knee bend at foot strike', short: 'Front knee @FS', phase: 'stride', unit: '°', digits: 0,
    views: { S: 'high', O: 'low' },
    definition: 'Lead-knee flexion at foot strike (180° − hip–knee–ankle angle; 0° = straight).',
    meaning: 'How bent the front knee is when the foot lands.',
    ref: { lo: 35, hi: 55, text: '≈45°', source: ASMI },
    threshold: 6, chain: 1,
    up: 'Landing with a more bent front knee.', down: 'Landing with a straighter front knee.',
  },
  {
    key: 'backKneeFS', better: 'none', label: 'Back knee bend at foot strike', short: 'Back knee @FS', phase: 'stride', unit: '°', digits: 0,
    views: { S: 'medium' },
    definition: 'Drive-leg knee flexion at foot strike.',
    meaning: 'How much the back leg is still bent as the front foot lands.',
    threshold: 8, chain: 1,
    up: 'More back-knee bend at landing.', down: 'Straighter back leg at landing.',
  },
  {
    key: 'trunkTiltFS', better: 'target', label: 'Trunk tilt at foot strike', short: 'Trunk @FS', phase: 'stride', unit: '°', digits: 0,
    views: { S: 'high' },
    definition: 'Hip-centre → shoulder-centre line vs vertical at foot strike (+ = leaning toward the plate).',
    meaning: 'Staying "stacked" at foot strike (near upright) keeps the trunk ready to rotate and bend forward.',
    ref: { lo: -10, hi: 10, text: 'roughly upright', source: DRIVELINE },
    threshold: 5, chain: 2,
    up: 'Leaning toward the plate earlier — can mean the trunk is "leaking" forward before the hips open.',
    down: 'Leaning back more at foot strike.',
    cueUp: 'Stay tall and stacked until the foot lands.', drillsUp: ['hip-lead', 'balance-hold'],
  },
  {
    key: 'elbowFlexFS', better: 'target', label: 'Elbow bend at foot strike', short: 'Elbow @FS', phase: 'stride', unit: '°', digits: 0,
    views: { S: 'medium', F: 'low' }, fpsSensitive: true,
    definition: 'Throwing-elbow flexion at foot strike (180° − shoulder–elbow–wrist angle).',
    meaning: 'How bent the throwing elbow is when the foot lands.',
    ref: { lo: 75, hi: 105, text: '≈90°', source: ASMI },
    threshold: 10, chain: 3,
    up: 'More bent elbow at foot strike.', down: 'Straighter arm at foot strike — often a long or late arm swing.',
  },
  {
    key: 'forearmFS', better: 'target', label: 'Arm timing at foot strike (forearm angle)', short: 'Forearm @FS', phase: 'stride', unit: '°', digits: 0,
    views: { S: 'medium' }, fpsSensitive: true,
    definition: 'Throwing forearm vs horizontal at foot strike (+ = hand above the elbow, "arm up"; − = hand below, "arm late").',
    meaning: 'Whether the arm is up and ready when the front foot lands. A late arm has to rush to catch up.',
    ref: { lo: 30, hi: 90, text: 'forearm up (hand above elbow)', source: ASMI },
    threshold: 12, chain: 3,
    up: 'Arm is more "on time" (hand higher) at foot strike.',
    down: 'Arm is later at foot strike — the hand is lower when the foot lands, so the arm must rush.',
    cueDown: 'Get the ball up as the front foot lands ("show the ball to 2nd base, then up").',
    drillsDown: ['connection-ball', 'pivot-pickoff', 'roll-in', 'towel'],
    flag: { below: 0, text: 'Late arm: the hand is below the elbow at foot strike.', stress: true },
  },
  {
    key: 'elbowHeightFS', better: 'target', label: 'Elbow height vs shoulders at foot strike', short: 'Elbow ht @FS', phase: 'stride', unit: '% ht', digits: 1,
    views: { S: 'medium', F: 'medium' },
    definition: 'Throwing elbow height minus throwing shoulder height at foot strike (% ht). 0 ≈ elbow level with the shoulder (≈90° abduction).',
    meaning: 'Elbow too low (arm drag) or too high (elbow climb) at foot strike is linked with more arm stress.',
    ref: { lo: -4, hi: 3, text: 'about shoulder height (≈90° abduction)', source: `${ASMI}; ${DRIVELINE}` },
    threshold: 3, chain: 3,
    up: 'Elbow sits higher relative to the shoulder.', down: 'Elbow sits lower — "low elbow / arm drag" pattern.',
    cueDown: 'Elbow up to shoulder height as you land.', cueUp: 'Keep the elbow at shoulder height, not above.',
    drillsDown: ['connection-ball', 'roll-in', 'band-pull-apart'], drillsUp: ['connection-ball'],
    flag: { below: -7, text: 'Elbow well below shoulder height at foot strike (low elbow).', stress: true },
  },
  {
    key: 'sepFS', better: 'up', label: 'Hip-shoulder separation at foot strike (2D estimate)', short: 'Separation @FS', phase: 'stride', unit: '°', digits: 0,
    views: { S: 'low', '3D': 'medium' },
    definition: 'Pelvis rotation minus trunk rotation at foot strike. From one side camera this is inferred from how wide the hips and shoulders look, so treat it as a rough estimate.',
    meaning: 'Hips opening while the shoulders stay closed stores energy. More separation is linked to trunk speed.',
    ref: { lo: 37, hi: 59, text: '48° ± 11° (high school)', source: 'Hip-shoulder separation in HS pitchers (PMC7727427)' },
    threshold: 10, chain: 2,
    up: 'More hip-shoulder separation.', down: 'Less separation — the shoulders may be opening with (or before) the hips.',
    cueDown: 'Land with the front shoulder still pointed at the plate; let the hips open first.',
    drillsDown: ['hip-lead', 'medball-scoop', 'step-behind'],
  },
  // ---------- Arm cocking → release
  {
    key: 'tFsMer', better: 'none', label: 'Time: foot strike → layback', short: 'FS→MER', phase: 'cocking', unit: 'ms', digits: 0,
    views: { S: 'medium', F: 'low' }, fpsSensitive: true,
    definition: 'Time from foot strike to max layback (2D proxy).',
    meaning: 'How quickly the arm lays back after landing.',
    threshold: 20, chain: 3,
    up: 'Longer from landing to layback.', down: 'Shorter from landing to layback.',
  },
  {
    key: 'tFsBr', better: 'down', label: 'Time: foot strike → release', short: 'FS→BR', phase: 'cocking', unit: 'ms', digits: 0,
    views: { S: 'high', F: 'high', B: 'high', O: 'medium' }, fpsSensitive: true,
    definition: 'Time from foot strike to ball release.',
    meaning: 'The final, fastest part of the delivery. If it gets longer, the arm is often late or the front side is soft.',
    threshold: 20, chain: 3,
    up: 'More time from landing to release — usually a late arm or a soft front side.',
    down: 'Less time from landing to release.',
    cueUp: 'Be ready to throw when you land.', drillsUp: ['connection-ball', 'rocker', 'front-leg-block'],
  },
  {
    key: 'layback', better: 'up', label: 'Layback (2D proxy)', short: 'Layback', phase: 'cocking', unit: '% ht', digits: 1,
    views: { S: 'medium', '3D': 'low' }, fpsSensitive: true,
    definition: 'How far the throwing hand trails behind the throwing shoulder at max layback, % of body height. A 2D stand-in for shoulder external rotation, which a single camera cannot measure.',
    meaning: 'More layback gives the arm a longer path to accelerate the ball.',
    threshold: 3, chain: 3,
    up: 'More layback.', down: 'Less layback — the arm path to release is shorter.',
    drillsDown: ['reverse-throw', 'plyo-pivot', 'pivot-pickoff'],
  },
  {
    key: 'leadKneeBR', better: 'down', label: 'Front knee bend at release', short: 'Front knee @BR', phase: 'release', unit: '°', digits: 0,
    views: { S: 'high' },
    definition: 'Lead-knee flexion at ball release.',
    meaning: 'A firm (straightening) front leg at release turns forward momentum into rotation.',
    ref: { lo: 20, hi: 40, text: '≈30°', source: ASMI },
    threshold: 6, chain: 1,
    up: 'Front knee more bent at release — the leg is giving way.', down: 'Front knee firmer at release.',
    cueUp: 'Land and stick it — push the front leg straight into the ground.',
    drillsUp: ['front-leg-block', 'rocker', 'stick-landing'],
    flag: { above: 50, text: 'Front knee is very bent at release (the leg is collapsing).' },
  },
  {
    key: 'kneeBlock', better: 'up', label: 'Front-leg block', short: 'Knee block', phase: 'release', unit: '°', digits: 0,
    views: { S: 'high' },
    definition: 'Lead-knee flexion at foot strike minus at release. + = the knee straightened (firm block); − = it bent more (collapse).',
    meaning: 'A firm front leg is one of the strongest links to velocity. Collapsing leaks energy and makes the arm work harder.',
    ref: { lo: 10, hi: 30, text: 'positive (knee extends after landing)', source: `${ASMI}; ${DRIVELINE}` },
    threshold: 6, chain: 1,
    up: 'Firmer front-leg block.', down: 'Front leg is softer/collapsing after landing — energy leaks and the trunk can\'t get over it.',
    cueDown: 'Land and stick it — "brace into a wall".', drillsDown: ['front-leg-block', 'rocker', 'stick-landing', 'medball-shotput'],
    flag: { below: 0, text: 'Front knee bends more after landing (collapse).' },
  },
  {
    key: 'kneeExtVel', better: 'up', label: 'Peak front-knee extension speed', short: 'Knee ext. speed', phase: 'release', unit: '°/s', digits: 0,
    views: { S: 'medium' }, fpsSensitive: true,
    definition: 'Peak speed of front-knee straightening between foot strike and just after release.',
    meaning: 'How hard the front leg snaps straight. Driveline cites ≈350°/s as a target.',
    ref: { lo: 250, hi: 600, text: '≈350°/s target', source: DRIVELINE },
    threshold: 15, pct: true, chain: 1,
    up: 'Front leg snaps straight faster.', down: 'Slower front-leg block.',
    drillsDown: ['front-leg-block', 'rocker'],
  },
  {
    key: 'trunkTiltBR', better: 'target', label: 'Forward trunk tilt at release', short: 'Trunk @BR', phase: 'release', unit: '°', digits: 0,
    views: { S: 'high' },
    definition: 'Hip-centre → shoulder-centre line vs vertical at release (+ = bent toward the plate).',
    meaning: 'Getting the chest out over the front leg adds extension and velocity.',
    ref: { lo: 30, hi: 45, text: 'roughly 30–45° forward', source: ASMI },
    threshold: 5, chain: 2,
    up: 'More forward trunk tilt at release.', down: 'More upright at release — less extension; often from a short stride or soft front leg.',
    cueDown: 'Finish with your chest over your front knee.', drillsDown: ['rocker', 'front-leg-block', 'kneeling-throw'],
    flag: { below: 20, text: 'Very upright trunk at release.' },
  },
  {
    key: 'elbowFlexBR', better: 'none', label: 'Elbow bend at release', short: 'Elbow @BR', phase: 'release', unit: '°', digits: 0,
    views: { S: 'medium' }, fpsSensitive: true,
    definition: 'Throwing-elbow flexion at release.',
    meaning: 'Usually ≈30–35° at release.',
    ref: { lo: 20, hi: 45, text: '≈30–35°', source: ASMI },
    threshold: 10, chain: 3,
    up: 'More bent elbow at release.', down: 'Straighter elbow at release.',
  },
  {
    key: 'releaseHeight', better: 'none', label: 'Release height', short: 'Release ht', phase: 'release', unit: '% ht', digits: 1, canConvertToFeet: true,
    views: { S: 'high', F: 'high', B: 'medium' }, fpsSensitive: true,
    definition: 'Throwing-hand height above the ground at release, % of body height.',
    meaning: 'Where the ball comes out vertically. Changes often come from trunk tilt or arm slot.',
    threshold: 3, chain: 4,
    up: 'Higher release point.', down: 'Lower release point.',
  },
  {
    key: 'extension', better: 'up', label: 'Release extension', short: 'Extension', phase: 'release', unit: '% ht', digits: 1, canConvertToFeet: true,
    views: { S: 'medium' }, fpsSensitive: true,
    definition: 'How far in front of the rubber (back ankle at the set) the hand is at release, % of body height.',
    meaning: 'More extension = the ball is released closer to the hitter, which raises perceived velocity.',
    threshold: 4, chain: 4,
    up: 'More extension.', down: 'Less extension — usually from a shorter stride, an upright trunk or a soft front leg.',
    cueDown: 'Reach out toward the catcher — "throw through the target".', drillsDown: ['rocker', 'walking-windup', 'long-toss'],
  },
  {
    key: 'headAtBR', better: 'up', label: 'Head position at release', short: 'Head @BR', phase: 'release', unit: '% ht', digits: 1,
    views: { S: 'high' },
    definition: 'Head ahead of (+) or behind (−) the lead ankle at release, % of body height.',
    meaning: 'Getting the head out over the front foot goes with good extension.',
    threshold: 4, chain: 2,
    up: 'Head gets farther out over the front foot.', down: 'Head stays farther back at release.',
    cueDown: 'Chase the catcher with your chest.', drillsDown: ['rocker', 'front-leg-block'],
  },
  {
    key: 'handSpeed', better: 'up', label: 'Peak hand speed (in-plane)', short: 'Hand speed', phase: 'release', unit: 'ht/s', digits: 1,
    views: { S: 'medium', F: 'low' }, fpsSensitive: true,
    definition: 'Peak throwing-wrist speed near release, body heights per second, measured in the camera plane. Only comparable between clips with the same camera setup.',
    meaning: 'An arm-speed proxy. Big drops can mean fatigue or less energy from the lower half.',
    threshold: 8, pct: true, chain: 4,
    up: 'Faster hand through release.', down: 'Slower hand through release.',
  },
  {
    key: 'gloveDistBR', better: 'down', label: 'Glove distance from chest at release', short: 'Glove @BR', phase: 'release', unit: '% ht', digits: 1,
    views: { S: 'medium', F: 'medium' },
    definition: 'Distance from the glove wrist to the shoulder centre at release, % of body height.',
    meaning: 'A glove kept close to the chest helps the trunk rotate; a glove flying out can pull the body open.',
    threshold: 4, chain: 2,
    up: 'Glove farther from the body — the glove side is flying open.', down: 'Glove tucked closer to the chest.',
    cueUp: 'Pull the chest to the glove, not the glove to the hip.', drillsUp: ['glove-tuck', 'stride-line'],
    flag: { above: 24, text: 'Glove is far from the body at release (flying open).' },
  },
  // ---------- Front-view metrics
  {
    key: 'armSlot', better: 'none', label: 'Arm slot', short: 'Arm slot', phase: 'release', unit: '°', digits: 0,
    views: { F: 'high', B: 'medium' }, fpsSensitive: true,
    definition: 'Angle between vertical and the shoulder→hand line at release, seen from home plate (0° = straight over the top, 90° = sidearm).',
    meaning: 'Where the arm comes through. Pros: overhand ≈44°, three-quarter ≈58°, sidearm ≈75°.',
    ref: { lo: 35, hi: 75, text: 'overhand ≈44°, ¾ ≈58°, sidearm ≈75° (pros)', source: SLOT },
    threshold: 6, chain: 3,
    up: 'Lower (more sidearm) arm slot.', down: 'Higher (more over the top) arm slot.',
  },
  {
    key: 'latTiltFS', better: 'none', label: 'Side bend at foot strike', short: 'Side bend @FS', phase: 'stride', unit: '°', digits: 0,
    views: { F: 'high', B: 'medium' },
    definition: 'Trunk side bend vs vertical at foot strike, seen from home plate (+ = toward the glove side).',
    meaning: 'How much the trunk is already tilting sideways at landing.',
    threshold: 5, chain: 2,
    up: 'More glove-side tilt at landing.', down: 'Less glove-side tilt at landing.',
  },
  {
    key: 'latTiltBR', better: 'target', label: 'Side bend at release', short: 'Side bend @BR', phase: 'release', unit: '°', digits: 0,
    views: { F: 'high', B: 'medium' },
    definition: 'Trunk side bend vs vertical at release, seen from home plate (+ = toward the glove side).',
    meaning: 'Some side bend matches a high arm slot (≈34° overhand, ≈25° sidearm). A lot more has been linked to higher arm torque.',
    ref: { lo: 20, hi: 40, text: '≈34° overhand → ≈25° sidearm', source: SLOT },
    threshold: 5, chain: 2,
    up: 'More side bend at release.', down: 'Less side bend at release.',
    flag: { above: 45, text: 'Large trunk side bend at release (linked to higher arm torques in research).', stress: true },
  },
  {
    key: 'strideDir', better: 'target', label: 'Stride direction (foot line)', short: 'Foot line', phase: 'stride', unit: '% ht', digits: 1,
    views: { F: 'medium', B: 'medium' },
    definition: 'Lead-ankle sideways offset at foot strike from the line through the back foot toward the plate (+ = toward the arm side / "closed").',
    meaning: 'Landing far off the line (open or closed) changes how the hips can rotate.',
    ref: { lo: -6, hi: 6, text: 'within ≈10 cm of the line', source: ASMI },
    threshold: 3, chain: 1,
    up: 'Landing more closed (across the body).', down: 'Landing more open (toward the glove side).',
    drillsUp: ['stride-line'], drillsDown: ['stride-line'],
    flag: { below: -8, text: 'Landing well open of the line to the plate (linked to more shoulder force).', stress: true },
  },
  {
    key: 'releaseSide', better: 'none', label: 'Release side', short: 'Release side', phase: 'release', unit: '% ht', digits: 1,
    views: { F: 'medium', B: 'low' },
    definition: 'Sideways hand position at release relative to the rubber (+ = toward the arm side).',
    meaning: 'Where the ball comes out sideways.',
    threshold: 4, chain: 4,
    up: 'Release farther to the arm side.', down: 'Release more over the top / toward the middle.',
  },
  {
    key: 'headLatBR', better: 'down', label: 'Head sideways at release', short: 'Head side @BR', phase: 'release', unit: '% ht', digits: 1,
    views: { F: 'high', B: 'medium' },
    definition: 'Head sideways offset from the lead ankle at release (+ = toward the glove side).',
    meaning: 'A head that falls far to the glove side often comes with a lot of side bend.',
    threshold: 4, chain: 2,
    up: 'Head falls more to the glove side.', down: 'Head stays more over the front foot.',
    cueUp: 'Keep your eyes level on the target.', drillsUp: ['balance-hold', 'stick-landing'],
  },
  // ---------- 3D estimate metrics (monocular world landmarks)
  {
    key: 'sep3dMax', better: 'up', label: 'Max hip-shoulder separation (3D estimate)', short: 'Max separation 3D', phase: 'stride', unit: '°', digits: 0,
    views: { '3D': 'low' },
    definition: 'Largest pelvis-minus-trunk rotation between leg lift and release, from the pose model\'s single-camera 3D estimate.',
    meaning: 'A rough read of how much the hips lead the shoulders. Single-camera 3D is an estimate, not a measurement.',
    threshold: 12, chain: 2,
    up: 'More separation (estimate).', down: 'Less separation (estimate).',
  },
  // ---------- Follow-through
  {
    key: 'decelDist', better: 'up', label: 'Arm deceleration path', short: 'Decel path', phase: 'follow', unit: '% ht', digits: 0,
    views: { S: 'low' },
    definition: 'Length of the hand path from release to end of deceleration, % of body height.',
    meaning: 'A longer, smoother path spreads out the braking forces on the arm.',
    threshold: 10, chain: 4,
    up: 'Longer deceleration path.', down: 'Shorter, more abrupt deceleration.',
    drillsDown: ['sidelying-toss', 'reverse-throw'],
  },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.key, m]));

/**
 * Kinetic-chain dependency graph: a change in the key often causes changes in the listed metrics.
 * Used to label root causes vs downstream symptoms.
 */
export const CAUSES: Record<string, { to: string[]; why: string }> = {
  stride: { to: ['extension', 'trunkTiltBR', 'headAtBR', 'releaseHeight', 'tPkhFs', 'hipSink', 'backKneeFS'], why: 'a shorter stride gives the trunk less room to bend forward and release farther out' },
  comSpeed: { to: ['handSpeed', 'tPkhFs', 'extension'], why: 'less momentum down the mound shortens the stride and leaves less energy for the arm' },
  tPkhFs: { to: ['forearmFS', 'tFsBr', 'elbowHeightFS'], why: 'a change in tempo to the plate changes how much time the arm has to get up' },
  balancePKH: { to: ['forearmFS', 'tFsBr', 'trunkTiltFS'], why: 'drifting forward early (rushing) means the foot lands before the arm is up' },
  handBreakTiming: { to: ['forearmFS', 'elbowHeightFS', 'tFsBr'], why: 'breaking the hands later leaves the arm behind at foot strike' },
  forearmFS: { to: ['tFsBr', 'tFsMer', 'elbowFlexFS', 'layback', 'handSpeed'], why: 'when the arm is late at foot strike it has to rush to catch up' },
  elbowHeightFS: { to: ['armSlot', 'releaseHeight'], why: 'elbow height at landing sets up where the arm comes through' },
  kneeBlock: { to: ['leadKneeBR', 'trunkTiltBR', 'extension', 'headAtBR', 'handSpeed', 'kneeExtVel', 'releaseHeight'], why: 'a soft front leg lets the body sink instead of rotating and bending over it' },
  leadKneeBR: { to: ['trunkTiltBR', 'extension', 'headAtBR', 'releaseHeight'], why: 'a collapsing front knee lowers the body and stops the chest getting over the front leg' },
  strideDir: { to: ['latTiltBR', 'gloveDistBR', 'sepFS'], why: 'landing off-line changes how the hips and trunk can rotate' },
  gloveDistBR: { to: ['latTiltBR', 'headLatBR', 'releaseSide'], why: 'a glove that flies open pulls the front side open early' },
  trunkTiltBR: { to: ['extension', 'releaseHeight', 'headAtBR'], why: 'staying upright keeps the release point back and high' },
  sepFS: { to: ['handSpeed'], why: 'less separation means less stretch to drive trunk rotation' },
  latTiltBR: { to: ['armSlot', 'releaseHeight', 'releaseSide'], why: 'side bend moves the arm slot and release point' },
};
