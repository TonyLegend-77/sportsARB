/**
 * Given a CanonicalBet.key, returns the key of its true binary complement —
 * the side that wins iff this one loses. Returns null for keys with no
 * binary complement in this scheme.
 *
 * Kept in sync manually with dashboard/src/lib/arbitrage.ts's copy of the
 * same logic (that one runs in the browser bundle, this one runs in the
 * bot process — different runtimes, same rules, deliberately not shared
 * via import).
 */
export function complementKeyOf(key: string): string | null {
  switch (key) {
    case '1x2:home':
      return '1x2:not_home';
    case '1x2:not_home':
      return '1x2:home';
    case '1x2:draw':
      return '1x2:not_draw';
    case '1x2:not_draw':
      return '1x2:draw';
    case '1x2:away':
      return '1x2:not_away';
    case '1x2:not_away':
      return '1x2:away';
    case '12:home':
      return '12:away';
    case '12:away':
      return '12:home';
    default:
      break;
  }

  const totalM = key.match(/^total:(over|under):(.+)$/);
  if (totalM) {
    const other = totalM[1] === 'over' ? 'under' : 'over';
    return `total:${other}:${totalM[2]}`;
  }

  const spreadM = key.match(/^spread:(home|away):([+-]?\d+(?:\.\d+)?)$/);
  if (spreadM) {
    const side = spreadM[1] as 'home' | 'away';
    const line = parseFloat(spreadM[2]);
    const otherSide = side === 'home' ? 'away' : 'home';
    const complement = -line === 0 ? 0 : -line;
    const norm = complement > 0 ? `+${complement}` : `${complement}`;
    return `spread:${otherSide}:${norm}`;
  }

  return null;
}
