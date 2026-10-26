// The small models the game downloads ("students"), by family. Each family has its
// own manifest ({latest, versions: {n: file}}) and immutable, versioned bundles under
// /students/ (also reachable as /api/students/). The worker and the client both read
// this table, so a new family is one entry here.
//
//   coordinated  the learning coordinator (cloudflare/learning.js) owns the manifest and
//                may publish new versions from R2; otherwise both come from static assets.
export const STUDENT_FAMILIES = {
  // Paths kept from before families existed: /students/manifest.json, /students/decisions.vN.json.
  decisions: {dir: '', manifest: 'manifest.json', bundle: /^decisions\.v(\d+)\.json$/, coordinated: true},
  narration: {dir: 'narration/', manifest: 'manifest.json', bundle: /^narration\.v(\d+)\.json$/, coordinated: false},
  notes: {dir: 'notes/', manifest: 'manifest.json', bundle: /^notes\.v(\d+)\.json$/, coordinated: false},
};

// '/students/narration/manifest' -> {family: 'narration', manifest: true, file: 'narration/manifest.json'}
// '/students/decisions.v7.json'  -> {family: 'decisions', version: 7, file: 'decisions.v7.json'}
export function studentPath(pathname) {
  const rest = String(pathname).replace(/^\/(api\/)?students\//, '');
  if (rest === pathname) return null;
  if (rest === 'decisions/manifest' || rest === 'decisions/manifest.json') return {family: 'decisions', manifest: true, file: 'manifest.json'};
  for (const [family, f] of Object.entries(STUDENT_FAMILIES)) {
    if (f.dir && !rest.startsWith(f.dir)) continue;
    if (!f.dir && rest.includes('/')) continue;
    const name = rest.slice(f.dir.length);
    if (name === 'manifest' || name === f.manifest) return {family, manifest: true, file: f.dir + f.manifest};
    const m = f.bundle.exec(name);
    if (m) return {family, version: Number(m[1]), file: f.dir + name};
  }
  return null;
}
