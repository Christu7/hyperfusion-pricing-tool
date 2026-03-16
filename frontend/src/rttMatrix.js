export const providerRegionToLatencyZone = {
  MENA: "gcc",
  Europe: "europe",
  "North America": "north_america",
  "Asia-Pacific": "apac",
};

const FALLBACK_RTT_MS = 120;

export const RTT_MATRIX = {
  india: {
    gcc: 35,
    europe: 120,
    north_america: 180,
    apac: 95,
  },
  gcc: {
    gcc: 10,
    europe: 95,
    north_america: 170,
    apac: 120,
  },
  mena: {
    gcc: 25,
    europe: 110,
    north_america: 180,
    apac: 135,
  },
  africa: {
    gcc: 80,
    europe: 110,
    north_america: 190,
    apac: 180,
  },
  europe: {
    gcc: 95,
    europe: 15,
    north_america: 90,
    apac: 170,
  },
  north_america: {
    gcc: 170,
    europe: 90,
    north_america: 15,
    apac: 210,
  },
  apac: {
    gcc: 120,
    europe: 170,
    north_america: 210,
    apac: 20,
  },
  global: {
    gcc: 120,
    europe: 120,
    north_america: 120,
    apac: 120,
  },
};

export function getEstimatedRttMs(selectedLatencyZone, providerRegion) {
  const zoneRow = RTT_MATRIX?.[selectedLatencyZone];
  if (!zoneRow) return FALLBACK_RTT_MS;

  const providerLatencyZone = providerRegionToLatencyZone?.[providerRegion];
  if (!providerLatencyZone) return FALLBACK_RTT_MS;

  return zoneRow?.[providerLatencyZone] ?? FALLBACK_RTT_MS;
}

export function getLatencyDeltaVsHyperfusionMs(estimatedLatencyMs, hyperfusionLatencyMs) {
  const providerRtt = Number.isFinite(estimatedLatencyMs) ? estimatedLatencyMs : FALLBACK_RTT_MS;
  const hyperfusionRtt = Number.isFinite(hyperfusionLatencyMs) ? hyperfusionLatencyMs : FALLBACK_RTT_MS;
  return Math.max(0, providerRtt - hyperfusionRtt);
}
