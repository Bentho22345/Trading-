const SOURCES: [string, string][] = [
  ['Diffendaffer, Fleisig et al., The Clinician\'s Guide to Baseball Pitching Biomechanics (Sports Health, 2023)', 'https://journals.sagepub.com/doi/10.1177/19417381221078537'],
  ['Driveline Baseball, How We Interpret Biomechanics Reports', 'https://www.drivelinebaseball.com/2019/03/interpret-biomechanics-reports/'],
  ['Driveline, Youth pitching mechanics across age groups', 'https://drivelinebaseball.com/blogs/blog/youth-baseball-pitching-mechanics-analysis-across-age-groups'],
  ['Hip-shoulder separation and pitching kinematics in high school pitchers (PMC7727427)', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7727427'],
  ['Arm slot kinematics and kinetics, high school vs professional (PMC10601404)', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10601404/'],
  ['Kinematic sequences in curveballs vs fastballs (Frontiers, 2021)', 'https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2021.699251/full'],
  ['KinaTrax in-game markerless normative data, SEC pitchers (PMC11544755)', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11544755'],
  ['PITCHAI single-camera validation vs marker-based mocap (SportRxiv)', 'https://sportrxiv.org/index.php/server/preprint/view/101'],
  ['PitcherNet (arXiv 2405.07407)', 'https://arxiv.org/html/2405.07407v1'],
  ['Baseball throwing mechanics as they relate to pathology and performance (JSSM)', 'https://www.jssm.org/jssm-06-1.xml-Fulltext'],
  ['Kinovea features (video-analysis UX reference)', 'https://kinovea.org/features.html'],
  ['MLB Pitch Smart guidelines', 'https://www.mlb.com/pitch-smart/pitching-guidelines'],
  ['Statcast extension (MLB glossary)', 'https://www.mlb.com/glossary/statcast/extension'],
];

export function AboutScreen() {
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <h1>About Mound Lab</h1>
      <div className="notice warn"><b>Mound Lab gives 2D video estimates for training and education. It is not a medical device and does not diagnose injuries.</b> If a pitcher has pain, stop throwing and see a qualified professional.</div>
      <div className="card stack">
        <h2>How it works</h2>
        <p>The pose model (Google MediaPipe Pose Landmarker, Apache-2.0) finds 33 body points in every frame, on your device. Mound Lab cleans the track (left/right swap correction, gap filling, zero-lag Butterworth filtering), works out the throwing arm and lead leg from the motion itself, finds the delivery events, and measures each metric in body-height units so clips filmed from slightly different distances compare fairly.</p>
        <p><b>Honest accuracy.</b> One camera sees motion in its own plane well and motion toward or away from it poorly. Published single-phone validation (PITCHAI vs marker-based motion capture) found errors of about 6° for pelvis/trunk, 9° for the knee, 12° for the throwing arm and 14° for the glove arm — so trunk and leg numbers are more trustworthy than arm numbers. Every metric carries a confidence badge, and metrics your camera view can't measure are not shown as numbers.</p>
        <p><b>Compare yourself to yourself.</b> Values from different measurement systems shouldn't be compared directly (lab, stadium and phone systems disagree). Reference ranges are shown as rough guides with sources, never as pass/fail.</p>
        <p><b>Privacy.</b> Video is processed in this browser and stored in this browser. Nothing is uploaded. The optional AI coach sends only numbers, your notes and small stills — and only when you ask, using your own key.</p>
      </div>
      <div className="card">
        <h2>Research sources</h2>
        <ul className="small">{SOURCES.map(([t, u]) => <li key={u}><a href={u} target="_blank" rel="noreferrer">{t}</a></li>)}</ul>
        <p className="small muted">Drill descriptions are original to Mound Lab. Fonts: Barlow Condensed, IBM Plex Sans/Mono (SIL OFL). Libraries: React, Zustand, Dexie, mp4box.js, MediaPipe Tasks Vision.</p>
      </div>
    </div>
  );
}
