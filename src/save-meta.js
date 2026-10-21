/** The menu's record of a town, read from a save's JSON without the sim. */
export function metaFromSave(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    name: data?.townName || 'Hearthvale',
    year: data?.time?.year ?? 0,
    month: data?.time?.month ?? 0,
    people: data?.indicators?.pop ?? data?.stats?.people ?? data?.people?.length ?? 0,
    era: data?.era ?? 0,
    seed: Number.isFinite(data?.seed) ? data.seed : null,
    // The valley: terrain version 1 is river-only; archetype null lets the seed decide.
    terrain: data?.terrainVersion ?? 1,
    archetype: data?.terrainArchetype ?? null,
  };
}
